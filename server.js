require('dotenv').config();

const express = require('express');
const path = require('path');
const crypto = require('crypto');
const mongoose = require('mongoose');
const session = require('express-session');

const MongoStore =
  require('connect-mongo').default || require('connect-mongo');

const app = express();
const PORT = process.env.PORT || 3000;

app.set('trust proxy', 1);

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

/* ======================================================
   DATABASE
   ====================================================== */

const MONGO_URI =
  process.env.MONGODB_URI || process.env.MONGO_URI;

if (!MONGO_URI) {
  console.error('ERROR: MONGODB_URI is not configured.');
  process.exit(1);
}

/* ======================================================
   WATCHPAYS CONFIG
   ====================================================== */

const WATCHPAYS_MERCHANT_ID =
  process.env.WATCHPAYS_MERCHANT_ID || '';

const WATCHPAYS_API_KEY =
  process.env.WATCHPAYS_API_KEY || '';

const WATCHPAYS_PAYOUT_KEY =
  process.env.WATCHPAYS_PAYOUT_KEY || '';

const WATCHPAYS_PAYIN_URL =
  process.env.WATCHPAYS_PAYIN_URL ||
  'https://api.watchpays.com/v1/create';

const WATCHPAYS_PAYOUT_URL =
  process.env.WATCHPAYS_PAYOUT_URL ||
  'http://api.watchpays.com/payout/payment';

const WATCHPAYS_PAYIN_CALLBACK_URL =
  process.env.WATCHPAYS_PAYIN_CALLBACK_URL || '';

const WATCHPAYS_PAYOUT_CALLBACK_URL =
  process.env.WATCHPAYS_PAYOUT_CALLBACK_URL || '';

/* ======================================================
   SCHEMAS
   ====================================================== */

const userSchema = new mongoose.Schema(
  {
    name: {
      type: String,
      required: true,
      trim: true
    },

    phone: {
      type: String,
      required: true,
      unique: true,
      index: true
    },

    salt: {
      type: String,
      required: true
    },

    password_hash: {
      type: String,
      required: true
    },

    referral_code: {
      type: String,
      unique: true,
      sparse: true,
      index: true
    },

    referred_by: {
      type: String,
      default: null,
      index: true
    }
  },
  {
    timestamps: {
      createdAt: 'created_at',
      updatedAt: 'updated_at'
    }
  }
);

const walletSchema = new mongoose.Schema(
  {
    user_id: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      unique: true,
      index: true
    },

    balance: {
      type: Number,
      default: 0
    },

    updated_at: {
      type: Date,
      default: Date.now
    }
  },
  {
    versionKey: false
  }
);

const walletTransactionSchema = new mongoose.Schema(
  {
    user_id: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      index: true
    },

    type: {
      type: String,
      required: true
    },

    amount: {
      type: Number,
      required: true
    },

    balance_after: {
      type: Number,
      required: true
    },

    reference_type: String,

    reference_id: String,

    created_at: {
      type: Date,
      default: Date.now
    }
  },
  {
    versionKey: false
  }
);

walletTransactionSchema.index(
  {
    reference_type: 1,
    reference_id: 1,
    type: 1
  },
  {
    unique: true,
    sparse: true
  }
);

const paymentOrderSchema = new mongoose.Schema(
  {
    user_id: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: true,
      index: true
    },

    merchant_order_no: {
      type: String,
      required: true,
      unique: true,
      index: true
    },

    gateway_order_no: {
      type: String,
      default: null,
      index: true
    },

    amount: {
      type: Number,
      required: true
    },

    currency: {
      type: String,
      default: 'INR'
    },

    status: {
      type: String,
      default: 'created',
      index: true
    },

    payment_url: {
      type: String,
      default: null
    },

    gateway_response: {
      type: mongoose.Schema.Types.Mixed,
      default: null
    },

    paid_at: {
      type: Date,
      default: null
    },

    created_at: {
      type: Date,
      default: Date.now
    },

    updated_at: {
      type: Date,
      default: Date.now
    }
  },
  {
    versionKey: false
  }
);

const withdrawalSchema = new mongoose.Schema(
  {
    user_id: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      index: true
    },

    amount: {
      type: Number,
      required: true
    },

    currency: {
      type: String,
      default: 'INR'
    },

    method: {
      type: String,
      required: true
    },

    upi_id: String,

    account_name: String,

    account_last4: String,

    account_number: String,

    ifsc: String,

    bank_name: String,

    status: {
      type: String,
      default: 'pending',
      index: true
    },

    payout_transaction_id: {
      type: String,
      default: null,
      unique: true,
      sparse: true,
      index: true
    },

    payout_fee: {
      type: Number,
      default: 0
    },

    payout_total_amount: {
      type: Number,
      default: 0
    },

    payout_response: {
      type: mongoose.Schema.Types.Mixed,
      default: null
    },

    payout_callback_status: {
      type: String,
      default: null
    },

    created_at: {
      type: Date,
      default: Date.now
    },

    processed_at: {
      type: Date,
      default: null
    }
  },
  {
    versionKey: false
  }
);

const User =
  mongoose.model('User', userSchema);

const Wallet =
  mongoose.model('Wallet', walletSchema);

const WalletTransaction =
  mongoose.model(
    'WalletTransaction',
    walletTransactionSchema
  );

const PaymentOrder =
  mongoose.model(
    'PaymentOrder',
    paymentOrderSchema
  );

const Withdrawal =
  mongoose.model(
    'Withdrawal',
    withdrawalSchema
  );

/* ======================================================
   SESSION
   ====================================================== */

app.use(
  session({
    name: 'truewalk.sid',

    secret:
      process.env.SESSION_SECRET ||
      'CHANGE_THIS_SECRET_IN_RENDER',

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

      secure:
        process.env.NODE_ENV === 'production',

      maxAge:
        14 * 24 * 60 * 60 * 1000
    }
  })
);

/* ======================================================
   HELPERS
   ====================================================== */

function hash(password, salt) {
  return crypto
    .scryptSync(
      String(password),
      salt,
      64
    )
    .toString('hex');
}

function makeRef() {
  return (
    'TW' +
    crypto
      .randomBytes(8)
      .toString('hex')
      .toUpperCase()
  );
}

function makeMerchantOrderNo() {
  return (
    'ORD_' +
    Date.now() +
    '_' +
    crypto
      .randomBytes(4)
      .toString('hex')
      .toUpperCase()
  );
}

function makePayoutTransactionId() {
  return (
    'WD_' +
    Date.now() +
    '_' +
    crypto
      .randomBytes(4)
      .toString('hex')
      .toUpperCase()
  );
}

function moneyToPaise(amount) {
  const n = Number(amount);

  if (!Number.isFinite(n)) {
    return null;
  }

  return Math.round(n * 100);
}

function paiseToMoney(paise) {
  return Number(paise || 0) / 100;
}

function formatAmount(paise) {
  return paiseToMoney(paise).toFixed(2);
}

/*
 * WatchPays payout documentation uses examples such as:
 *
 * amount = 150
 *
 * So payout amount is sent as:
 *
 * 150
 *
 * rather than:
 *
 * 150.00
 */
function formatPayoutAmount(paise) {
  const amount = paiseToMoney(paise);

  if (!Number.isFinite(amount)) {
    throw new Error('Invalid payout amount.');
  }

  return Number.isInteger(amount)
    ? String(amount)
    : amount.toFixed(2);
}

async function ensureWallet(userId) {
  return Wallet.findOneAndUpdate(
    {
      user_id: userId
    },
    {
      $setOnInsert: {
        user_id: userId,
        balance: 0
      },
      $set: {
        updated_at: new Date()
      }
    },
    {
      upsert: true,
      new: true
    }
  );
}

function login(req, res, next) {
  if (req.session.userId) {
    return next();
  }

  return res.status(401).json({
    message: 'Please login first.'
  });
}

function admin(req, res, next) {
  if (req.session.isAdmin) {
    return next();
  }

  return res.status(401).json({
    message: 'Admin login required.'
  });
}

function safeUser(u) {
  return {
    id: u._id,
    name: u.name,
    phone: u.phone
  };
}

/* ======================================================
   WATCHPAYS CONFIG CHECK
   ====================================================== */

function watchpaysConfiguredPayin() {
  return Boolean(
    WATCHPAYS_MERCHANT_ID &&
    WATCHPAYS_API_KEY &&
    WATCHPAYS_PAYIN_CALLBACK_URL
  );
}

function watchpaysConfiguredPayout() {
  return Boolean(
    WATCHPAYS_MERCHANT_ID &&
    WATCHPAYS_PAYOUT_KEY &&
    WATCHPAYS_PAYOUT_CALLBACK_URL
  );
}

/* ======================================================
   WATCHPAYS PAY-IN SIGNATURE
   ====================================================== */

function createWatchPaysPayinSignature({
  merchant_id,
  amount,
  merchant_order_no,
  callback_url
}) {
  const params = {
    merchant_id,
    amount,
    merchant_order_no,
    callback_url
  };

  const sortedKeys =
    Object.keys(params)
      .filter(
        (key) =>
          params[key] !== undefined &&
          params[key] !== null &&
          String(params[key]) !== ''
      )
      .sort();

  let signString = '';

  for (const key of sortedKeys) {
    signString +=
      `${key}=${params[key]}&`;
  }

  signString +=
    `key=${WATCHPAYS_API_KEY}`;

  return crypto
    .createHash('md5')
    .update(signString)
    .digest('hex');
}

/* ======================================================
   WATCHPAYS PAYOUT SIGNATURE
   ====================================================== */

/*
 * EXACT WatchPays documentation:
 *
 * md5(
 *   account_number +
 *   amount +
 *   bank_name +
 *   callback_url +
 *   ifsc +
 *   merchant_id +
 *   name +
 *   transaction_id +
 *   payout_key
 * )
 */

function createWatchPaysPayoutSignature({
  account_number,
  amount,
  bank_name,
  callback_url,
  ifsc,
  merchant_id,
  name,
  transaction_id
}) {
  const signString =
    String(account_number) +
    String(amount) +
    String(bank_name) +
    String(callback_url) +
    String(ifsc) +
    String(merchant_id) +
    String(name) +
    String(transaction_id) +
    String(WATCHPAYS_PAYOUT_KEY);

  return crypto
    .createHash('md5')
    .update(signString)
    .digest('hex');
}

/* ======================================================
   HTTP HELPER
   ====================================================== */

async function watchpaysFetch(
  url,
  options = {}
) {
  const controller =
    new AbortController();

  const timeout =
    setTimeout(
      () => controller.abort(),
      30000
    );

  try {
    return await fetch(
      url,
      {
        ...options,
        signal: controller.signal
      }
    );
  } finally {
    clearTimeout(timeout);
  }
}

async function readJsonResponse(response) {
  const text =
    await response.text();

  try {
    return {
      raw: text,
      data: JSON.parse(text)
    };
  } catch {
    return {
      raw: text,
      data: null
    };
  }
}

/* ======================================================
   HEALTH
   ====================================================== */

app.get(
  '/health',
  (req, res) => {
    res.json({
      success: true,
      service: 'TRUE WALK',

      payment_gateway:
        watchpaysConfiguredPayin()
          ? 'WATCHPAYS'
          : 'NOT_CONFIGURED',

      payout_gateway:
        watchpaysConfiguredPayout()
          ? 'WATCHPAYS'
          : 'NOT_CONFIGURED'
    });
  }
);

/* ======================================================
   HOME
   ====================================================== */

app.get(
  '/home.html',
  (req, res) => {
    if (!req.session.userId) {
      return res.redirect('/login.html');
    }

    return res.sendFile(
      path.join(__dirname, 'home.html')
    );
  }
);

/* ======================================================
   ADMIN LOGIN
   ====================================================== */

app.post(
  '/api/admin/login',
  (req, res) => {
    const {
      username,
      password
    } = req.body;

    if (
      !process.env.ADMIN_USERNAME ||
      !process.env.ADMIN_PASSWORD
    ) {
      return res.status(503).json({
        message:
          'Admin credentials are not configured.'
      });
    }

    if (
      String(username || '') !==
        String(process.env.ADMIN_USERNAME) ||
      String(password || '') !==
        String(process.env.ADMIN_PASSWORD)
    ) {
      return res.status(401).json({
        message:
          'Invalid admin username or password.'
      });
    }

    req.session.regenerate(
      (err) => {
        if (err) {
          return res.status(500).json({
            message:
              'Admin login failed.'
          });
        }

        req.session.isAdmin = true;

        req.session.save(
          (saveErr) => {
            if (saveErr) {
              return res.status(500).json({
                message:
                  'Admin session could not be saved.'
              });
            }

            return res.json({
              success: true,
              message:
                'Admin login successful.'
            });
          }
        );
      }
    );
  }
);

app.post(
  '/api/admin/logout',
  admin,
  (req, res) => {
    req.session.destroy(() => {
      res.clearCookie('truewalk.sid');

      res.json({
        success: true
      });
    });
  }
);

app.get(
  '/api/admin/me',
  admin,
  (req, res) => {
    res.json({
      success: true,
      admin: true
    });
  }
);

/* ======================================================
   REGISTER
   ====================================================== */

app.post(
  '/api/register',
  async (req, res) => {
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

      const ph =
        String(phone).trim();

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

      const existing =
        await User.findOne({
          phone: ph
        }).lean();

      if (existing) {
        return res.status(409).json({
          message:
            'This mobile number is already registered.'
        });
      }

      let referredBy = null;

      if (referralCode) {
        const c =
          String(referralCode)
            .trim()
            .toUpperCase();

        const refUser =
          await User.findOne({
            referral_code: c
          }).lean();

        if (!refUser) {
          return res.status(400).json({
            message:
              'Invalid referral code.'
          });
        }

        referredBy = c;
      }

      let rc;

      for (;;) {
        rc = makeRef();

        const exists =
          await User.exists({
            referral_code: rc
          });

        if (!exists) break;
      }

      const salt =
        crypto
          .randomBytes(16)
          .toString('hex');

      const passwordHash =
        hash(password, salt);

      const user =
        await User.create({
          name: String(name).trim(),
          phone: ph,
          salt,
          password_hash: passwordHash,
          referral_code: rc,
          referred_by: referredBy
        });

      await ensureWallet(user._id);

      return res.status(201).json({
        message:
          'Registration successful.',
        userId: user._id,
        referralCode: rc
      });
    } catch (e) {
      console.error('REGISTER ERROR:', e);

      if (e && e.code === 11000) {
        return res.status(409).json({
          message:
            'This mobile number or referral code is already registered.'
        });
      }

      return res.status(500).json({
        message: 'Registration failed.'
      });
    }
  }
);

/* ======================================================
   LOGIN
   ====================================================== */

app.post(
  '/api/login',
  async (req, res) => {
    try {
      const {
        phone,
        password
      } = req.body;

      const u =
        await User.findOne({
          phone:
            String(phone || '').trim()
        });

      if (
        !u ||
        hash(password, u.salt) !==
          u.password_hash
      ) {
        return res.status(401).json({
          message:
            'Invalid mobile number or password.'
        });
      }

      await ensureWallet(u._id);

      req.session.regenerate(
        (err) => {
          if (err) {
            return res.status(500).json({
              message:
                'Login failed.'
            });
          }

          req.session.userId =
            String(u._id);

          req.session.isAdmin = false;

          req.session.save(
            (saveErr) => {
              if (saveErr) {
                return res.status(500).json({
                  message:
                    'Login session could not be saved.'
                });
              }

              return res.json({
                message:
                  'Login successful.',
                user: safeUser(u)
              });
            }
          );
        }
      );
    } catch (e) {
      console.error('LOGIN ERROR:', e);

      return res.status(500).json({
        message: 'Login failed.'
      });
    }
  }
);

/* ======================================================
   CURRENT USER
   ====================================================== */

app.get(
  '/api/me',
  login,
  async (req, res) => {
    try {
      const u =
        await User.findById(
          req.session.userId
        ).select(
          '_id name phone referral_code'
        );

      if (!u) {
        return res.status(401).json({
          message:
            'Session is invalid.'
        });
      }

      const w =
        await ensureWallet(u._id);

      return res.json({
        user: {
          id: u._id,
          name: u.name,
          phone: u.phone,
          referral_code:
            u.referral_code
        },

        balance:
          paiseToMoney(w.balance)
      });
    } catch (e) {
      console.error('ME ERROR:', e);

      return res.status(500).json({
        message:
          'Unable to load user.'
      });
    }
  }
);

/* ======================================================
   WALLET
   ====================================================== */

app.get(
  '/api/wallet',
  login,
  async (req, res) => {
    try {
      const w =
        await ensureWallet(
          req.session.userId
        );

      const t =
        await WalletTransaction.find({
          user_id:
            req.session.userId
        })
          .sort({
            created_at: -1
          })
          .limit(50)
          .lean();

      return res.json({
        success: true,

        balance:
          paiseToMoney(w.balance),

        updatedAt:
          w.updated_at,

        transactions:
          t.map((x) => ({
            ...x,

            id: x._id,

            amount:
              paiseToMoney(x.amount),

            balanceAfter:
              paiseToMoney(
                x.balance_after
              )
          }))
      });
    } catch (e) {
      console.error('WALLET ERROR:', e);

      return res.status(500).json({
        message:
          'Unable to load wallet.'
      });
    }
  }
);

/* ======================================================
   WATCHPAYS PAY-IN
   ====================================================== */

async function createWatchPaysPayment(
  req,
  res
) {
  try {
    if (!watchpaysConfiguredPayin()) {
      return res.status(503).json({
        success: false,
        message:
          'WatchPays payment gateway is not configured.'
      });
    }

    const amount =
      Number(req.body.amount);

    if (
      !Number.isFinite(amount) ||
      amount <= 0
    ) {
      return res.status(400).json({
        success: false,
        message:
          'Please enter a valid payment amount.'
      });
    }

    const paise =
      moneyToPaise(amount);

    if (!paise || paise <= 0) {
      return res.status(400).json({
        success: false,
        message:
          'Invalid payment amount.'
      });
    }

    const amountString =
      formatAmount(paise);

    const merchantOrderNo =
      makeMerchantOrderNo();

    const signature =
      createWatchPaysPayinSignature({
        merchant_id:
          WATCHPAYS_MERCHANT_ID,

        amount:
          amountString,

        merchant_order_no:
          merchantOrderNo,

        callback_url:
          WATCHPAYS_PAYIN_CALLBACK_URL
      });

    const payload = {
      merchant_id:
        WATCHPAYS_MERCHANT_ID,

      api_key:
        WATCHPAYS_API_KEY,

      amount:
        amountString,

      merchant_order_no:
        merchantOrderNo,

      callback_url:
        WATCHPAYS_PAYIN_CALLBACK_URL,

      extra:
        String(req.session.userId),

      signature
    };

    const order =
      await PaymentOrder.create({
        user_id:
          req.session.userId,

        merchant_order_no:
          merchantOrderNo,

        amount:
          paise,

        currency:
          'INR',

        status:
          'creating'
      });

    let response;

    try {
      response =
        await watchpaysFetch(
          WATCHPAYS_PAYIN_URL,
          {
            method: 'POST',

            headers: {
              'Content-Type':
                'application/json',

              Accept:
                'application/json'
            },

            body:
              JSON.stringify(payload)
          }
        );
    } catch (gatewayError) {
      order.status =
        'gateway_error';

      order.gateway_response = {
        error:
          gatewayError.message
      };

      order.updated_at =
        new Date();

      await order.save();

      console.error(
        'WATCHPAYS PAYIN ERROR:',
        gatewayError
      );

      return res.status(502).json({
        success: false,
        message:
          'Unable to connect to WatchPays.'
      });
    }

    const parsed =
      await readJsonResponse(
        response
      );

    const data =
      parsed.data;

    if (
      !response.ok ||
      !data ||
      data.success !== true ||
      !data.payment_url
    ) {
      order.status =
        'failed';

      order.gateway_response =
        data || parsed.raw;

      order.updated_at =
        new Date();

      await order.save();

      return res.status(502).json({
        success: false,

        message:
          data?.message ||
          'WatchPays payment order could not be created.'
      });
    }

    order.gateway_order_no =
      data.order_no || null;

    order.payment_url =
      data.payment_url;

    order.status =
      data.status || 'created';

    order.gateway_response =
      data;

    order.updated_at =
      new Date();

    await order.save();

    return res.status(201).json({
      success: true,

      payment: {
        merchantOrderNo:
          merchantOrderNo,

        gatewayOrderNo:
          data.order_no || null,

        amount:
          paiseToMoney(paise),

        paymentUrl:
          data.payment_url,

        status:
          data.status || 'created'
      }
    });
  } catch (e) {
    console.error(
      'CREATE PAYMENT ERROR:',
      e
    );

    return res.status(500).json({
      success: false,
      message:
        'Unable to create payment.'
    });
  }
}

app.post(
  '/api/payments/create',
  login,
  createWatchPaysPayment
);

app.post(
  '/api/payment/create',
  login,
  createWatchPaysPayment
);

/* ======================================================
   PAYMENT HISTORY
   ====================================================== */

app.get(
  '/api/payments',
  login,
  async (req, res) => {
    try {
      const rows =
        await PaymentOrder.find({
          user_id:
            req.session.userId
        })
          .sort({
            created_at: -1
          })
          .limit(100)
          .lean();

      return res.json({
        success: true,

        payments:
          rows.map((x) => ({
            id: x._id,

            merchantOrderNo:
              x.merchant_order_no,

            gatewayOrderNo:
              x.gateway_order_no,

            amount:
              paiseToMoney(x.amount),

            currency:
              x.currency,

            status:
              x.status,

            paymentUrl:
              x.payment_url,

            paidAt:
              x.paid_at,

            createdAt:
              x.created_at
          }))
      });
    } catch (e) {
      console.error(
        'PAYMENT HISTORY ERROR:',
        e
      );

      return res.status(500).json({
        success: false,
        message:
          'Unable to load payment history.'
      });
    }
  }
);

/* ======================================================
   WATCHPAYS PAY-IN CALLBACK
   ====================================================== */

/*
 * IMPORTANT:
 * Your supplied WatchPays documentation did not include
 * the official Pay-in callback payload.
 *
 * This handler accepts common names:
 *
 * merchantOrder / merchant_order_no
 * orderNo / order_no / gateway_order_no
 * status
 * amount
 *
 * Wallet is credited ONLY when:
 *
 * 1. Order exists
 * 2. Amount matches
 * 3. Gateway order matches when already known
 * 4. Status is success
 * 5. Order is not already paid
 *
 * Get the exact WatchPays Pay-in callback documentation
 * and update this handler if their actual field names differ.
 */

app.post(
  '/api/watchpays/callback',
  async (req, res) => {
    try {
      const body =
        req.body || {};

      const merchantOrder =
        body.merchantOrder ||
        body.merchant_order_no ||
        body.merchant_order ||
        body.order_id ||
        null;

      const orderNo =
        body.orderNo ||
        body.order_no ||
        body.gateway_order_no ||
        body.gatewayOrderNo ||
        null;

      const amount =
        body.amount;

      const status =
        body.status ||
        body.payment_status ||
        body.order_status ||
        '';

      if (
        !merchantOrder ||
        !status ||
        amount === undefined ||
        amount === null
      ) {
        return res.status(400).send(
          'invalid callback'
        );
      }

      const order =
        await PaymentOrder.findOne({
          merchant_order_no:
            String(merchantOrder)
        });

      if (!order) {
        return res.status(404).send(
          'order not found'
        );
      }

      if (
        orderNo &&
        order.gateway_order_no &&
        String(order.gateway_order_no) !==
          String(orderNo)
      ) {
        return res.status(400).send(
          'gateway order mismatch'
        );
      }

      const callbackPaise =
        moneyToPaise(amount);

      if (
        callbackPaise === null ||
        callbackPaise !==
          Number(order.amount)
      ) {
        return res.status(400).send(
          'amount mismatch'
        );
      }

      const normalizedStatus =
        String(status).toLowerCase();

      if (
        order.status === 'paid'
      ) {
        return res.send('success');
      }

      if (
        ![
          'success',
          'paid',
          'completed'
        ].includes(
          normalizedStatus
        )
      ) {
        order.status =
          normalizedStatus ||
          'failed';

        order.gateway_response =
          body;

        order.updated_at =
          new Date();

        await order.save();

        return res.send('success');
      }

      const dbSession =
        await mongoose.startSession();

      try {
        await dbSession.withTransaction(
          async () => {
            const freshOrder =
              await PaymentOrder.findById(
                order._id
              ).session(
                dbSession
              );

            if (!freshOrder) {
              throw new Error(
                'Payment order not found.'
              );
            }

            if (
              freshOrder.status ===
              'paid'
            ) {
              return;
            }

            const wallet =
              (await Wallet.findOne({
                user_id:
                  freshOrder.user_id
              }).session(
                dbSession
              )) ||
              new Wallet({
                user_id:
                  freshOrder.user_id,

                balance: 0
              });

            const newBalance =
              Number(wallet.balance) +
              Number(freshOrder.amount);

            wallet.balance =
              newBalance;

            wallet.updated_at =
              new Date();

            await wallet.save({
              session:
                dbSession
            });

            await WalletTransaction.create(
              [
                {
                  user_id:
                    freshOrder.user_id,

                  type:
                    'payment',

                  amount:
                    freshOrder.amount,

                  balance_after:
                    newBalance,

                  reference_type:
                    'payment',

                  reference_id:
                    String(
                      freshOrder._id
                    )
                }
              ],
              {
                session:
                  dbSession
              }
            );

            if (orderNo) {
              freshOrder.gateway_order_no =
                String(orderNo);
            }

            freshOrder.status =
              'paid';

            freshOrder.gateway_response =
              body;

            freshOrder.paid_at =
              new Date();

            freshOrder.updated_at =
              new Date();

            await freshOrder.save({
              session:
                dbSession
            });
          }
        );
      } finally {
        await dbSession.endSession();
      }

      return res.send('success');
    } catch (e) {
      console.error(
        'WATCHPAYS PAYIN CALLBACK ERROR:',
        e
      );

      return res.status(500).send(
        'callback processing failed'
      );
    }
  }
);

/* ======================================================
   REFERRAL
   ====================================================== */

app.get(
  '/api/referral',
  login,
  async (req, res) => {
    try {
      const u =
        await User.findById(
          req.session.userId
        ).select(
          'referral_code'
        );

      if (!u) {
        return res.status(401).json({
          message:
            'User not found.'
        });
      }

      const n =
        await User.countDocuments({
          referred_by:
            u.referral_code
        });

      return res.json({
        referralCode:
          u.referral_code,

        totalReferrals:
          n,

        activeReferrals:
          n
      });
    } catch (e) {
      console.error(
        'REFERRAL ERROR:',
        e
      );

      return res.status(500).json({
        message:
          'Unable to load referral data.'
      });
    }
  }
);

app.get(
  '/api/referrals',
  login,
  async (req, res) => {
    try {
      const u =
        await User.findById(
          req.session.userId
        ).select(
          'referral_code'
        );

      if (!u) {
        return res.status(401).json({
          message:
            'User not found.'
        });
      }

      const rows =
        await User.find({
          referred_by:
            u.referral_code
        })
          .select(
            '_id name phone referral_code created_at'
          )
          .sort({
            created_at: -1
          })
          .lean();

      return res.json({
        referrals:
          rows.map((x) => ({
            id: x._id,
            name: x.name,
            phone: x.phone,
            referral_code:
              x.referral_code,
            created_at:
              x.created_at
          }))
      });
    } catch (e) {
      console.error(
        'REFERRALS ERROR:',
        e
      );

      return res.status(500).json({
        message:
          'Unable to load referrals.'
      });
    }
  }
);

/* ======================================================
   ORDERS
   ====================================================== */

app.get(
  '/api/orders',
  login,
  async (req, res) => {
    try {
      const rows =
        await PaymentOrder.find({
          user_id:
            req.session.userId
        })
          .sort({
            created_at: -1
          })
          .limit(100)
          .lean();

      return res.json({
        orders:
          rows.map((x) => ({
            id: x._id,

            merchantOrderNo:
              x.merchant_order_no,

            gatewayOrderNo:
              x.gateway_order_no,

            amount:
              paiseToMoney(x.amount),

            status:
              x.status,

            paymentUrl:
              x.payment_url,

            createdAt:
              x.created_at,

            paidAt:
              x.paid_at
          }))
      });
    } catch (e) {
      console.error(
        'ORDERS ERROR:',
        e
      );

      return res.status(500).json({
        success: false,
        message:
          'Unable to load orders.'
      });
    }
  }
);

/* ======================================================
   WITHDRAWAL
   ====================================================== */

app.post(
  '/api/withdrawals',
  login,
  async (req, res) => {
    try {
      const uid =
        req.session.userId;

      const amount =
        Number(req.body.amount);

      const method =
        String(
          req.body.method || ''
        ).toUpperCase();

      if (
        !Number.isFinite(amount) ||
        amount < 50
      ) {
        return res.status(400).json({
          success: false,
          message:
            'Minimum withdrawal amount is ₹50.'
        });
      }

      const pa =
        moneyToPaise(amount);

      if (
        !pa ||
        pa <= 0
      ) {
        return res.status(400).json({
          success: false,
          message:
            'Invalid withdrawal amount.'
        });
      }

      if (
        !['UPI', 'BANK'].includes(
          method
        )
      ) {
        return res.status(400).json({
          success: false,
          message:
            'Please select a valid withdrawal method.'
        });
      }

      let upi = null;
      let name = null;
      let last4 = null;
      let accountNumber = null;
      let ifsc = null;
      let bankName = null;

      if (method === 'UPI') {
        upi =
          String(
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
        name =
          String(
            req.body.accountName || ''
          ).trim();

        accountNumber =
          String(
            req.body.accountNumber || ''
          ).trim();

        const confirmAccountNumber =
          String(
            req.body.confirmAccountNumber ||
              ''
          ).trim();

        if (
          name.length < 2 ||
          !/^[0-9]{9,18}$/.test(
            accountNumber
          ) ||
          accountNumber !==
            confirmAccountNumber
        ) {
          return res.status(400).json({
            success: false,
            message:
              'Please check bank details.'
          });
        }

        ifsc =
          String(
            req.body.ifsc || ''
          )
            .trim()
            .toUpperCase();

        if (
          !/^[A-Z]{4}0[A-Z0-9]{6}$/.test(
            ifsc
          )
        ) {
          return res.status(400).json({
            success: false,
            message:
              'Please enter a valid IFSC code.'
          });
        }

        bankName =
          String(
            req.body.bankName || ''
          ).trim();

        if (bankName.length < 2) {
          return res.status(400).json({
            success: false,
            message:
              'Please enter bank name.'
          });
        }

        last4 =
          accountNumber.slice(-4);
      }

      const dbSession =
        await mongoose.startSession();

      let result = null;

      try {
        await dbSession.withTransaction(
          async () => {
            const wallet =
              await Wallet.findOne({
                user_id: uid
              }).session(
                dbSession
              );

            if (
              !wallet ||
              Number(wallet.balance) < pa
            ) {
              result = {
                error:
                  'INSUFFICIENT',

                balance:
                  wallet
                    ? Number(
                        wallet.balance
                      )
                    : 0
              };

              return;
            }

            const payoutTransactionId =
              method === 'BANK'
                ? makePayoutTransactionId()
                : null;

            const created =
              await Withdrawal.create(
                [
                  {
                    user_id: uid,

                    amount: pa,

                    currency: 'INR',

                    method,

                    upi_id: upi,

                    account_name:
                      name,

                    account_last4:
                      last4,

                    account_number:
                      accountNumber,

                    ifsc,

                    bank_name:
                      bankName,

                    status:
                      method === 'BANK'
                        ? 'processing'
                        : 'pending',

                    payout_transaction_id:
                      payoutTransactionId
                  }
                ],
                {
                  session:
                    dbSession
                }
              );

            const newBalance =
              Number(wallet.balance) -
              pa;

            wallet.balance =
              newBalance;

            wallet.updated_at =
              new Date();

            await wallet.save({
              session:
                dbSession
            });

            await WalletTransaction.create(
              [
                {
                  user_id: uid,

                  type:
                    'withdrawal',

                  amount:
                    -pa,

                  balance_after:
                    newBalance,

                  reference_type:
                    'withdrawal',

                  reference_id:
                    String(
                      created[0]._id
                    )
                }
              ],
              {
                session:
                  dbSession
              }
            );

            result = {
              id:
                created[0]._id,

              transactionId:
                payoutTransactionId,

              balance:
                newBalance,

              method
            };
          }
        );
      } finally {
        await dbSession.endSession();
      }

      if (
        result &&
        result.error ===
          'INSUFFICIENT'
      ) {
        return res.status(400).json({
          success: false,

          message:
            'Insufficient wallet balance.',

          balance:
            paiseToMoney(
              result.balance
            )
        });
      }

      if (method === 'UPI') {
        return res.status(201).json({
          success: true,

          message:
            'UPI withdrawal submitted for manual processing.',

          withdrawalId:
            result.id,

          status:
            'pending',

          balance:
            paiseToMoney(
              result.balance
            )
        });
      }

      /* ==================================================
         BANK → WATCHPAYS PAYOUT
         ================================================== */

      if (
        !watchpaysConfiguredPayout()
      ) {
        await refundWithdrawal(
          result.id,
          'WatchPays payout is not configured.'
        );

        return res.status(503).json({
          success: false,

          message:
            'WatchPays payout is not configured. Amount has been refunded.'
        });
      }

      const withdrawal =
        await Withdrawal.findById(
          result.id
        );

      if (!withdrawal) {
        return res.status(500).json({
          success: false,
          message:
            'Withdrawal record was not found.'
        });
      }

      /*
       * IMPORTANT:
       * WatchPays docs example:
       * amount = 150
       *
       * Therefore we send 150 instead of 150.00
       * for whole-number INR amounts.
       */

      const payoutAmount =
        formatPayoutAmount(
          withdrawal.amount
        );

      const payoutSignature =
        createWatchPaysPayoutSignature({
          account_number:
            withdrawal.account_number,

          amount:
            payoutAmount,

          bank_name:
            withdrawal.bank_name,

          callback_url:
            WATCHPAYS_PAYOUT_CALLBACK_URL,

          ifsc:
            withdrawal.ifsc,

          merchant_id:
            WATCHPAYS_MERCHANT_ID,

          name:
            withdrawal.account_name,

          transaction_id:
            withdrawal.payout_transaction_id
        });

      const payoutBody =
        new URLSearchParams();

      payoutBody.set(
        'merchant_id',
        WATCHPAYS_MERCHANT_ID
      );

      payoutBody.set(
        'amount',
        payoutAmount
      );

      payoutBody.set(
        'transaction_id',
        withdrawal.payout_transaction_id
      );

      payoutBody.set(
        'account_number',
        withdrawal.account_number
      );

      payoutBody.set(
        'ifsc',
        withdrawal.ifsc
      );

      payoutBody.set(
        'name',
        withdrawal.account_name
      );

      payoutBody.set(
        'bank_name',
        withdrawal.bank_name
      );

      payoutBody.set(
        'callback_url',
        WATCHPAYS_PAYOUT_CALLBACK_URL
      );

      payoutBody.set(
        'signature',
        payoutSignature
      );

      let payoutResponse;

      try {
        payoutResponse =
          await watchpaysFetch(
            WATCHPAYS_PAYOUT_URL,
            {
              method: 'POST',

              headers: {
                'Content-Type':
                  'application/x-www-form-urlencoded',

                Accept:
                  'application/json'
              },

              body:
                payoutBody.toString()
            }
          );
      } catch (gatewayError) {
        console.error(
          'WATCHPAYS PAYOUT CONNECTION ERROR:',
          gatewayError
        );

        await refundWithdrawal(
          withdrawal._id,
          'WatchPays payout connection failed.'
        );

        return res.status(502).json({
          success: false,

          message:
            'WatchPays payout connection failed. Amount has been refunded.'
        });
      }

      const payoutParsed =
        await readJsonResponse(
          payoutResponse
        );

      const payoutData =
        payoutParsed.data;

      withdrawal.payout_response =
        payoutData ||
        payoutParsed.raw;

      /*
       * WatchPays success response:
       *
       * {
       *   "status": "success",
       *   "message": "Withdrawal request received",
       *   "data": {
       *      "transaction_id": "...",
       *      "amount": 150.00,
       *      "fee": 5.25,
       *      "total_amount": 155.25
       *   }
       * }
       */

      if (
        !payoutResponse.ok ||
        !payoutData ||
        String(
          payoutData.status || ''
        ).toLowerCase() !==
          'success'
      ) {
        withdrawal.status =
          'failed';

        withdrawal.processed_at =
          new Date();

        await withdrawal.save();

        await refundWithdrawal(
          withdrawal._id,
          'WatchPays rejected the payout.'
        );

        return res.status(502).json({
          success: false,

          message:
            payoutData?.message ||
            'WatchPays rejected the payout. Amount has been refunded.'
        });
      }

      const payoutInfo =
        payoutData.data || {};

      const returnedTransactionId =
        payoutInfo.transaction_id;

      if (
        returnedTransactionId &&
        String(
          returnedTransactionId
        ) !==
          String(
            withdrawal.payout_transaction_id
          )
      ) {
        console.error(
          'WATCHPAYS TRANSACTION ID MISMATCH',
          {
            local:
              withdrawal.payout_transaction_id,

            gateway:
              returnedTransactionId
          }
        );

        withdrawal.status =
          'failed';

        await withdrawal.save();

        await refundWithdrawal(
          withdrawal._id,
          'WatchPays transaction ID mismatch.'
        );

        return res.status(502).json({
          success: false,

          message:
            'WatchPays transaction ID mismatch. Amount has been refunded.'
        });
      }

      const gatewayAmountPaise =
        payoutInfo.amount !== undefined
          ? moneyToPaise(
              payoutInfo.amount
            )
          : withdrawal.amount;

      if (
        gatewayAmountPaise !==
        withdrawal.amount
      ) {
        withdrawal.status =
          'failed';

        await withdrawal.save();

        await refundWithdrawal(
          withdrawal._id,
          'WatchPays payout amount mismatch.'
        );

        return res.status(502).json({
          success: false,

          message:
            'WatchPays payout amount mismatch. Amount has been refunded.'
        });
      }

      const feePaise =
        moneyToPaise(
          payoutInfo.fee || 0
        ) || 0;

      const totalPaise =
        payoutInfo.total_amount !==
          undefined
          ? moneyToPaise(
              payoutInfo.total_amount
            )
          : withdrawal.amount +
            feePaise;

      withdrawal.payout_fee =
        feePaise;

      withdrawal.payout_total_amount =
        totalPaise || withdrawal.amount;

      withdrawal.status =
        'processing';

      await withdrawal.save();

      return res.status(201).json({
        success: true,

        message:
          'Withdrawal submitted to WatchPays.',

        withdrawalId:
          withdrawal._id,

        transactionId:
          withdrawal.payout_transaction_id,

        status:
          'processing',

        amount:
          paiseToMoney(
            withdrawal.amount
          ),

        fee:
          paiseToMoney(
            feePaise
          ),

        totalAmount:
          paiseToMoney(
            withdrawal.payout_total_amount
          ),

        balance:
          paiseToMoney(
            result.balance
          )
      });
    } catch (e) {
      console.error(
        'WITHDRAW ERROR:',
        e
      );

      return res.status(500).json({
        success: false,

        message:
          'Unable to submit withdrawal request.'
      });
    }
  }
);

/* ======================================================
   REFUND WITHDRAWAL
   ====================================================== */

async function refundWithdrawal(
  withdrawalId,
  reason
) {
  const dbSession =
    await mongoose.startSession();

  let result = null;

  try {
    await dbSession.withTransaction(
      async () => {
        const withdrawal =
          await Withdrawal.findById(
            withdrawalId
          ).session(
            dbSession
          );

        if (!withdrawal) {
          throw new Error(
            'Withdrawal not found.'
          );
        }

        if (
          withdrawal.status ===
            'rejected' ||
          withdrawal.status ===
            'refunded'
        ) {
          result = {
            refunded: false
          };

          return;
        }

        if (
          withdrawal.status ===
          'completed'
        ) {
          result = {
            refunded: false
          };

          return;
        }

        const wallet =
          (await Wallet.findOne({
            user_id:
              withdrawal.user_id
          }).session(
            dbSession
          )) ||
          new Wallet({
            user_id:
              withdrawal.user_id,

            balance: 0
          });

        const newBalance =
          Number(wallet.balance) +
          Number(withdrawal.amount);

        wallet.balance =
          newBalance;

        wallet.updated_at =
          new Date();

        await wallet.save({
          session:
            dbSession
        });

        await WalletTransaction.create(
          [
            {
              user_id:
                withdrawal.user_id,

              type:
                'withdrawal_refund',

              amount:
                withdrawal.amount,

              balance_after:
                newBalance,

              reference_type:
                'withdrawal',

              reference_id:
                String(
                  withdrawal._id
                )
            }
          ],
          {
            session:
              dbSession
          }
        );

        withdrawal.status =
          'rejected';

        withdrawal.payout_callback_status =
          reason || null;

        withdrawal.processed_at =
          new Date();

        await withdrawal.save({
          session:
            dbSession
        });

        result = {
          refunded: true,

          balance:
            newBalance,

          amount:
            withdrawal.amount
        };
      }
    );
  } finally {
    await dbSession.endSession();
  }

  return result;
}

/* ======================================================
   WATCHPAYS PAYOUT CALLBACK
   ====================================================== */

app.post(
  '/api/watchpays/payout-callback',
  async (req, res) => {
    try {
      const {
        merchant_id,
        transaction_id,
        amount,
        status,
        timestamp
      } = req.body || {};

      if (
        merchant_id === undefined ||
        !transaction_id ||
        amount === undefined ||
        amount === null ||
        !status
      ) {
        return res.status(400).send(
          'invalid callback'
        );
      }

      if (
        String(merchant_id) !==
        String(WATCHPAYS_MERCHANT_ID)
      ) {
        return res.status(400).send(
          'merchant mismatch'
        );
      }

      const withdrawal =
        await Withdrawal.findOne({
          payout_transaction_id:
            String(transaction_id)
        });

      if (!withdrawal) {
        return res.status(404).send(
          'transaction not found'
        );
      }

      const callbackPaise =
        moneyToPaise(amount);

      if (
        callbackPaise === null ||
        callbackPaise !==
          Number(withdrawal.amount)
      ) {
        return res.status(400).send(
          'amount mismatch'
        );
      }

      const normalizedStatus =
        String(status).toUpperCase();

      /*
       * Duplicate SUCCESS
       */
      if (
        withdrawal.status ===
          'completed' &&
        normalizedStatus ===
          'SUCCESS'
      ) {
        return res.send('success');
      }

      /*
       * Duplicate FAILED
       */
      if (
        withdrawal.status ===
          'rejected' &&
        normalizedStatus ===
          'FAILED'
      ) {
        return res.send('success');
      }

      withdrawal.payout_callback_status =
        normalizedStatus;

      withdrawal.payout_response = {
        ...(withdrawal.payout_response &&
        typeof withdrawal.payout_response ===
          'object'
          ? withdrawal.payout_response
          : {}),

        callback: req.body
      };

      if (
        normalizedStatus ===
        'SUCCESS'
      ) {
        withdrawal.status =
          'completed';

        withdrawal.processed_at =
          new Date();

        await withdrawal.save();

        return res.send('success');
      }

      if (
        normalizedStatus ===
        'FAILED'
      ) {
        await withdrawal.save();

        await refundWithdrawal(
          withdrawal._id,
          'WatchPays payout callback returned FAILED.'
        );

        return res.send('success');
      }

      /*
       * Unknown status:
       * save only, don't refund.
       */
      await withdrawal.save();

      return res.send('success');
    } catch (e) {
      console.error(
        'WATCHPAYS PAYOUT CALLBACK ERROR:',
        e
      );

      return res.status(500).send(
        'callback processing failed'
      );
    }
  }
);

/* ======================================================
   USER WITHDRAWAL HISTORY
   ====================================================== */

app.get(
  '/api/withdrawals',
  login,
  async (req, res) => {
    try {
      const rows =
        await Withdrawal.find({
          user_id:
            req.session.userId
        })
          .sort({
            created_at: -1
          })
          .lean();

      return res.json({
        success: true,

        withdrawals:
          rows.map((x) => ({
            id: x._id,

            amount:
              paiseToMoney(x.amount),

            currency:
              x.currency,

            method:
              x.method,

            destination:
              x.method === 'UPI'
                ? x.upi_id
                : x.account_last4
                ? '****' +
                  x.account_last4
                : null,

            accountName:
              x.account_name || null,

            ifsc:
              x.ifsc || null,

            bankName:
              x.bank_name || null,

            payoutTransactionId:
              x.payout_transaction_id ||
              null,

            payoutFee:
              paiseToMoney(
                x.payout_fee
              ),

            payoutTotalAmount:
              paiseToMoney(
                x.payout_total_amount
              ),

            status:
              x.status,

            createdAt:
              x.created_at,

            processedAt:
              x.processed_at || null
          }))
      });
    } catch (e) {
      console.error(
        'WITHDRAWAL HISTORY ERROR:',
        e
      );

      return res.status(500).json({
        success: false,

        message:
          'Unable to load withdrawal history.'
      });
    }
  }
);

/* ======================================================
   ADMIN USERS
   ====================================================== */

app.get(
  '/api/admin/users',
  admin,
  async (req, res) => {
    try {
      const users =
        await User.find()
          .select(
            '_id name phone referral_code referred_by created_at'
          )
          .sort({
            created_at: -1
          })
          .lean();

      const ids =
        users.map(
          (u) => u._id
        );

      const wallets =
        await Wallet.find({
          user_id: {
            $in: ids
          }
        }).lean();

      const balanceMap =
        new Map(
          wallets.map((w) => [
            String(w.user_id),
            Number(w.balance)
          ])
        );

      return res.json({
        success: true,

        users:
          users.map((x) => ({
            id: x._id,

            name: x.name,

            phone: x.phone,

            referral_code:
              x.referral_code,

            referred_by:
              x.referred_by,

            created_at:
              x.created_at,

            balance:
              paiseToMoney(
                balanceMap.get(
                  String(x._id)
                ) || 0
              )
          }))
      });
    } catch (e) {
      console.error(
        'ADMIN USERS ERROR:',
        e
      );

      return res.status(500).json({
        success: false,

        message:
          'Unable to load users.'
      });
    }
  }
);

/* ======================================================
   ADMIN BALANCE ADJUSTMENT
   ====================================================== */

app.post(
  '/api/admin/users/:id/balance',
  admin,
  async (req, res) => {
    try {
      const uid =
        req.params.id;

      const amount =
        Number(req.body.amount);

      const type =
        String(
          req.body.type ||
            'credit'
        ).toLowerCase();

      const reason =
        String(
          req.body.reason ||
            'Admin adjustment'
        ).trim();

      if (
        !mongoose.isValidObjectId(uid) ||
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
        !['credit', 'debit'].includes(
          type
        )
      ) {
        return res.status(400).json({
          success: false,
          message:
            'Invalid balance adjustment type.'
        });
      }

      const u =
        await User.findById(uid)
          .select(
            '_id name phone'
          );

      if (!u) {
        return res.status(404).json({
          success: false,
          message:
            'User not found.'
        });
      }

      const pa =
        moneyToPaise(amount);

      const delta =
        type === 'debit'
          ? -pa
          : pa;

      const dbSession =
        await mongoose.startSession();

      let result = null;

      try {
        await dbSession.withTransaction(
          async () => {
            const w =
              (await Wallet.findOne({
                user_id: uid
              }).session(
                dbSession
              )) ||
              new Wallet({
                user_id: uid,
                balance: 0
              });

            const oldBalance =
              Number(w.balance);

            const newBalance =
              oldBalance + delta;

            if (newBalance < 0) {
              result = {
                error: 'NEGATIVE',
                old: oldBalance
              };

              return;
            }

            w.balance =
              newBalance;

            w.updated_at =
              new Date();

            await w.save({
              session:
                dbSession
            });

            await WalletTransaction.create(
              [
                {
                  user_id: uid,

                  type:
                    'admin_adjustment',

                  amount:
                    delta,

                  balance_after:
                    newBalance,

                  reference_type:
                    'admin',

                  reference_id:
                    'admin_' +
                    Date.now() +
                    '_' +
                    crypto
                      .randomBytes(3)
                      .toString('hex')
                }
              ],
              {
                session:
                  dbSession
              }
            );

            result = {
              old:
                oldBalance,

              nb:
                newBalance
            };
          }
        );
      } finally {
        await dbSession.endSession();
      }

      if (
        result.error ===
        'NEGATIVE'
      ) {
        return res.status(400).json({
          success: false,

          message:
            'Balance cannot go below zero.',

          balance:
            paiseToMoney(
              result.old
            )
        });
      }

      return res.json({
        success: true,

        message:
          'User wallet updated.',

        user: u,

        type,

        reason,

        oldBalance:
          paiseToMoney(
            result.old
          ),

        newBalance:
          paiseToMoney(
            result.nb
          )
      });
    } catch (e) {
      console.error(
        'ADMIN BALANCE ERROR:',
        e
      );

      return res.status(500).json({
        success: false,

        message:
          'Unable to update user balance.'
      });
    }
  }
);

/* ======================================================
   ADMIN WITHDRAWALS
   ====================================================== */

async function getAdminWithdrawals() {
  const rows =
    await Withdrawal.find()
      .sort({
        created_at: -1
      })
      .lean();

  const ids =
    rows.map(
      (x) => x.user_id
    );

  const users =
    await User.find({
      _id: {
        $in: ids
      }
    })
      .select(
        '_id name phone'
      )
      .lean();

  const userMap =
    new Map(
      users.map((u) => [
        String(u._id),
        u
      ])
    );

  return rows.map((x) => {
    const u =
      userMap.get(
        String(x.user_id)
      );

    return {
      id: x._id,

      userId:
        x.user_id,

      name:
        u ? u.name : '',

      phone:
        u ? u.phone : '',

      amount:
        paiseToMoney(x.amount),

      currency:
        x.currency,

      method:
        x.method,

      destination:
        x.method === 'UPI'
          ? x.upi_id
          : x.account_last4
          ? '****' +
            x.account_last4
          : null,

      accountName:
        x.account_name || null,

      ifsc:
        x.ifsc || null,

      bankName:
        x.bank_name || null,

      payoutTransactionId:
        x.payout_transaction_id ||
        null,

      payoutFee:
        paiseToMoney(
          x.payout_fee
        ),

      payoutTotalAmount:
        paiseToMoney(
          x.payout_total_amount
        ),

      status:
        x.status,

      createdAt:
        x.created_at,

      processedAt:
        x.processed_at || null
    };
  });
}

app.get(
  '/api/admin/withdrawals',
  admin,
  async (req, res) => {
    try {
      return res.json({
        success: true,

        withdrawals:
          await getAdminWithdrawals()
      });
    } catch (e) {
      console.error(
        'ADMIN WITHDRAWALS ERROR:',
        e
      );

      return res.status(500).json({
        success: false,

        message:
          'Unable to load withdrawals.'
      });
    }
  }
);

/* ======================================================
   ADMIN PROCESSING
   ====================================================== */

app.post(
  '/api/admin/withdrawals/:id/processing',
  admin,
  async (req, res) => {
    try {
      const id =
        req.params.id;

      if (
        !mongoose.isValidObjectId(id)
      ) {
        return res.status(400).json({
          success: false,
          message:
            'Invalid withdrawal ID.'
        });
      }

      const w =
        await Withdrawal.findById(id);

      if (!w) {
        return res.status(404).json({
          success: false,
          message:
            'Withdrawal not found.'
        });
      }

      if (
        ![
          'pending',
          'processing'
        ].includes(w.status)
      ) {
        return res.status(409).json({
          success: false,
          message:
            'Withdrawal is already ' +
            w.status +
            '.'
        });
      }

      w.status =
        'processing';

      await w.save();

      return res.json({
        success: true,

        message:
          'Withdrawal moved to Processing.',

        status:
          'processing'
      });
    } catch (e) {
      console.error(
        'PROCESS WITHDRAWAL ERROR:',
        e
      );

      return res.status(500).json({
        success: false,

        message:
          'Unable to process withdrawal.'
      });
    }
  }
);

/* ======================================================
   ADMIN COMPLETE
   ====================================================== */

app.post(
  '/api/admin/withdrawals/:id/complete',
  admin,
  async (req, res) => {
    try {
      const id =
        req.params.id;

      if (
        !mongoose.isValidObjectId(id)
      ) {
        return res.status(400).json({
          success: false,
          message:
            'Invalid withdrawal ID.'
        });
      }

      const w =
        await Withdrawal.findById(id);

      if (!w) {
        return res.status(404).json({
          success: false,
          message:
            'Withdrawal not found.'
        });
      }

      if (
        ![
          'pending',
          'processing'
        ].includes(w.status)
      ) {
        return res.status(409).json({
          success: false,
          message:
            'Withdrawal is already ' +
            w.status +
            '.'
        });
      }

      w.status =
        'completed';

      w.processed_at =
        new Date();

      await w.save();

      return res.json({
        success: true,

        message:
          'Withdrawal marked as completed.',

        note:
          'This does not send money; it only records completion.',

        amount:
          paiseToMoney(
            w.amount
          )
      });
    } catch (e) {
      console.error(
        'COMPLETE WITHDRAWAL ERROR:',
        e
      );

      return res.status(500).json({
        success: false,

        message:
          'Unable to complete withdrawal.'
      });
    }
  }
);

/* ======================================================
   ADMIN REJECT
   ====================================================== */

app.post(
  '/api/admin/withdrawals/:id/reject',
  admin,
  async (req, res) => {
    try {
      const id =
        req.params.id;

      if (
        !mongoose.isValidObjectId(id)
      ) {
        return res.status(400).json({
          success: false,
          message:
            'Invalid withdrawal ID.'
        });
      }

      const result =
        await refundWithdrawal(
          id,
          'Rejected by admin.'
        );

      if (
        !result ||
        !result.refunded
      ) {
        const current =
          await Withdrawal.findById(id);

        if (!current) {
          return res.status(404).json({
            success: false,
            message:
              'Withdrawal not found.'
          });
        }

        return res.status(409).json({
          success: false,
          message:
            'Withdrawal is already ' +
            current.status +
            '.'
        });
      }

      return res.json({
        success: true,

        message:
          'Withdrawal rejected and balance refunded.',

        refundedAmount:
          paiseToMoney(
            result.amount
          ),

        newBalance:
          paiseToMoney(
            result.balance
          )
      });
    } catch (e) {
      console.error(
        'REJECT WITHDRAWAL ERROR:',
        e
      );

      return res.status(500).json({
        success: false,

        message:
          'Unable to reject withdrawal.'
      });
    }
  }
);

/* ======================================================
   OLD ADMIN ACTION
   ====================================================== */

app.post(
  '/api/admin/withdrawals/:id/action',
  admin,
  async (req, res) => {
    try {
      const action =
        String(
          req.body.action || ''
        ).toLowerCase();

      const id =
        req.params.id;

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

      if (
        !mongoose.isValidObjectId(id)
      ) {
        return res.status(400).json({
          success: false,
          message:
            'Invalid withdrawal ID.'
        });
      }

      if (action === 'paid') {
        const w =
          await Withdrawal.findById(id);

        if (!w) {
          return res.status(404).json({
            success: false,
            message:
              'Withdrawal not found.'
          });
        }

        if (
          ![
            'pending',
            'processing'
          ].includes(w.status)
        ) {
          return res.status(409).json({
            success: false,
            message:
              'Withdrawal is already ' +
              w.status +
              '.'
          });
        }

        w.status =
          'completed';

        w.processed_at =
          new Date();

        await w.save();

        return res.json({
          success: true,

          message:
            'Withdrawal marked as completed.',

          note:
            'This endpoint does not send money.',

          amount:
            paiseToMoney(
              w.amount
            )
        });
      }

      const result =
        await refundWithdrawal(
          id,
          'Rejected by admin.'
        );

      if (
        !result ||
        !result.refunded
      ) {
        const current =
          await Withdrawal.findById(id);

        if (!current) {
          return res.status(404).json({
            success: false,
            message:
              'Withdrawal not found.'
          });
        }

        return res.status(409).json({
          success: false,
          message:
            'Withdrawal is already ' +
            current.status +
            '.'
        });
      }

      return res.json({
        success: true,

        message:
          'Withdrawal rejected and balance refunded.',

        refundedAmount:
          paiseToMoney(
            result.amount
          ),

        newBalance:
          paiseToMoney(
            result.balance
          )
      });
    } catch (e) {
      console.error(
        'ADMIN ACTION ERROR:',
        e
      );

      return res.status(500).json({
        success: false,

        message:
          'Unable to process withdrawal.'
      });
    }
  }
);

/* ======================================================
   ADMIN PAYMENTS
   ====================================================== */

app.get(
  '/api/admin/payments',
  admin,
  async (req, res) => {
    try {
      const rows =
        await PaymentOrder.find()
          .sort({
            created_at: -1
          })
          .limit(500)
          .lean();

      const ids =
        rows.map(
          (x) => x.user_id
        );

      const users =
        await User.find({
          _id: {
            $in: ids
          }
        })
          .select(
            '_id name phone'
          )
          .lean();

      const userMap =
        new Map(
          users.map((u) => [
            String(u._id),
            u
          ])
        );

      return res.json({
        success: true,

        payments:
          rows.map((x) => {
            const u =
              userMap.get(
                String(x.user_id)
              );

            return {
              id: x._id,

              userId:
                x.user_id,

              name:
                u?.name || '',

              phone:
                u?.phone || '',

              merchantOrderNo:
                x.merchant_order_no,

              gatewayOrderNo:
                x.gateway_order_no,

              amount:
                paiseToMoney(
                  x.amount
                ),

              currency:
                x.currency,

              status:
                x.status,

              paymentUrl:
                x.payment_url,

              createdAt:
                x.created_at,

              paidAt:
                x.paid_at
            };
          })
      });
    } catch (e) {
      console.error(
        'ADMIN PAYMENTS ERROR:',
        e
      );

      return res.status(500).json({
        success: false,

        message:
          'Unable to load payments.'
      });
    }
  }
);

/* ======================================================
   ADMIN SUMMARY
   ====================================================== */

app.get(
  '/api/admin/summary',
  admin,
  async (req, res) => {
    try {
      const [
        totalUsers,
        balanceAgg,
        withdrawalsAgg,
        pendingWithdrawals,
        paymentsAgg
      ] =
        await Promise.all([
          User.countDocuments(),

          Wallet.aggregate([
            {
              $group: {
                _id: null,

                total: {
                  $sum:
                    '$balance'
                }
              }
            }
          ]),

          Withdrawal.aggregate([
            {
              $match: {
                status:
                  'completed'
              }
            },

            {
              $group: {
                _id: null,

                total: {
                  $sum:
                    '$amount'
                }
              }
            }
          ]),

          Withdrawal.countDocuments({
            status: {
              $in: [
                'pending',
                'processing'
              ]
            }
          }),

          PaymentOrder.aggregate([
            {
              $match: {
                status:
                  'paid'
              }
            },

            {
              $group: {
                _id: null,

                total: {
                  $sum:
                    '$amount'
                }
              }
            }
          ])
        ]);

      return res.json({
        success: true,

        totalUsers:
          Number(totalUsers),

        totalBalance:
          paiseToMoney(
            balanceAgg[0]?.total || 0
          ),

        totalWithdrawals:
          paiseToMoney(
            withdrawalsAgg[0]?.total || 0
          ),

        pendingWithdrawals:
          Number(
            pendingWithdrawals
          ),

        totalPayments:
          paiseToMoney(
            paymentsAgg[0]?.total || 0
          )
      });
    } catch (e) {
      console.error(
        'ADMIN SUMMARY ERROR:',
        e
      );

      return res.status(500).json({
        success: false,

        message:
          'Unable to load admin summary.'
      });
    }
  }
);

/* ======================================================
   ADMIN TOTAL USERS
   ====================================================== */

app.get(
  '/api/admin/total-users',
  admin,
  async (req, res) => {
    try {
      const total =
        await User.countDocuments();

      return res.json({
        success: true,

        totalUsers:
          Number(total)
      });
    } catch (e) {
      console.error(
        'TOTAL USERS ERROR:',
        e
      );

      return res.status(500).json({
        success: false,

        message:
          'Unable to load total users.'
      });
    }
  }
);

/* ======================================================
   LOGOUT
   ====================================================== */

app.post(
  '/api/logout',
  (req, res) => {
    req.session.destroy(() => {
      res.clearCookie(
        'truewalk.sid'
      );

      res.json({
        message:
          'Logout successful.'
      });
    });
  }
);

/* ======================================================
   STATIC FILES
   ====================================================== */

app.use(
  express.static(__dirname)
);

app.get(
  '/',
  (req, res) => {
    res.sendFile(
      path.join(
        __dirname,
        'index.html'
      )
    );
  }
);

/* ======================================================
   ERROR HANDLER
   ====================================================== */

app.use(
  (err, req, res, next) => {
    console.error(
      'UNHANDLED ERROR:',
      err
    );

    res.status(500).json({
      success: false,

      message:
        'Internal server error.'
    });
  }
);

/* ======================================================
   START SERVER
   ====================================================== */

async function startServer() {
  try {
    await mongoose.connect(
      MONGO_URI,
      {
        serverSelectionTimeoutMS:
          10000
      }
    );

    console.log(
      'MongoDB connected successfully.'
    );

    console.log(
      'Payment gateway: WATCHPAYS'
    );

    console.log(
      'WatchPays Pay-in:',
      WATCHPAYS_PAYIN_URL
    );

    console.log(
      'WatchPays Payout:',
      WATCHPAYS_PAYOUT_URL
    );

    console.log(
      'Pay-in configured:',
      watchpaysConfiguredPayin()
    );

    console.log(
      'Payout configured:',
      watchpaysConfiguredPayout()
    );

    app.listen(
      PORT,
      () => {
        console.log(
          `TRUE WALK server running on port ${PORT}`
        );
      }
    );
  } catch (err) {
    console.error(
      'MongoDB connection failed:',
      err
    );

    process.exit(1);
  }
}

startServer();
