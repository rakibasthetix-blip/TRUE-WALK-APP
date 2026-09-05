require('dotenv').config();

const express = require('express');
const path = require('path');
const crypto = require('crypto');
const Database = require('better-sqlite3');
const session = require('express-session');
const Razorpay = require('razorpay');

const app = express();
const PORT = process.env.PORT || 3000;

// ======================================================
// BASIC MIDDLEWARE
// ======================================================

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Session MUST come before static files
app.use(
  session({
    secret:
      process.env.SESSION_SECRET ||
      'change-this-secret-before-production',
    resave: false,
    saveUninitialized: false,
    cookie: {
      httpOnly: true,
      sameSite: 'lax',
      secure: false,
      maxAge: 86400000
    }
  })
);

// ======================================================
// DATABASE
// ======================================================

const db = new Database('truewalk.db');

// ======================================================
// TABLES
// ======================================================

db.prepare(`
  CREATE TABLE IF NOT EXISTS users(
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    phone TEXT NOT NULL UNIQUE,
    salt TEXT NOT NULL,
    password_hash TEXT NOT NULL,
    referral_code TEXT UNIQUE,
    referred_by TEXT,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  )
`).run();

try {
  db.prepare('ALTER TABLE users ADD COLUMN referral_code TEXT').run();
} catch (e) {}

try {
  db.prepare('ALTER TABLE users ADD COLUMN referred_by TEXT').run();
} catch (e) {}

db.prepare(`
  CREATE TABLE IF NOT EXISTS payments(
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    plan TEXT,
    amount INTEGER NOT NULL,
    currency TEXT NOT NULL DEFAULT 'INR',
    razorpay_order_id TEXT UNIQUE,
    razorpay_payment_id TEXT UNIQUE,
    status TEXT NOT NULL DEFAULT 'created',
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    paid_at TEXT,
    FOREIGN KEY(user_id) REFERENCES users(id)
  )
`).run();

db.prepare(`
  CREATE TABLE IF NOT EXISTS withdrawals(
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    amount INTEGER NOT NULL,
    currency TEXT NOT NULL DEFAULT 'INR',
    method TEXT NOT NULL,
    upi_id TEXT,
    account_name TEXT,
    account_last4 TEXT,
    ifsc TEXT,
    status TEXT NOT NULL DEFAULT 'pending',
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    processed_at TEXT,
    FOREIGN KEY(user_id) REFERENCES users(id)
  )
`).run();

db.prepare(`
  CREATE TABLE IF NOT EXISTS wallets(
    user_id INTEGER PRIMARY KEY,
    balance INTEGER NOT NULL DEFAULT 0,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY(user_id) REFERENCES users(id)
  )
`).run();

db.prepare(`
  CREATE TABLE IF NOT EXISTS wallet_transactions(
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    type TEXT NOT NULL,
    amount INTEGER NOT NULL,
    balance_after INTEGER NOT NULL,
    reference_type TEXT,
    reference_id TEXT,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(reference_type,reference_id,type),
    FOREIGN KEY(user_id) REFERENCES users(id)
  )
`).run();

// ======================================================
// RAZORPAY
// ======================================================

let razorpay = null;

if (
  process.env.RAZORPAY_KEY_ID &&
  process.env.RAZORPAY_KEY_SECRET
) {
  razorpay = new Razorpay({
    key_id: process.env.RAZORPAY_KEY_ID,
    key_secret: process.env.RAZORPAY_KEY_SECRET
  });
}

// ======================================================
// HELPERS
// ======================================================

const hash = (password, salt) =>
  crypto.scryptSync(String(password), salt, 64).toString('hex');

const ref = () =>
  'TW' +
  crypto.randomBytes(5).toString('hex').toUpperCase();

const wallet = (id) =>
  db
    .prepare(
      'INSERT OR IGNORE INTO wallets(user_id,balance) VALUES(?,0)'
    )
    .run(id);

const login = (req, res, next) => {
  if (req.session.userId) {
    return next();
  }

  return res.status(401).json({
    message: 'Please login first.'
  });
};

const admin = (req, res, next) => {
  if (req.session.isAdmin) {
    return next();
  }

  return res.status(401).json({
    message: 'Admin login required.'
  });
};

// ======================================================
// PROTECTED HOME PAGE
// ======================================================

app.get('/home.html', (req, res) => {
  if (!req.session.userId) {
    return res.redirect('/login.html');
  }

  res.sendFile(path.join(__dirname, 'home.html'));
});

// ======================================================
// ADMIN AUTH
// ======================================================

app.post('/api/admin/login', (req, res) => {
  const { username, password } = req.body;

  if (
    !process.env.ADMIN_USERNAME ||
    !process.env.ADMIN_PASSWORD
  ) {
    return res.status(503).json({
      message:
        'Admin credentials are not configured in .env.'
    });
  }

  if (
    String(username || '') !==
      String(process.env.ADMIN_USERNAME) ||
    String(password || '') !==
      String(process.env.ADMIN_PASSWORD)
  ) {
    return res.status(401).json({
      message: 'Invalid admin username or password.'
    });
  }

  req.session.regenerate((err) => {
    if (err) {
      return res.status(500).json({
        message: 'Admin login failed.'
      });
    }

    req.session.isAdmin = true;

    res.json({
      success: true,
      message: 'Admin login successful.'
    });
  });
});

app.post('/api/admin/logout', admin, (req, res) => {
  req.session.destroy(() => {
    res.clearCookie('connect.sid');

    res.json({
      success: true
    });
  });
});

app.get('/api/admin/me', admin, (req, res) => {
  res.json({
    success: true,
    admin: true
  });
});

// ======================================================
// USER REGISTER
// ======================================================

app.post('/api/register', (req, res) => {
  try {
    const {
      name,
      phone,
      password,
      referralCode
    } = req.body;

    if (!name || !phone || !password) {
      return res.status(400).json({
        message:
          'Name, mobile number and password are required.'
      });
    }

    const ph = String(phone).trim();

    if (!/^\d{10}$/.test(ph)) {
      return res.status(400).json({
        message:
          'Please enter a valid 10-digit mobile number.'
      });
    }

    if (String(password).length < 6) {
      return res.status(400).json({
        message:
          'Password must be at least 6 characters.'
      });
    }

    if (
      db
        .prepare('SELECT id FROM users WHERE phone=?')
        .get(ph)
    ) {
      return res.status(409).json({
        message:
          'This mobile number is already registered.'
      });
    }

    let referredBy = null;

    if (referralCode) {
      const c = String(referralCode)
        .trim()
        .toUpperCase();

      if (
        !db
          .prepare(
            'SELECT id FROM users WHERE referral_code=?'
          )
          .get(c)
      ) {
        return res.status(400).json({
          message: 'Invalid referral code.'
        });
      }

      referredBy = c;
    }

    let rc;

    do {
      rc = ref();
    } while (
      db
        .prepare(
          'SELECT id FROM users WHERE referral_code=?'
        )
        .get(rc)
    );

    const salt = crypto.randomBytes(16).toString('hex');
    const phash = hash(password, salt);

    const id = db.transaction(() => {
      const r = db
        .prepare(
          `
          INSERT INTO users(
            name,
            phone,
            salt,
            password_hash,
            referral_code,
            referred_by
          )
          VALUES(?,?,?,?,?,?)
          `
        )
        .run(
          String(name).trim(),
          ph,
          salt,
          phash,
          rc,
          referredBy
        );

      wallet(r.lastInsertRowid);

      return r.lastInsertRowid;
    })();

    res.status(201).json({
      message: 'Registration successful.',
      userId: id,
      referralCode: rc
    });
  } catch (e) {
    console.error(e);

    res.status(500).json({
      message: 'Registration failed.'
    });
  }
});

// ======================================================
// USER LOGIN
// ======================================================

app.post('/api/login', (req, res) => {
  try {
    const { phone, password } = req.body;

    const u = db
      .prepare('SELECT * FROM users WHERE phone=?')
      .get(String(phone || '').trim());

    if (
      !u ||
      hash(password, u.salt) !== u.password_hash
    ) {
      return res.status(401).json({
        message:
          'Invalid mobile number or password.'
      });
    }

    wallet(u.id);

    req.session.userId = u.id;
    req.session.isAdmin = false;

    res.json({
      message: 'Login successful.',
      user: {
        id: u.id,
        name: u.name,
        phone: u.phone
      }
    });
  } catch (e) {
    console.error(e);

    res.status(500).json({
      message: 'Login failed.'
    });
  }
});

// ======================================================
// CURRENT USER
// ======================================================

app.get('/api/me', login, (req, res) => {
  const u = db
    .prepare(
      `
      SELECT
        id,
        name,
        phone,
        referral_code
      FROM users
      WHERE id=?
      `
    )
    .get(req.session.userId);

  if (!u) {
    return res.status(401).json({
      message: 'Session is invalid.'
    });
  }

  wallet(u.id);

  const w = db
    .prepare(
      'SELECT balance FROM wallets WHERE user_id=?'
    )
    .get(u.id);

  res.json({
    user: u,
    balance: Number(w.balance) / 100
  });
});

// ======================================================
// USER WALLET
// ======================================================

app.get('/api/wallet', login, (req, res) => {
  wallet(req.session.userId);

  const w = db
    .prepare(
      `
      SELECT balance,updated_at
      FROM wallets
      WHERE user_id=?
      `
    )
    .get(req.session.userId);

  const t = db
    .prepare(
      `
      SELECT *
      FROM wallet_transactions
      WHERE user_id=?
      ORDER BY id DESC
      LIMIT 50
      `
    )
    .all(req.session.userId);

  res.json({
    success: true,
    balance: w.balance / 100,
    updatedAt: w.updated_at,
    transactions: t.map((x) => ({
      ...x,
      amount: x.amount / 100,
      balanceAfter: x.balance_after / 100
    }))
  });
});

// ======================================================
// REFERRAL
// ======================================================

app.get('/api/referral', login, (req, res) => {
  const u = db
    .prepare('SELECT * FROM users WHERE id=?')
    .get(req.session.userId);

  const n = db
    .prepare(
      `
      SELECT COUNT(*) total
      FROM users
      WHERE referred_by=?
      `
    )
    .get(u.referral_code).total;

  res.json({
    referralCode: u.referral_code,
    totalReferrals: n,
    activeReferrals: n
  });
});

app.get('/api/referrals', login, (req, res) => {
  const u = db
    .prepare(
      'SELECT referral_code FROM users WHERE id=?'
    )
    .get(req.session.userId);

  res.json({
    referrals: db
      .prepare(
        `
        SELECT
          id,
          name,
          phone,
          referral_code,
          created_at
        FROM users
        WHERE referred_by=?
        ORDER BY id DESC
        `
      )
      .all(u.referral_code)
  });
});

// ======================================================
// RAZORPAY CREATE ORDER
// ======================================================

app.post(
  '/api/payment/create-order',
  login,
  async (req, res) => {
    try {
      if (!razorpay) {
        return res.status(503).json({
          message:
            'Razorpay is not configured.'
        });
      }

      const a = Number(req.body.amount);

      if (!Number.isFinite(a) || a <= 0) {
        return res.status(400).json({
          message:
            'Invalid payment amount.'
        });
      }

      const o =
        await razorpay.orders.create({
          amount: Math.round(a * 100),
          currency: 'INR',
          receipt:
            'TW_' +
            Date.now() +
            '_' +
            req.session.userId,
          notes: {
            user_id: String(req.session.userId),
            plan: req.body.plan || ''
          }
        });

      db.prepare(
        `
        INSERT INTO payments(
          user_id,
          plan,
          amount,
          currency,
          razorpay_order_id,
          status
        )
        VALUES(?,?,?,'INR',?,'created')
        `
      ).run(
        req.session.userId,
        req.body.plan || null,
        o.amount,
        o.id
      );

      res.json({
        success: true,
        key: process.env.RAZORPAY_KEY_ID,
        orderId: o.id,
        amount: o.amount,
        currency: o.currency
      });
    } catch (e) {
      console.error(e);

      res.status(500).json({
        message:
          'Unable to create payment order.'
      });
    }
  }
);

// ======================================================
// RAZORPAY VERIFY
// ======================================================

app.post(
  '/api/payment/verify',
  login,
  async (req, res) => {
    try {
      if (!razorpay) {
        return res.status(503).json({
          message:
            'Razorpay is not configured.'
        });
      }

      const {
        razorpay_order_id: oid,
        razorpay_payment_id: pid,
        razorpay_signature: sig
      } = req.body;

      const p = db
        .prepare(
          `
          SELECT *
          FROM payments
          WHERE razorpay_order_id=?
          AND user_id=?
          `
        )
        .get(
          oid,
          req.session.userId
        );

      if (!p) {
        return res.status(404).json({
          message:
            'Payment order not found.'
        });
      }

      const g = crypto
        .createHmac(
          'sha256',
          process.env.RAZORPAY_KEY_SECRET
        )
        .update(
          oid + '|' + pid
        )
        .digest('hex');

      const a = Buffer.from(g);
      const b = Buffer.from(sig || '');

      if (
        a.length !== b.length ||
        !crypto.timingSafeEqual(a, b)
      ) {
        return res.status(400).json({
          message:
            'Payment signature verification failed.'
        });
      }

      const rp =
        await razorpay.payments.fetch(pid);

      if (
        rp.order_id !== oid ||
        Number(rp.amount) !== Number(p.amount) ||
        rp.status !== 'captured'
      ) {
        return res.status(400).json({
          message:
            'Payment verification failed.'
        });
      }

      const bal = db.transaction(() => {
        wallet(p.user_id);

        const w = db
          .prepare(
            'SELECT balance FROM wallets WHERE user_id=?'
          )
          .get(p.user_id);

        let nb = Number(w.balance);

        const already = db
          .prepare(
            `
            SELECT id
            FROM wallet_transactions
            WHERE type='deposit'
            AND reference_type='payment'
            AND reference_id=?
            `
          )
          .get(String(p.id));

        if (!already) {
          nb += Number(p.amount);

          db.prepare(
            `
            UPDATE wallets
            SET
              balance=?,
              updated_at=CURRENT_TIMESTAMP
            WHERE user_id=?
            `
          ).run(
            nb,
            p.user_id
          );

          db.prepare(
            `
            INSERT INTO wallet_transactions(
              user_id,
              type,
              amount,
              balance_after,
              reference_type,
              reference_id
            )
            VALUES(
              ?,
              'deposit',
              ?,
              ?,
              'payment',
              ?
            )
            `
          ).run(
            p.user_id,
            p.amount,
            nb,
            String(p.id)
          );
        }

        db.prepare(
          `
          UPDATE payments
          SET
            razorpay_payment_id=?,
            status='captured',
            paid_at=CURRENT_TIMESTAMP
          WHERE id=?
          `
        ).run(
          pid,
          p.id
        );

        return nb;
      })();

      res.json({
        success: true,
        message:
          'Payment verified and wallet updated.',
        balance: bal / 100
      });
    } catch (e) {
      console.error(e);

      res.status(500).json({
        message:
          'Payment verification failed.'
      });
    }
  }
);

// ======================================================
// ORDERS
// ======================================================

app.get('/api/orders', login, (req, res) => {
  const rows = db
    .prepare(
      `
      SELECT *
      FROM payments
      WHERE user_id=?
      ORDER BY id DESC
      `
    )
    .all(req.session.userId);

  res.json({
    orders: rows.map((x) => ({
      ...x,
      amount: x.amount / 100
    }))
  });
});

// ======================================================
// WITHDRAW
// ======================================================

app.post('/api/withdrawals', login, (req, res) => {
  try {
    const uid = req.session.userId;
    const amount = Number(req.body.amount);
    const method = String(
      req.body.method || ''
    ).toUpperCase();

    if (!Number.isFinite(amount) || amount <= 0) {
      return res.status(400).json({
        success: false,
        message:
          'Please enter a valid withdrawal amount.'
      });
    }

    const pa = Math.round(amount * 100);

    if (!['UPI', 'BANK'].includes(method)) {
      return res.status(400).json({
        success: false,
        message:
          'Please select a valid withdrawal method.'
      });
    }

    let upi = null;
    let name = null;
    let last4 = null;
    let ifsc = null;

    if (method === 'UPI') {
      upi = String(
        req.body.upiId || ''
      ).trim();

      if (
        !/^[a-zA-Z0-9._-]{2,}@[a-zA-Z0-9.-]{2,}$/.test(
          upi
        )
      ) {
        return res.status(400).json({
          success: false,
          message:
            'Please enter a valid UPI ID.'
        });
      }
    } else {
      name = String(
        req.body.accountName || ''
      ).trim();

      const ac = String(
        req.body.accountNumber || ''
      ).trim();

      const cf = String(
        req.body.confirmAccountNumber || ''
      ).trim();

      if (
        name.length < 2 ||
        !/^[0-9]{9,18}$/.test(ac) ||
        ac !== cf
      ) {
        return res.status(400).json({
          success: false,
          message:
            'Please check bank details.'
        });
      }

      ifsc = String(
        req.body.ifsc || ''
      )
        .trim()
        .toUpperCase();

      if (
        !/^[A-Z]{4}0[A-Z0-9]{6}$/.test(ifsc)
      ) {
        return res.status(400).json({
          success: false,
          message:
            'Please enter a valid IFSC code.'
        });
      }

      last4 = ac.slice(-4);
    }

    const r = db.transaction(() => {
      wallet(uid);

      const w = db
        .prepare(
          'SELECT balance FROM wallets WHERE user_id=?'
        )
        .get(uid);

      if (pa > w.balance) {
        return {
          error: 'INSUFFICIENT',
          balance: w.balance
        };
      }

      let x;

      if (method === 'UPI') {
        x = db
          .prepare(
            `
            INSERT INTO withdrawals(
              user_id,
              amount,
              method,
              upi_id,
              status
            )
            VALUES(
              ?,
              ?,
              'UPI',
              ?,
              'pending'
            )
            `
          )
          .run(
            uid,
            pa,
            upi
          );
      } else {
        x = db
          .prepare(
            `
            INSERT INTO withdrawals(
              user_id,
              amount,
              method,
              account_name,
              account_last4,
              ifsc,
              status
            )
            VALUES(
              ?,
              ?,
              'BANK',
              ?,
              ?,
              ?,
              'pending'
            )
            `
          )
          .run(
            uid,
            pa,
            name,
            last4,
            ifsc
          );
      }

      const nb =
        w.balance - pa;

      db.prepare(
        `
        UPDATE wallets
        SET
          balance=?,
          updated_at=CURRENT_TIMESTAMP
        WHERE user_id=?
        `
      ).run(
        nb,
        uid
      );

      db.prepare(
        `
        INSERT INTO wallet_transactions(
          user_id,
          type,
          amount,
          balance_after,
          reference_type,
          reference_id
        )
        VALUES(
          ?,
          'withdrawal',
          ?,
          ?,
          'withdrawal',
          ?
        )
        `
      ).run(
        uid,
        -pa,
        nb,
        String(x.lastInsertRowid)
      );

      return {
        id: x.lastInsertRowid,
        balance: nb
      };
    })();

    if (r.error) {
      return res.status(400).json({
        success: false,
        message:
          'Insufficient wallet balance.',
        balance:
          r.balance / 100
      });
    }

    res.status(201).json({
      success: true,
      message:
        'Withdrawal request submitted and amount reserved.',
      withdrawalId: r.id,
      status: 'pending',
      balance: r.balance / 100
    });
  } catch (e) {
    console.error(e);

    res.status(500).json({
      success: false,
      message:
        'Unable to submit withdrawal request.'
    });
  }
});

// ======================================================
// USER WITHDRAWAL HISTORY
// ======================================================

app.get('/api/withdrawals', login, (req, res) => {
  const rows = db
    .prepare(
      `
      SELECT *
      FROM withdrawals
      WHERE user_id=?
      ORDER BY id DESC
      `
    )
    .all(req.session.userId);

  res.json({
    success: true,
    withdrawals: rows.map((x) => ({
      id: x.id,
      amount: x.amount / 100,
      currency: x.currency,
      method: x.method,
      destination:
        x.method === 'UPI'
          ? x.upi_id
          : x.account_last4
          ? '****' + x.account_last4
          : null,
      accountName:
        x.account_name || null,
      ifsc: x.ifsc || null,
      status: x.status,
      createdAt: x.created_at,
      processedAt:
        x.processed_at || null
    }))
  });
});

// ======================================================
// ADMIN USERS
// ======================================================

app.get('/api/admin/users', admin, (req, res) => {
  const rows = db
    .prepare(
      `
      SELECT
        u.id,
        u.name,
        u.phone,
        u.referral_code,
        u.referred_by,
        u.created_at,
        COALESCE(w.balance,0) balance
      FROM users u
      LEFT JOIN wallets w
        ON w.user_id=u.id
      ORDER BY u.id DESC
      `
    )
    .all();

  res.json({
    success: true,
    users: rows.map((x) => ({
      ...x,
      balance: x.balance / 100
    }))
  });
});

// ======================================================
// ADMIN BALANCE ADJUSTMENT
// Supports:
// credit = add balance
// debit  = remove balance
// ======================================================

app.post(
  '/api/admin/users/:id/balance',
  admin,
  (req, res) => {
    try {
      const uid = Number(
        req.params.id
      );

      const amount = Number(
        req.body.amount
      );

      const type = String(
        req.body.type || 'credit'
      ).toLowerCase();

      const reason = String(
        req.body.reason ||
          'Admin adjustment'
      ).trim();

      if (
        !Number.isInteger(uid) ||
        uid < 1 ||
        !Number.isFinite(amount) ||
        amount <= 0
      ) {
        return res.status(400).json({
          success: false,
          message:
            'Invalid user or amount.'
        });
      }

      if (
        !['credit', 'debit'].includes(type)
      ) {
        return res.status(400).json({
          success: false,
          message:
            'Invalid balance adjustment type.'
        });
      }

      if (amount > 10000000) {
        return res.status(400).json({
          success: false,
          message:
            'Adjustment amount is too large.'
        });
      }

      const r = db.transaction(() => {
        const u = db
          .prepare(
            `
            SELECT id,name,phone
            FROM users
            WHERE id=?
            `
          )
          .get(uid);

        if (!u) {
          return {
            error: 'USER'
          };
        }

        wallet(uid);

        const w = db
          .prepare(
            `
            SELECT balance
            FROM wallets
            WHERE user_id=?
            `
          )
          .get(uid);

        const old =
          Number(w.balance);

        const baseAmount =
          Math.round(amount * 100);

        const adjustment =
          type === 'debit'
            ? -baseAmount
            : baseAmount;

        const nb =
          old + adjustment;

        if (nb < 0) {
          return {
            error: 'NEGATIVE',
            old
          };
        }

        db.prepare(
          `
          UPDATE wallets
          SET
            balance=?,
            updated_at=CURRENT_TIMESTAMP
          WHERE user_id=?
          `
        ).run(
          nb,
          uid
        );

        db.prepare(
          `
          INSERT INTO wallet_transactions(
            user_id,
            type,
            amount,
            balance_after,
            reference_type,
            reference_id
          )
          VALUES(
            ?,
            'admin_adjustment',
            ?,
            ?,
            'admin',
            ?
          )
          `
        ).run(
          uid,
          adjustment,
          nb,
          'admin_' +
            Date.now() +
            '_' +
            crypto
              .randomBytes(3)
              .toString('hex')
        );

        return {
          u,
          old,
          nb,
          reason,
          type
        };
      })();

      if (r.error === 'USER') {
        return res.status(404).json({
          success: false,
          message:
            'User not found.'
        });
      }

      if (r.error === 'NEGATIVE') {
        return res.status(400).json({
          success: false,
          message:
            'Balance cannot go below zero.',
          balance:
            r.old / 100
        });
      }

      res.json({
        success: true,
        message:
          'User wallet updated.',
        user: r.u,
        type: r.type,
        reason: r.reason,
        oldBalance:
          r.old / 100,
        newBalance:
          r.nb / 100
      });
    } catch (e) {
      console.error(e);

      res.status(500).json({
        success: false,
        message:
          'Unable to update user balance.'
      });
    }
  }
);

// ======================================================
// ADMIN WITHDRAWAL LIST
// ======================================================

app.get(
  '/api/admin/withdrawals',
  admin,
  (req, res) => {
    const rows = db
      .prepare(
        `
        SELECT
          w.*,
          u.name,
          u.phone
        FROM withdrawals w
        JOIN users u
          ON u.id=w.user_id
        ORDER BY
          CASE
            WHEN w.status='pending' THEN 0
            WHEN w.status='processing' THEN 1
            ELSE 2
          END,
          w.id DESC
        `
      )
      .all();

    res.json({
      success: true,
      withdrawals: rows.map((x) => ({
        id: x.id,
        userId: x.user_id,
        name: x.name,
        phone: x.phone,
        amount: x.amount / 100,
        currency: x.currency,
        method: x.method,
        destination:
          x.method === 'UPI'
            ? x.upi_id
            : x.account_last4
            ? '****' +
              x.account_last4
            : null,
        accountName:
          x.account_name || null,
        ifsc: x.ifsc || null,
        status: x.status,
        createdAt: x.created_at,
        processedAt:
          x.processed_at || null
      }))
    });
  }
);

// ======================================================
// ADMIN: MOVE WITHDRAWAL TO PROCESSING
// ======================================================

app.post(
  '/api/admin/withdrawals/:id/processing',
  admin,
  (req, res) => {
    try {
      const id = Number(
        req.params.id
      );

      if (!Number.isInteger(id) || id < 1) {
        return res.status(400).json({
          success: false,
          message:
            'Invalid withdrawal ID.'
        });
      }

      const result = db.transaction(() => {
        const w = db
          .prepare(
            `
            SELECT *
            FROM withdrawals
            WHERE id=?
            `
          )
          .get(id);

        if (!w) {
          return {
            error: 'NOT_FOUND'
          };
        }

        if (w.status !== 'pending') {
          return {
            error: 'DONE',
            status: w.status
          };
        }

        db.prepare(
          `
          UPDATE withdrawals
          SET status='processing'
          WHERE id=?
          `
        ).run(id);

        return {
          success: true
        };
      })();

      if (
        result.error ===
        'NOT_FOUND'
      ) {
        return res.status(404).json({
          success: false,
          message:
            'Withdrawal not found.'
        });
      }

      if (
        result.error ===
        'DONE'
      ) {
        return res.status(409).json({
          success: false,
          message:
            'Withdrawal is already ' +
            result.status +
            '.'
        });
      }

      res.json({
        success: true,
        message:
          'Withdrawal moved to Processing.',
        status: 'processing'
      });
    } catch (e) {
      console.error(e);

      res.status(500).json({
        success: false,
        message:
          'Unable to process withdrawal.'
      });
    }
  }
);

// ======================================================
// ADMIN: COMPLETE WITHDRAWAL
// IMPORTANT:
// This ONLY records completion.
// It does NOT send money.
// Use only after actual payout is sent.
// ======================================================

app.post(
  '/api/admin/withdrawals/:id/complete',
  admin,
  (req, res) => {
    try {
      const id = Number(
        req.params.id
      );

      const result = db.transaction(() => {
        const w = db
          .prepare(
            `
            SELECT *
            FROM withdrawals
            WHERE id=?
            `
          )
          .get(id);

        if (!w) {
          return {
            error: 'NOT_FOUND'
          };
        }

        if (
          !['pending', 'processing'].includes(
            w.status
          )
        ) {
          return {
            error: 'DONE',
            status: w.status
          };
        }

        db.prepare(
          `
          UPDATE withdrawals
          SET
            status='completed',
            processed_at=CURRENT_TIMESTAMP
          WHERE id=?
          `
        ).run(id);

        return {
          amount: w.amount
        };
      })();

      if (
        result.error ===
        'NOT_FOUND'
      ) {
        return res.status(404).json({
          success: false,
          message:
            'Withdrawal not found.'
        });
      }

      if (
        result.error ===
        'DONE'
      ) {
        return res.status(409).json({
          success: false,
          message:
            'Withdrawal is already ' +
            result.status +
            '.'
        });
      }

      res.json({
        success: true,
        message:
          'Withdrawal marked as completed.',
        note:
          'This records the payout only. It does not send money.',
        amount:
          result.amount / 100
      });
    } catch (e) {
      console.error(e);

      res.status(500).json({
        success: false,
        message:
          'Unable to complete withdrawal.'
      });
    }
  }
);

// ======================================================
// ADMIN: REJECT WITHDRAWAL
// Refunds the reserved wallet amount.
// ======================================================

app.post(
  '/api/admin/withdrawals/:id/reject',
  admin,
  (req, res) => {
    try {
      const id = Number(
        req.params.id
      );

      const result = db.transaction(() => {
        const w = db
          .prepare(
            `
            SELECT *
            FROM withdrawals
            WHERE id=?
            `
          )
          .get(id);

        if (!w) {
          return {
            error: 'NOT_FOUND'
          };
        }

        if (
          !['pending', 'processing'].includes(
            w.status
          )
        ) {
          return {
            error: 'DONE',
            status: w.status
          };
        }

        wallet(w.user_id);

        const bal = db
          .prepare(
            `
            SELECT balance
            FROM wallets
            WHERE user_id=?
            `
          )
          .get(w.user_id).balance;

        const nb =
          Number(bal) +
          Number(w.amount);

        db.prepare(
          `
          UPDATE wallets
          SET
            balance=?,
            updated_at=CURRENT_TIMESTAMP
          WHERE user_id=?
          `
        ).run(
          nb,
          w.user_id
        );

        db.prepare(
          `
          INSERT INTO wallet_transactions(
            user_id,
            type,
            amount,
            balance_after,
            reference_type,
            reference_id
          )
          VALUES(
            ?,
            'withdrawal_refund',
            ?,
            ?,
            'withdrawal',
            ?
          )
          `
        ).run(
          w.user_id,
          w.amount,
          nb,
          String(id)
        );

        db.prepare(
          `
          UPDATE withdrawals
          SET
            status='rejected',
            processed_at=CURRENT_TIMESTAMP
          WHERE id=?
          `
        ).run(id);

        return {
          amount: w.amount,
          balance: nb
        };
      })();

      if (
        result.error ===
        'NOT_FOUND'
      ) {
        return res.status(404).json({
          success: false,
          message:
            'Withdrawal not found.'
        });
      }

      if (
        result.error ===
        'DONE'
      ) {
        return res.status(409).json({
          success: false,
          message:
            'Withdrawal is already ' +
            result.status +
            '.'
        });
      }

      res.json({
        success: true,
        message:
          'Withdrawal rejected and balance refunded.',
        refundedAmount:
          result.amount / 100,
        newBalance:
          result.balance / 100
      });
    } catch (e) {
      console.error(e);

      res.status(500).json({
        success: false,
        message:
          'Unable to reject withdrawal.'
      });
    }
  }
);

// ======================================================
// OLD ADMIN ACTION ENDPOINT
// Kept for compatibility
// ======================================================

app.post(
  '/api/admin/withdrawals/:id/action',
  admin,
  (req, res) => {
    try {
      const id = Number(
        req.params.id
      );

      const action = String(
        req.body.action || ''
      ).toLowerCase();

      if (
        !['reject', 'paid'].includes(
          action
        )
      ) {
        return res.status(400).json({
          success: false,
          message:
            'Action must be reject or paid.'
        });
      }

      const r = db.transaction(() => {
        const w = db
          .prepare(
            `
            SELECT *
            FROM withdrawals
            WHERE id=?
            `
          )
          .get(id);

        if (!w) {
          return {
            error: 'NOT_FOUND'
          };
        }

        if (w.status !== 'pending') {
          return {
            error: 'DONE',
            status: w.status
          };
        }

        if (action === 'paid') {
          db.prepare(
            `
            UPDATE withdrawals
            SET
              status='completed',
              processed_at=CURRENT_TIMESTAMP
            WHERE id=?
            `
          ).run(id);

          return {
            amount: w.amount
          };
        }

        wallet(w.user_id);

        const bal = db
          .prepare(
            `
            SELECT balance
            FROM wallets
            WHERE user_id=?
            `
          )
          .get(w.user_id).balance;

        const nb =
          Number(bal) +
          Number(w.amount);

        db.prepare(
          `
          UPDATE wallets
          SET
            balance=?,
            updated_at=CURRENT_TIMESTAMP
          WHERE user_id=?
          `
        ).run(
          nb,
          w.user_id
        );

        db.prepare(
          `
          INSERT INTO wallet_transactions(
            user_id,
            type,
            amount,
            balance_after,
            reference_type,
            reference_id
          )
          VALUES(
            ?,
            'withdrawal_refund',
            ?,
            ?,
            'withdrawal',
            ?
          )
          `
        ).run(
          w.user_id,
          w.amount,
          nb,
          String(id)
        );

        db.prepare(
          `
          UPDATE withdrawals
          SET
            status='rejected',
            processed_at=CURRENT_TIMESTAMP
          WHERE id=?
          `
        ).run(id);

        return {
          amount: w.amount,
          balance: nb
        };
      })();

      if (
        r.error ===
        'NOT_FOUND'
      ) {
        return res.status(404).json({
          success: false,
          message:
            'Withdrawal not found.'
        });
      }

      if (
        r.error ===
        'DONE'
      ) {
        return res.status(409).json({
          success: false,
          message:
            'Withdrawal is already ' +
            r.status +
            '.'
        });
      }

      if (action === 'paid') {
        return res.json({
          success: true,
          message:
            'Withdrawal marked as completed.',
          note:
            'This endpoint does not send money. Mark paid only after the real payout has been sent.',
          amount:
            r.amount / 100
        });
      }

      res.json({
        success: true,
        message:
          'Withdrawal rejected and balance refunded.',
        refundedAmount:
          r.amount / 100,
        newBalance:
          r.balance / 100
      });
    } catch (e) {
      console.error(e);

      res.status(500).json({
        success: false,
        message:
          'Unable to process withdrawal.'
      });
    }
  }
);

// ======================================================
// ADMIN SUMMARY
// ======================================================

app.get(
  '/api/admin/summary',
  admin,
  (req, res) => {
    const users = db
      .prepare(
        'SELECT COUNT(*) total FROM users'
      )
      .get().total;

    const bal = db
      .prepare(
        `
        SELECT
          COALESCE(SUM(balance),0) total
        FROM wallets
        `
      )
      .get().total;

    const wd = db
      .prepare(
        `
        SELECT
          COALESCE(SUM(amount),0) total
        FROM withdrawals
        WHERE status='completed'
        `
      )
      .get().total;

    const pending = db
      .prepare(
        `
        SELECT COUNT(*) total
        FROM withdrawals
        WHERE status IN(
          'pending',
          'processing'
        )
        `
      )
      .get().total;

    const pay = db
      .prepare(
        `
        SELECT
          COALESCE(SUM(amount),0) total
        FROM payments
        WHERE status='captured'
        `
      )
      .get().total;

    res.json({
      success: true,
      totalUsers: Number(users),
      totalBalance: bal / 100,
      totalWithdrawals:
        wd / 100,
      pendingWithdrawals:
        Number(pending),
      totalPayments:
        pay / 100
    });
  }
);

// ======================================================
// USER LOGOUT
// ======================================================

app.post('/api/logout', (req, res) => {
  req.session.destroy(() => {
    res.clearCookie('connect.sid');

    res.json({
      message:
        'Logout successful.'
    });
  });
});

// ======================================================
// STATIC FILES
// IMPORTANT: AFTER SESSION + PROTECTED ROUTES
// ======================================================

app.use(express.static(__dirname));

// ======================================================
// ROOT
// ======================================================

app.get('/', (req, res) => {
  res.sendFile(
    path.join(__dirname, 'index.html')
  );
});

// ======================================================
// START SERVER
// ======================================================

if (require.main === module) {
  app.listen(PORT, () => {
    console.log(
      `TRUE WALK server running at http://localhost:${PORT}`
    );

    console.log(
      razorpay
        ? 'Razorpay configuration detected.'
        : 'Razorpay keys are not configured yet.'
    );
  });
}

module.exports = app;

  console.log(
    razorpay
      ? 'Razorpay configuration detected.'
      : 'Razorpay keys are not configured yet.'
  );
});
