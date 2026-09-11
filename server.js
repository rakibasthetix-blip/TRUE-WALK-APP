require('dotenv').config();

const express = require('express');
const path = require('path');
const crypto = require('crypto');
const mongoose = require('mongoose');
const session = require('express-session');
const MongoStore = require('connect-mongo').default || require('connect-mongo');
const Razorpay = require('razorpay');

const app = express();
const PORT = process.env.PORT || 3000;

app.set('trust proxy', 1);

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

const MONGO_URI = process.env.MONGODB_URI || process.env.MONGO_URI;

if (!MONGO_URI) {
  console.error('ERROR: MONGODB_URI (or MONGO_URI) is not configured.');
  process.exit(1);
}

/* ======================================================
   MONGOOSE SCHEMAS
   ====================================================== */

const userSchema = new mongoose.Schema(
  {
    name: { type: String, required: true, trim: true },
    phone: { type: String, required: true, unique: true, index: true },
    salt: { type: String, required: true },
    password_hash: { type: String, required: true },
    referral_code: { type: String, unique: true, sparse: true, index: true },
    referred_by: { type: String, default: null, index: true }
  },
  { timestamps: { createdAt: 'created_at', updatedAt: 'updated_at' } }
);

const walletSchema = new mongoose.Schema(
  {
    user_id: { type: mongoose.Schema.Types.ObjectId, ref: 'User', unique: true, index: true },
    balance: { type: Number, default: 0 }, // paise
    updated_at: { type: Date, default: Date.now }
  },
  { versionKey: false }
);

const walletTransactionSchema = new mongoose.Schema(
  {
    user_id: { type: mongoose.Schema.Types.ObjectId, ref: 'User', index: true },
    type: { type: String, required: true },
    amount: { type: Number, required: true }, // paise
    balance_after: { type: Number, required: true }, // paise
    reference_type: String,
    reference_id: String,
    created_at: { type: Date, default: Date.now }
  },
  { versionKey: false }
);

walletTransactionSchema.index(
  { reference_type: 1, reference_id: 1, type: 1 },
  { unique: true, sparse: true }
);

const paymentSchema = new mongoose.Schema(
  {
    user_id: { type: mongoose.Schema.Types.ObjectId, ref: 'User', index: true },
    plan: { type: String, default: null },
    amount: { type: Number, required: true }, // paise
    currency: { type: String, default: 'INR' },
    razorpay_order_id: { type: String, unique: true, sparse: true, index: true },
    razorpay_payment_id: { type: String, unique: true, sparse: true, index: true },
    status: { type: String, default: 'created' },
    created_at: { type: Date, default: Date.now },
    paid_at: Date
  },
  { versionKey: false }
);

const withdrawalSchema = new mongoose.Schema(
  {
    user_id: { type: mongoose.Schema.Types.ObjectId, ref: 'User', index: true },
    amount: { type: Number, required: true }, // paise
    currency: { type: String, default: 'INR' },
    method: { type: String, required: true },
    upi_id: String,
    account_name: String,
    account_last4: String,
    ifsc: String,
    status: { type: String, default: 'pending', index: true },
    created_at: { type: Date, default: Date.now },
    processed_at: Date
  },
  { versionKey: false }
);

const User = mongoose.model('User', userSchema);
const Wallet = mongoose.model('Wallet', walletSchema);
const WalletTransaction = mongoose.model('WalletTransaction', walletTransactionSchema);
const Payment = mongoose.model('Payment', paymentSchema);
const Withdrawal = mongoose.model('Withdrawal', withdrawalSchema);

/* ======================================================
   SESSION
   ====================================================== */

app.use(
  session({
    name: 'truewalk.sid',
    secret: process.env.SESSION_SECRET || 'CHANGE_THIS_SESSION_SECRET',
    resave: false,
    saveUninitialized: false,
    store: MongoStore.create({
      mongoUrl: MONGO_URI,
      collectionName: 'sessions',
      ttl: 14 * 24 * 60 * 60
    }),
    cookie: {
      httpOnly: true,
      sameSite: 'lax',
      secure: process.env.NODE_ENV === 'production',
      maxAge: 14 * 24 * 60 * 60 * 1000
    }
  })
);

/* ======================================================
   HELPERS
   ====================================================== */

const hash = (password, salt) =>
  crypto.scryptSync(String(password), salt, 64).toString('hex');

const makeRef = () =>
  'TW' + crypto.randomBytes(5).toString('hex').toUpperCase();

async function ensureWallet(userId) {
  return Wallet.findOneAndUpdate(
    { user_id: userId },
    { $setOnInsert: { user_id: userId, balance: 0 }, $set: { updated_at: new Date() } },
    { upsert: true, new: true }
  );
}

async function changeWallet(userId, delta, transactionInfo) {
  const wallet = await ensureWallet(userId);
  const newBalance = Number(wallet.balance) + Number(delta);

  if (newBalance < 0) {
    return { error: 'NEGATIVE', balance: wallet.balance };
  }

  await Wallet.updateOne(
    { user_id: userId },
    { $set: { balance: newBalance, updated_at: new Date() } }
  );

  if (transactionInfo) {
    await WalletTransaction.create({
      user_id: userId,
      type: transactionInfo.type,
      amount: delta,
      balance_after: newBalance,
      reference_type: transactionInfo.reference_type,
      reference_id: transactionInfo.reference_id
    });
  }

  return { balance: newBalance };
}

function login(req, res, next) {
  if (req.session.userId) return next();
  return res.status(401).json({ message: 'Please login first.' });
}

function admin(req, res, next) {
  if (req.session.isAdmin) return next();
  return res.status(401).json({ message: 'Admin login required.' });
}

function safeUser(u) {
  return {
    id: u._id,
    name: u.name,
    phone: u.phone
  };
}

/* ======================================================
   RAZORPAY
   ====================================================== */

let razorpay = null;

if (process.env.RAZORPAY_KEY_ID && process.env.RAZORPAY_KEY_SECRET) {
  razorpay = new Razorpay({
    key_id: process.env.RAZORPAY_KEY_ID,
    key_secret: process.env.RAZORPAY_KEY_SECRET
  });
}

/* ======================================================
   PROTECTED HOME
   ====================================================== */

app.get('/home.html', (req, res) => {
  if (!req.session.userId) return res.redirect('/login.html');
  res.sendFile(path.join(__dirname, 'home.html'));
});

/* ======================================================
   ADMIN AUTH
   ====================================================== */

app.post('/api/admin/login', (req, res) => {
  const { username, password } = req.body;

  if (!process.env.ADMIN_USERNAME || !process.env.ADMIN_PASSWORD) {
    return res.status(503).json({
      message: 'Admin credentials are not configured in Render Environment Variables.'
    });
  }

  if (
    String(username || '') !== String(process.env.ADMIN_USERNAME) ||
    String(password || '') !== String(process.env.ADMIN_PASSWORD)
  ) {
    return res.status(401).json({ message: 'Invalid admin username or password.' });
  }

  req.session.regenerate((err) => {
    if (err) return res.status(500).json({ message: 'Admin login failed.' });

    req.session.isAdmin = true;

    req.session.save((saveErr) => {
      if (saveErr) return res.status(500).json({ message: 'Admin session could not be saved.' });

      res.json({ success: true, message: 'Admin login successful.' });
    });
  });
});

app.post('/api/admin/logout', admin, (req, res) => {
  req.session.destroy(() => {
    res.clearCookie('truewalk.sid');
    res.json({ success: true });
  });
});

app.get('/api/admin/me', admin, (req, res) => {
  res.json({ success: true, admin: true });
});

/* ======================================================
   REGISTER
   ====================================================== */

app.post('/api/register', async (req, res) => {
  try {
    const { name, phone, password, referralCode } = req.body;

    if (!name || !phone || !password) {
      return res.status(400).json({
        message: 'Name, mobile number and password are required.'
      });
    }

    const ph = String(phone).trim();

    if (!/^\d{10}$/.test(ph)) {
      return res.status(400).json({
        message: 'Please enter a valid 10-digit mobile number.'
      });
    }

    if (String(password).length < 6) {
      return res.status(400).json({
        message: 'Password must be at least 6 characters.'
      });
    }

    const existing = await User.findOne({ phone: ph }).lean();

    if (existing) {
      return res.status(409).json({
        message: 'This mobile number is already registered.'
      });
    }

    let referredBy = null;

    if (referralCode) {
      const c = String(referralCode).trim().toUpperCase();
      const refUser = await User.findOne({ referral_code: c }).lean();

      if (!refUser) {
        return res.status(400).json({ message: 'Invalid referral code.' });
      }

      referredBy = c;
    }

    let rc;
    for (;;) {
      rc = makeRef();
      const exists = await User.exists({ referral_code: rc });
      if (!exists) break;
    }

    const salt = crypto.randomBytes(16).toString('hex');
    const passwordHash = hash(password, salt);

    const user = await User.create({
      name: String(name).trim(),
      phone: ph,
      salt,
      password_hash: passwordHash,
      referral_code: rc,
      referred_by: referredBy
    });

    await ensureWallet(user._id);

    return res.status(201).json({
      message: 'Registration successful.',
      userId: user._id,
      referralCode: rc
    });
  } catch (e) {
    console.error('REGISTER ERROR:', e);

    if (e && e.code === 11000) {
      return res.status(409).json({
        message: 'This mobile number or referral code is already registered.'
      });
    }

    return res.status(500).json({ message: 'Registration failed.' });
  }
});

/* ======================================================
   LOGIN
   ====================================================== */

app.post('/api/login', async (req, res) => {
  try {
    const { phone, password } = req.body;

    const u = await User.findOne({
      phone: String(phone || '').trim()
    });

    if (!u || hash(password, u.salt) !== u.password_hash) {
      return res.status(401).json({
        message: 'Invalid mobile number or password.'
      });
    }

    await ensureWallet(u._id);

    req.session.regenerate((err) => {
      if (err) {
        console.error('SESSION REGENERATE ERROR:', err);
        return res.status(500).json({ message: 'Login failed.' });
      }

      req.session.userId = String(u._id);
      req.session.isAdmin = false;

      req.session.save((saveErr) => {
        if (saveErr) {
          console.error('SESSION SAVE ERROR:', saveErr);
          return res.status(500).json({ message: 'Login session could not be saved.' });
        }

        return res.json({
          message: 'Login successful.',
          user: safeUser(u)
        });
      });
    });
  } catch (e) {
    console.error('LOGIN ERROR:', e);
    return res.status(500).json({ message: 'Login failed.' });
  }
});

/* ======================================================
   CURRENT USER
   ====================================================== */

app.get('/api/me', login, async (req, res) => {
  try {
    const u = await User.findById(req.session.userId).select(
      '_id name phone referral_code'
    );

    if (!u) {
      return res.status(401).json({ message: 'Session is invalid.' });
    }

    const w = await ensureWallet(u._id);

    return res.json({
      user: {
        id: u._id,
        name: u.name,
        phone: u.phone,
        referral_code: u.referral_code
      },
      balance: Number(w.balance) / 100
    });
  } catch (e) {
    console.error('ME ERROR:', e);
    return res.status(500).json({ message: 'Unable to load user.' });
  }
});

/* ======================================================
   WALLET
   ====================================================== */

app.get('/api/wallet', login, async (req, res) => {
  try {
    const w = await ensureWallet(req.session.userId);

    const t = await WalletTransaction.find({
      user_id: req.session.userId
    })
      .sort({ created_at: -1 })
      .limit(50)
      .lean();

    return res.json({
      success: true,
      balance: Number(w.balance) / 100,
      updatedAt: w.updated_at,
      transactions: t.map((x) => ({
        ...x,
        id: x._id,
        amount: Number(x.amount) / 100,
        balanceAfter: Number(x.balance_after) / 100
      }))
    });
  } catch (e) {
    console.error('WALLET ERROR:', e);
    return res.status(500).json({ message: 'Unable to load wallet.' });
  }
});

/* ======================================================
   REFERRAL
   ====================================================== */

app.get('/api/referral', login, async (req, res) => {
  try {
    const u = await User.findById(req.session.userId).select('referral_code');

    if (!u) return res.status(401).json({ message: 'User not found.' });

    const n = await User.countDocuments({ referred_by: u.referral_code });

    return res.json({
      referralCode: u.referral_code,
      totalReferrals: n,
      activeReferrals: n
    });
  } catch (e) {
    console.error('REFERRAL ERROR:', e);
    return res.status(500).json({ message: 'Unable to load referral data.' });
  }
});

app.get('/api/referrals', login, async (req, res) => {
  try {
    const u = await User.findById(req.session.userId).select('referral_code');

    if (!u) return res.status(401).json({ message: 'User not found.' });

    const rows = await User.find({ referred_by: u.referral_code })
      .select('_id name phone referral_code created_at')
      .sort({ created_at: -1 })
      .lean();

    return res.json({
      referrals: rows.map((x) => ({
        id: x._id,
        name: x.name,
        phone: x.phone,
        referral_code: x.referral_code,
        created_at: x.created_at
      }))
    });
  } catch (e) {
    console.error('REFERRALS ERROR:', e);
    return res.status(500).json({ message: 'Unable to load referrals.' });
  }
});

/* ======================================================
   RAZORPAY CREATE ORDER
   ====================================================== */

app.post('/api/payment/create-order', login, async (req, res) => {
  try {
    if (!razorpay) {
      return res.status(503).json({ message: 'Razorpay is not configured.' });
    }

    const a = Number(req.body.amount);

    if (!Number.isFinite(a) || a <= 0) {
      return res.status(400).json({ message: 'Invalid payment amount.' });
    }

    const o = await razorpay.orders.create({
      amount: Math.round(a * 100),
      currency: 'INR',
      receipt: 'TW_' + Date.now() + '_' + req.session.userId,
      notes: {
        user_id: String(req.session.userId),
        plan: req.body.plan || ''
      }
    });

    await Payment.create({
      user_id: req.session.userId,
      plan: req.body.plan || null,
      amount: o.amount,
      currency: o.currency,
      razorpay_order_id: o.id,
      status: 'created'
    });

    return res.json({
      success: true,
      key: process.env.RAZORPAY_KEY_ID,
      orderId: o.id,
      amount: o.amount,
      currency: o.currency
    });
  } catch (e) {
    console.error('CREATE ORDER ERROR:', e);
    return res.status(500).json({ message: 'Unable to create payment order.' });
  }
});

/* ======================================================
   RAZORPAY VERIFY
   ====================================================== */

app.post('/api/payment/verify', login, async (req, res) => {
  try {
    if (!razorpay) {
      return res.status(503).json({ message: 'Razorpay is not configured.' });
    }

    const {
      razorpay_order_id: oid,
      razorpay_payment_id: pid,
      razorpay_signature: sig
    } = req.body;

    const p = await Payment.findOne({
      razorpay_order_id: oid,
      user_id: req.session.userId
    });

    if (!p) {
      return res.status(404).json({ message: 'Payment order not found.' });
    }

    const g = crypto
      .createHmac('sha256', process.env.RAZORPAY_KEY_SECRET)
      .update(oid + '|' + pid)
      .digest('hex');

    const a = Buffer.from(g);
    const b = Buffer.from(sig || '');

    if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
      return res.status(400).json({
        message: 'Payment signature verification failed.'
      });
    }

    const rp = await razorpay.payments.fetch(pid);

    if (
      rp.order_id !== oid ||
      Number(rp.amount) !== Number(p.amount) ||
      rp.status !== 'captured'
    ) {
      return res.status(400).json({ message: 'Payment verification failed.' });
    }

    if (p.status !== 'captured') {
      const sessionDb = await mongoose.startSession();

      try {
        await sessionDb.withTransaction(async () => {
          const currentWallet = await Wallet.findOne({ user_id: p.user_id }).session(sessionDb);

          const w = currentWallet || new Wallet({
            user_id: p.user_id,
            balance: 0
          });

          const newBalance = Number(w.balance) + Number(p.amount);

          w.balance = newBalance;
          w.updated_at = new Date();
          await w.save({ session: sessionDb });

          const existingTx = await WalletTransaction.findOne({
            type: 'deposit',
            reference_type: 'payment',
            reference_id: String(p._id)
          }).session(sessionDb);

          if (!existingTx) {
            await WalletTransaction.create(
              [{
                user_id: p.user_id,
                type: 'deposit',
                amount: p.amount,
                balance_after: newBalance,
                reference_type: 'payment',
                reference_id: String(p._id)
              }],
              { session: sessionDb }
            );
          }

          await Payment.updateOne(
            { _id: p._id },
            {
              $set: {
                razorpay_payment_id: pid,
                status: 'captured',
                paid_at: new Date()
              }
            },
            { session: sessionDb }
          );
        });
      } finally {
        await sessionDb.endSession();
      }
    }

    const latestWallet = await ensureWallet(p.user_id);

    return res.json({
      success: true,
      message: 'Payment verified and wallet updated.',
      balance: Number(latestWallet.balance) / 100
    });
  } catch (e) {
    console.error('PAYMENT VERIFY ERROR:', e);
    return res.status(500).json({ message: 'Payment verification failed.' });
  }
});

/* ======================================================
   ORDERS
   ====================================================== */

app.get('/api/orders', login, async (req, res) => {
  try {
    const rows = await Payment.find({
      user_id: req.session.userId
    })
      .sort({ created_at: -1 })
      .lean();

    return res.json({
      orders: rows.map((x) => ({
        ...x,
        id: x._id,
        amount: Number(x.amount) / 100
      }))
    });
  } catch (e) {
    console.error('ORDERS ERROR:', e);
    return res.status(500).json({ message: 'Unable to load orders.' });
  }
});

/* ======================================================
   WITHDRAW
   ====================================================== */

app.post('/api/withdrawals', login, async (req, res) => {
  try {
    const uid = req.session.userId;
    const amount = Number(req.body.amount);
    const method = String(req.body.method || '').toUpperCase();

    if (!Number.isFinite(amount) || amount <= 0) {
      return res.status(400).json({
        success: false,
        message: 'Please enter a valid withdrawal amount.'
      });
    }

    const pa = Math.round(amount * 100);

    if (!['UPI', 'BANK'].includes(method)) {
      return res.status(400).json({
        success: false,
        message: 'Please select a valid withdrawal method.'
      });
    }

    let upi = null;
    let name = null;
    let last4 = null;
    let ifsc = null;

    if (method === 'UPI') {
      upi = String(req.body.upiId || '').trim();

      if (!/^[a-zA-Z0-9._-]{2,}@[a-zA-Z0-9.-]{2,}$/.test(upi)) {
        return res.status(400).json({
          success: false,
          message: 'Please enter a valid UPI ID.'
        });
      }
    } else {
      name = String(req.body.accountName || '').trim();

      const ac = String(req.body.accountNumber || '').trim();
      const cf = String(req.body.confirmAccountNumber || '').trim();

      if (name.length < 2 || !/^[0-9]{9,18}$/.test(ac) || ac !== cf) {
        return res.status(400).json({
          success: false,
          message: 'Please check bank details.'
        });
      }

      ifsc = String(req.body.ifsc || '').trim().toUpperCase();

      if (!/^[A-Z]{4}0[A-Z0-9]{6}$/.test(ifsc)) {
        return res.status(400).json({
          success: false,
          message: 'Please enter a valid IFSC code.'
        });
      }

      last4 = ac.slice(-4);
    }

    const dbSession = await mongoose.startSession();
    let result;

    try {
      await dbSession.withTransaction(async () => {
        const w = await Wallet.findOne({ user_id: uid }).session(dbSession);

        if (!w || Number(w.balance) < pa) {
          result = {
            error: 'INSUFFICIENT',
            balance: w ? Number(w.balance) : 0
          };
          return;
        }

        const withdrawalData = {
          user_id: uid,
          amount: pa,
          currency: 'INR',
          method,
          upi_id: upi,
          account_name: name,
          account_last4: last4,
          ifsc,
          status: 'pending'
        };

        const created = await Withdrawal.create([withdrawalData], {
          session: dbSession
        });

        const newBalance = Number(w.balance) - pa;

        w.balance = newBalance;
        w.updated_at = new Date();
        await w.save({ session: dbSession });

        await WalletTransaction.create(
          [{
            user_id: uid,
            type: 'withdrawal',
            amount: -pa,
            balance_after: newBalance,
            reference_type: 'withdrawal',
            reference_id: String(created[0]._id)
          }],
          { session: dbSession }
        );

        result = {
          id: created[0]._id,
          balance: newBalance
        };
      });
    } finally {
      await dbSession.endSession();
    }

    if (result.error === 'INSUFFICIENT') {
      return res.status(400).json({
        success: false,
        message: 'Insufficient wallet balance.',
        balance: result.balance / 100
      });
    }

    return res.status(201).json({
      success: true,
      message: 'Withdrawal request submitted and amount reserved.',
      withdrawalId: result.id,
      status: 'pending',
      balance: result.balance / 100
    });
  } catch (e) {
    console.error('WITHDRAW ERROR:', e);
    return res.status(500).json({
      success: false,
      message: 'Unable to submit withdrawal request.'
    });
  }
});

/* ======================================================
   USER WITHDRAWAL HISTORY
   ====================================================== */

app.get('/api/withdrawals', login, async (req, res) => {
  try {
    const rows = await Withdrawal.find({
      user_id: req.session.userId
    })
      .sort({ created_at: -1 })
      .lean();

    return res.json({
      success: true,
      withdrawals: rows.map((x) => ({
        id: x._id,
        amount: Number(x.amount) / 100,
        currency: x.currency,
        method: x.method,
        destination:
          x.method === 'UPI'
            ? x.upi_id
            : x.account_last4
            ? '****' + x.account_last4
            : null,
        accountName: x.account_name || null,
        ifsc: x.ifsc || null,
        status: x.status,
        createdAt: x.created_at,
        processedAt: x.processed_at || null
      }))
    });
  } catch (e) {
    console.error('WITHDRAWAL HISTORY ERROR:', e);
    return res.status(500).json({
      success: false,
      message: 'Unable to load withdrawal history.'
    });
  }
});

/* ======================================================
   ADMIN USERS
   ====================================================== */

app.get('/api/admin/users', admin, async (req, res) => {
  try {
    const users = await User.find()
      .select('_id name phone referral_code referred_by created_at')
      .sort({ created_at: -1 })
      .lean();

    const ids = users.map((u) => u._id);

    const wallets = await Wallet.find({
      user_id: { $in: ids }
    }).lean();

    const balanceMap = new Map(
      wallets.map((w) => [String(w.user_id), Number(w.balance)])
    );

    return res.json({
      success: true,
      users: users.map((x) => ({
        id: x._id,
        name: x.name,
        phone: x.phone,
        referral_code: x.referral_code,
        referred_by: x.referred_by,
        created_at: x.created_at,
        balance: (balanceMap.get(String(x._id)) || 0) / 100
      }))
    });
  } catch (e) {
    console.error('ADMIN USERS ERROR:', e);
    return res.status(500).json({ success: false, message: 'Unable to load users.' });
  }
});

/* ======================================================
   ADMIN BALANCE ADJUSTMENT
   ====================================================== */

app.post('/api/admin/users/:id/balance', admin, async (req, res) => {
  try {
    const uid = req.params.id;
    const amount = Number(req.body.amount);
    const type = String(req.body.type || 'credit').toLowerCase();
    const reason = String(req.body.reason || 'Admin adjustment').trim();

    if (!mongoose.isValidObjectId(uid) || !Number.isFinite(amount) || amount <= 0) {
      return res.status(400).json({
        success: false,
        message: 'Invalid user or amount.'
      });
    }

    if (!['credit', 'debit'].includes(type)) {
      return res.status(400).json({
        success: false,
        message: 'Invalid balance adjustment type.'
      });
    }

    if (amount > 10000000) {
      return res.status(400).json({
        success: false,
        message: 'Adjustment amount is too large.'
      });
    }

    const u = await User.findById(uid).select('_id name phone');

    if (!u) {
      return res.status(404).json({
        success: false,
        message: 'User not found.'
      });
    }

    const pa = Math.round(amount * 100);
    const delta = type === 'debit' ? -pa : pa;

    const dbSession = await mongoose.startSession();
    let result;

    try {
      await dbSession.withTransaction(async () => {
        const w =
          (await Wallet.findOne({ user_id: uid }).session(dbSession)) ||
          new Wallet({ user_id: uid, balance: 0 });

        const oldBalance = Number(w.balance);
        const newBalance = oldBalance + delta;

        if (newBalance < 0) {
          result = { error: 'NEGATIVE', old: oldBalance };
          return;
        }

        w.balance = newBalance;
        w.updated_at = new Date();
        await w.save({ session: dbSession });

        await WalletTransaction.create(
          [{
            user_id: uid,
            type: 'admin_adjustment',
            amount: delta,
            balance_after: newBalance,
            reference_type: 'admin',
            reference_id:
              'admin_' + Date.now() + '_' + crypto.randomBytes(3).toString('hex')
          }],
          { session: dbSession }
        );

        result = {
          old: oldBalance,
          nb: newBalance
        };
      });
    } finally {
      await dbSession.endSession();
    }

    if (result.error === 'NEGATIVE') {
      return res.status(400).json({
        success: false,
        message: 'Balance cannot go below zero.',
        balance: result.old / 100
      });
    }

    return res.json({
      success: true,
      message: 'User wallet updated.',
      user: u,
      type,
      reason,
      oldBalance: result.old / 100,
      newBalance: result.nb / 100
    });
  } catch (e) {
    console.error('ADMIN BALANCE ERROR:', e);
    return res.status(500).json({
      success: false,
      message: 'Unable to update user balance.'
    });
  }
});

/* ======================================================
   ADMIN WITHDRAWALS
   ====================================================== */

async function getAdminWithdrawals() {
  const rows = await Withdrawal.find()
    .sort({ created_at: -1 })
    .lean();

  const ids = rows.map((x) => x.user_id);
  const users = await User.find({ _id: { $in: ids } })
    .select('_id name phone')
    .lean();

  const userMap = new Map(users.map((u) => [String(u._id), u]));

  return rows.map((x) => {
    const u = userMap.get(String(x.user_id));

    return {
      id: x._id,
      userId: x.user_id,
      name: u ? u.name : '',
      phone: u ? u.phone : '',
      amount: Number(x.amount) / 100,
      currency: x.currency,
      method: x.method,
      destination:
        x.method === 'UPI'
          ? x.upi_id
          : x.account_last4
          ? '****' + x.account_last4
          : null,
      accountName: x.account_name || null,
      ifsc: x.ifsc || null,
      status: x.status,
      createdAt: x.created_at,
      processedAt: x.processed_at || null
    };
  });
}

app.get('/api/admin/withdrawals', admin, async (req, res) => {
  try {
    return res.json({
      success: true,
      withdrawals: await getAdminWithdrawals()
    });
  } catch (e) {
    console.error('ADMIN WITHDRAWALS ERROR:', e);
    return res.status(500).json({
      success: false,
      message: 'Unable to load withdrawals.'
    });
  }
});

/* ======================================================
   ADMIN: PROCESSING
   ====================================================== */

app.post('/api/admin/withdrawals/:id/processing', admin, async (req, res) => {
  try {
    const id = req.params.id;

    if (!mongoose.isValidObjectId(id)) {
      return res.status(400).json({
        success: false,
        message: 'Invalid withdrawal ID.'
      });
    }

    const w = await Withdrawal.findById(id);

    if (!w) {
      return res.status(404).json({
        success: false,
        message: 'Withdrawal not found.'
      });
    }

    if (w.status !== 'pending') {
      return res.status(409).json({
        success: false,
        message: 'Withdrawal is already ' + w.status + '.'
      });
    }

    w.status = 'processing';
    await w.save();

    return res.json({
      success: true,
      message: 'Withdrawal moved to Processing.',
      status: 'processing'
    });
  } catch (e) {
    console.error('PROCESS WITHDRAWAL ERROR:', e);
    return res.status(500).json({
      success: false,
      message: 'Unable to process withdrawal.'
    });
  }
});

/* ======================================================
   ADMIN: COMPLETE
   ====================================================== */

app.post('/api/admin/withdrawals/:id/complete', admin, async (req, res) => {
  try {
    const id = req.params.id;

    if (!mongoose.isValidObjectId(id)) {
      return res.status(400).json({
        success: false,
        message: 'Invalid withdrawal ID.'
      });
    }

    const w = await Withdrawal.findById(id);

    if (!w) {
      return res.status(404).json({
        success: false,
        message: 'Withdrawal not found.'
      });
    }

    if (!['pending', 'processing'].includes(w.status)) {
      return res.status(409).json({
        success: false,
        message: 'Withdrawal is already ' + w.status + '.'
      });
    }

    w.status = 'completed';
    w.processed_at = new Date();
    await w.save();

    return res.json({
      success: true,
      message: 'Withdrawal marked as completed.',
      note: 'This records the payout only. It does not send money.',
      amount: Number(w.amount) / 100
    });
  } catch (e) {
    console.error('COMPLETE WITHDRAWAL ERROR:', e);
    return res.status(500).json({
      success: false,
      message: 'Unable to complete withdrawal.'
    });
  }
});

/* ======================================================
   ADMIN: REJECT + REFUND
   ====================================================== */

app.post('/api/admin/withdrawals/:id/reject', admin, async (req, res) => {
  try {
    const id = req.params.id;

    if (!mongoose.isValidObjectId(id)) {
      return res.status(400).json({
        success: false,
        message: 'Invalid withdrawal ID.'
      });
    }

    const dbSession = await mongoose.startSession();
    let result;

    try {
      await dbSession.withTransaction(async () => {
        const w = await Withdrawal.findById(id).session(dbSession);

        if (!w) {
          result = { error: 'NOT_FOUND' };
          return;
        }

        if (!['pending', 'processing'].includes(w.status)) {
          result = { error: 'DONE', status: w.status };
          return;
        }

        const wallet =
          (await Wallet.findOne({ user_id: w.user_id }).session(dbSession)) ||
          new Wallet({ user_id: w.user_id, balance: 0 });

        const newBalance = Number(wallet.balance) + Number(w.amount);

        wallet.balance = newBalance;
        wallet.updated_at = new Date();
        await wallet.save({ session: dbSession });

        await WalletTransaction.create(
          [{
            user_id: w.user_id,
            type: 'withdrawal_refund',
            amount: w.amount,
            balance_after: newBalance,
            reference_type: 'withdrawal',
            reference_id: String(w._id)
          }],
          { session: dbSession }
        );

        w.status = 'rejected';
        w.processed_at = new Date();
        await w.save({ session: dbSession });

        result = {
          amount: Number(w.amount),
          balance: newBalance
        };
      });
    } finally {
      await dbSession.endSession();
    }

    if (result.error === 'NOT_FOUND') {
      return res.status(404).json({
        success: false,
        message: 'Withdrawal not found.'
      });
    }

    if (result.error === 'DONE') {
      return res.status(409).json({
        success: false,
        message: 'Withdrawal is already ' + result.status + '.'
      });
    }

    return res.json({
      success: true,
      message: 'Withdrawal rejected and balance refunded.',
      refundedAmount: result.amount / 100,
      newBalance: result.balance / 100
    });
  } catch (e) {
    console.error('REJECT WITHDRAWAL ERROR:', e);
    return res.status(500).json({
      success: false,
      message: 'Unable to reject withdrawal.'
    });
  }
});

/* ======================================================
   OLD ADMIN ACTION ENDPOINT
   ====================================================== */

app.post('/api/admin/withdrawals/:id/action', admin, async (req, res) => {
  try {
    const action = String(req.body.action || '').toLowerCase();

    if (!['reject', 'paid'].includes(action)) {
      return res.status(400).json({
        success: false,
        message: 'Action must be reject or paid.'
      });
    }

    const id = req.params.id;

    if (!mongoose.isValidObjectId(id)) {
      return res.status(400).json({
        success: false,
        message: 'Invalid withdrawal ID.'
      });
    }

    if (action === 'paid') {
      const w = await Withdrawal.findById(id);

      if (!w) {
        return res.status(404).json({
          success: false,
          message: 'Withdrawal not found.'
        });
      }

      if (w.status !== 'pending') {
        return res.status(409).json({
          success: false,
          message: 'Withdrawal is already ' + w.status + '.'
        });
      }

      w.status = 'completed';
      w.processed_at = new Date();
      await w.save();

      return res.json({
        success: true,
        message: 'Withdrawal marked as completed.',
        note: 'This endpoint does not send money. Mark paid only after the real payout has been sent.',
        amount: Number(w.amount) / 100
      });
    }

    req.params.id = id;

    /* Same refund logic as /reject */
    const dbSession = await mongoose.startSession();
    let result;

    try {
      await dbSession.withTransaction(async () => {
        const w = await Withdrawal.findById(id).session(dbSession);

        if (!w) {
          result = { error: 'NOT_FOUND' };
          return;
        }

        if (w.status !== 'pending') {
          result = { error: 'DONE', status: w.status };
          return;
        }

        const wallet =
          (await Wallet.findOne({ user_id: w.user_id }).session(dbSession)) ||
          new Wallet({ user_id: w.user_id, balance: 0 });

        const newBalance = Number(wallet.balance) + Number(w.amount);

        wallet.balance = newBalance;
        wallet.updated_at = new Date();
        await wallet.save({ session: dbSession });

        await WalletTransaction.create(
          [{
            user_id: w.user_id,
            type: 'withdrawal_refund',
            amount: w.amount,
            balance_after: newBalance,
            reference_type: 'withdrawal',
            reference_id: String(w._id)
          }],
          { session: dbSession }
        );

        w.status = 'rejected';
        w.processed_at = new Date();
        await w.save({ session: dbSession });

        result = {
          amount: Number(w.amount),
          balance: newBalance
        };
      });
    } finally {
      await dbSession.endSession();
    }

    if (result.error === 'NOT_FOUND') {
      return res.status(404).json({
        success: false,
        message: 'Withdrawal not found.'
      });
    }

    if (result.error === 'DONE') {
      return res.status(409).json({
        success: false,
        message: 'Withdrawal is already ' + result.status + '.'
      });
    }

    return res.json({
      success: true,
      message: 'Withdrawal rejected and balance refunded.',
      refundedAmount: result.amount / 100,
      newBalance: result.balance / 100
    });
  } catch (e) {
    console.error('ADMIN ACTION ERROR:', e);
    return res.status(500).json({
      success: false,
      message: 'Unable to process withdrawal.'
    });
  }
});

/* ======================================================
   ADMIN SUMMARY
   ====================================================== */

app.get('/api/admin/summary', admin, async (req, res) => {
  try {
    const [
      totalUsers,
      balanceAgg,
      withdrawalsAgg,
      pendingWithdrawals,
      paymentsAgg
    ] = await Promise.all([
      User.countDocuments(),
      Wallet.aggregate([
        { $group: { _id: null, total: { $sum: '$balance' } } }
      ]),
      Withdrawal.aggregate([
        { $match: { status: 'completed' } },
        { $group: { _id: null, total: { $sum: '$amount' } } }
      ]),
      Withdrawal.countDocuments({
        status: { $in: ['pending', 'processing'] }
      }),
      Payment.aggregate([
        { $match: { status: 'captured' } },
        { $group: { _id: null, total: { $sum: '$amount' } } }
      ])
    ]);

    const totalBalance = balanceAgg[0]?.total || 0;
    const totalWithdrawals = withdrawalsAgg[0]?.total || 0;
    const totalPayments = paymentsAgg[0]?.total || 0;

    return res.json({
      success: true,
      totalUsers: Number(totalUsers),
      totalBalance: totalBalance / 100,
      totalWithdrawals: totalWithdrawals / 100,
      pendingWithdrawals: Number(pendingWithdrawals),
      totalPayments: totalPayments / 100
    });
  } catch (e) {
    console.error('ADMIN SUMMARY ERROR:', e);
    return res.status(500).json({
      success: false,
      message: 'Unable to load admin summary.'
    });
  }
});

/* ======================================================
   ADMIN TOTAL USERS
   ====================================================== */

app.get('/api/admin/total-users', admin, async (req, res) => {
  try {
    const total = await User.countDocuments();

    return res.json({
      success: true,
      totalUsers: Number(total)
    });
  } catch (e) {
    console.error('TOTAL USERS ERROR:', e);
    return res.status(500).json({
      success: false,
      message: 'Unable to load total users.'
    });
  }
});

/* ======================================================
   LOGOUT
   ====================================================== */

app.post('/api/logout', (req, res) => {
  req.session.destroy(() => {
    res.clearCookie('truewalk.sid');
    res.json({ message: 'Logout successful.' });
  });
});

/* ======================================================
   STATIC FILES + ROOT
   ====================================================== */

app.use(express.static(__dirname));

app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

/* ======================================================
   ERROR HANDLER
   ====================================================== */

app.use((err, req, res, next) => {
  console.error('UNHANDLED ERROR:', err);
  res.status(500).json({
    success: false,
    message: 'Internal server error.'
  });
});

/* ======================================================
   START
   ====================================================== */

async function startServer() {
  try {
    await mongoose.connect(MONGO_URI, {
      serverSelectionTimeoutMS: 10000
    });

    console.log('MongoDB connected successfully.');

    app.listen(PORT, () => {
      console.log(`TRUE WALK server running on port ${PORT}`);
      console.log(
        razorpay
          ? 'Razorpay configuration detected.'
          : 'Razorpay keys are not configured yet.'
      );
    });
  } catch (err) {
    console.error('MongoDB connection failed:', err);
    process.exit(1);
  }
}

startServer();
