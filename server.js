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
   ENVIRONMENT
   ====================================================== */

const MONGO_URI =
  process.env.MONGODB_URI || process.env.MONGO_URI;

const RSPAY_API_URL =
  process.env.RSPAY_API_URL ||
  'https://rspayment.shop/api.php';

const RSPAY_WITHDRAW_URL =
  process.env.RSPAY_WITHDRAW_URL ||
  'https://rspayment.shop/withdraw_api.php';

const RSPAY_MERCHANT_ID =
  process.env.RSPAY_MERCHANT_ID ||
  'INR18155';

const RSPAY_ACCESS_KEY =
  process.env.RSPAY_ACCESS_KEY || '';

const APP_BASE_URL =
  process.env.APP_BASE_URL ||
  '';

if (!MONGO_URI) {
  console.error(
    'ERROR: MONGODB_URI (or MONGO_URI) is not configured.'
  );
  process.exit(1);
}

/* ======================================================
   MONGOOSE SCHEMAS
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

    // Stored in paise
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

/* ======================================================
   PAYMENT
   ====================================================== */

const paymentSchema = new mongoose.Schema(
  {
    user_id: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      index: true
    },

    plan: {
      type: String,
      default: null
    },

    amount: {
      type: Number,
      required: true
    },

    currency: {
      type: String,
      default: 'INR'
    },

    merchant_order_id: {
      type: String,
      unique: true,
      sparse: true,
      index: true
    },

    platform_order_id: {
      type: String,
      default: null
    },

    payment_url: {
      type: String,
      default: null
    },

    status: {
      type: String,
      default: 'created',
      index: true
    },

    gateway_response: {
      type: mongoose.Schema.Types.Mixed,
      default: null
    },

    created_at: {
      type: Date,
      default: Date.now
    },

    paid_at: {
      type: Date,
      default: null
    }
  },
  {
    versionKey: false
  }
);

/* ======================================================
   WITHDRAWAL
   ====================================================== */

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

    ifsc: String,

    gateway_withdrawal_id: {
      type: String,
      default: null
    },

    wallet_deducted: {
      type: Number,
      default: 0
    },

    status: {
      type: String,
      default: 'pending',
      index: true
    },

    gateway_response: {
      type: mongoose.Schema.Types.Mixed,
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

const User = mongoose.model('User', userSchema);
const Wallet = mongoose.model('Wallet', walletSchema);
const WalletTransaction =
  mongoose.model(
    'WalletTransaction',
    walletTransactionSchema
  );

const Payment = mongoose.model(
  'Payment',
  paymentSchema
);

const Withdrawal = mongoose.model(
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
      'CHANGE_THIS_SESSION_SECRET',

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

const hash = (password, salt) =>
  crypto
    .scryptSync(
      String(password),
      salt,
      64
    )
    .toString('hex');

const makeRef = () =>
  'TW' +
  crypto
    .randomBytes(8)
    .toString('hex')
    .toUpperCase();

const makeOrderId = () =>
  'TW' +
  Date.now() +
  crypto
    .randomBytes(4)
    .toString('hex')
    .toUpperCase();

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

function getBaseUrl(req) {
  if (APP_BASE_URL) {
    return APP_BASE_URL.replace(/\/$/, '');
  }

  const forwardedProto =
    req.headers['x-forwarded-proto'];

  const protocol =
    forwardedProto || req.protocol;

  const host = req.get('host');

  return `${protocol}://${host}`;
}

/* ======================================================
   RSPAY PAYMENT LINK
   ====================================================== */

function buildRspayUrl({
  amount,
  orderId,
  webhookUrl,
  returnUrl,
  ext
}) {
  const params = new URLSearchParams();

  params.set(
    'amount',
    String(amount)
  );

  // FIXED MERCHANT ID
  params.set(
    'user_id',
    RSPAY_MERCHANT_ID
  );

  params.set(
    'order_id',
    orderId
  );

  params.set(
    'ext',
    ext || 'TrueWalk'
  );

  params.set(
    'webhook_url',
    webhookUrl
  );

  params.set(
    'return_url',
    returnUrl
  );

  return `${RSPAY_API_URL}?${params.toString()}`;
}

/* ======================================================
   HOME
   ====================================================== */

app.get('/home.html', (req, res) => {
  if (!req.session.userId) {
    return res.redirect('/login.html');
  }

  res.sendFile(
    path.join(__dirname, 'home.html')
  );
});

/* ======================================================
   ADMIN LOGIN
   ====================================================== */

app.post('/api/admin/login', (req, res) => {
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
        'Admin credentials are not configured in Render Environment Variables.'
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

  req.session.regenerate((err) => {
    if (err) {
      return res.status(500).json({
        message:
          'Admin login failed.'
      });
    }

    req.session.isAdmin = true;

    req.session.save((saveErr) => {
      if (saveErr) {
        return res.status(500).json({
          message:
            'Admin session could not be saved.'
        });
      }

      res.json({
        success: true,
        message:
          'Admin login successful.'
      });
    });
  });
});

app.post(
  '/api/admin/logout',
  admin,
  (req, res) => {
    req.session.destroy(() => {
      res.clearCookie(
        'truewalk.sid'
      );

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

app.post('/api/register', async (req, res) => {
  try {
    const {
      name,
      phone,
      password,
      referralCode
    } = req.body;

    if (
      !name ||
      !phone ||
      !password
    ) {
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

    if (
      String(password).length < 6
    ) {
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
      const code =
        String(referralCode)
          .trim()
          .toUpperCase();

      const refUser =
        await User.findOne({
          referral_code: code
        }).lean();

      if (!refUser) {
        return res.status(400).json({
          message:
            'Invalid referral code.'
        });
      }

      referredBy = code;
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
      hash(
        password,
        salt
      );

    const user =
      await User.create({
        name:
          String(name).trim(),

        phone: ph,

        salt,

        password_hash:
          passwordHash,

        referral_code: rc,

        referred_by:
          referredBy
      });

    await ensureWallet(
      user._id
    );

    return res.status(201).json({
      message:
        'Registration successful.',

      userId:
        user._id,

      referralCode:
        rc
    });
  } catch (e) {
    console.error(
      'REGISTER ERROR:',
      e
    );

    if (e && e.code === 11000) {
      return res.status(409).json({
        message:
          'This mobile number or referral code is already registered.'
      });
    }

    return res.status(500).json({
      message:
        'Registration failed.'
    });
  }
});

/* ======================================================
   LOGIN
   ====================================================== */

app.post('/api/login', async (req, res) => {
  try {
    const {
      phone,
      password
    } = req.body;

    const u =
      await User.findOne({
        phone:
          String(phone || '')
            .trim()
      });

    if (
      !u ||
      hash(
        password,
        u.salt
      ) !== u.password_hash
    ) {
      return res.status(401).json({
        message:
          'Invalid mobile number or password.'
      });
    }

    await ensureWallet(
      u._id
    );

    req.session.regenerate(
      (err) => {
        if (err) {
          console.error(
            'SESSION REGENERATE ERROR:',
            err
          );

          return res.status(500).json({
            message:
              'Login failed.'
          });
        }

        req.session.userId =
          String(u._id);

        req.session.isAdmin =
          false;

        req.session.save(
          (saveErr) => {
            if (saveErr) {
              console.error(
                'SESSION SAVE ERROR:',
                saveErr
              );

              return res.status(500).json({
                message:
                  'Login session could not be saved.'
              });
            }

            return res.json({
              message:
                'Login successful.',

              user:
                safeUser(u)
            });
          }
        );
      }
    );
  } catch (e) {
    console.error(
      'LOGIN ERROR:',
      e
    );

    return res.status(500).json({
      message:
        'Login failed.'
    });
  }
});

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
        await ensureWallet(
          u._id
        );

      return res.json({
        user: {
          id: u._id,
          name: u.name,
          phone: u.phone,
          referral_code:
            u.referral_code
        },

        balance:
          Number(w.balance) / 100
      });
    } catch (e) {
      console.error(
        'ME ERROR:',
        e
      );

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
        await WalletTransaction
          .find({
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
          Number(w.balance) / 100,

        updatedAt:
          w.updated_at,

        transactions:
          t.map((x) => ({
            ...x,

            id: x._id,

            amount:
              Number(x.amount) / 100,

            balanceAfter:
              Number(
                x.balance_after
              ) / 100
          }))
      });
    } catch (e) {
      console.error(
        'WALLET ERROR:',
        e
      );

      return res.status(500).json({
        message:
          'Unable to load wallet.'
      });
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

        totalReferrals: n,

        activeReferrals: n
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
   RSPAY CREATE PAYMENT
   ====================================================== */

app.post(
  '/api/payment/create-order',
  login,
  async (req, res) => {
    try {
      const amount =
        Number(req.body.amount);

      if (
        !Number.isFinite(amount) ||
        amount < 200
      ) {
        return res.status(400).json({
          success: false,

          message:
            'Minimum payment amount is ₹200.'
        });
      }

      if (
        !RSPAY_MERCHANT_ID
      ) {
        return res.status(503).json({
          success: false,

          message:
            'RSPay Merchant ID is not configured.'
        });
      }

      const orderId =
        makeOrderId();

      const baseUrl =
        getBaseUrl(req);

      const webhookUrl =
        `${baseUrl}/api/payment/webhook`;

      const returnUrl =
        `${baseUrl}/payment-success.html`;

      const payUrl =
        buildRspayUrl({
          amount:
            Math.round(amount * 100) / 100,

          orderId,

          webhookUrl,

          returnUrl,

          ext:
            req.body.plan ||
            'TrueWalk'
        });

      const payment =
        await Payment.create({
          user_id:
            req.session.userId,

          plan:
            req.body.plan ||
            null,

          amount:
            Math.round(
              amount * 100
            ),

          currency:
            'INR',

          merchant_order_id:
            orderId,

          payment_url:
            payUrl,

          status:
            'created'
        });

      return res.json({
        success: true,

        orderId:
          orderId,

        amount:
          amount,

        currency:
          'INR',

        payUrl:
          payUrl,

        paymentId:
          payment._id
      });
    } catch (e) {
      console.error(
        'RSPAY CREATE ORDER ERROR:',
        e
      );

      return res.status(500).json({
        success: false,

        message:
          'Unable to create payment order.'
      });
    }
  }
);

/* ======================================================
   RSPAY WEBHOOK
   ====================================================== */

app.post(
  '/api/payment/webhook',
  async (req, res) => {
    try {
      console.log(
        'RSPAY WEBHOOK:',
        req.body
      );

      const data =
        req.body || {};

      const status =
        String(
          data.status || ''
        ).toLowerCase();

      const merchantOrderId =
        String(
          data.merchant_order_id ||
          data.order_id ||
          ''
        ).trim();

      const merchantId =
        String(
          data.user_id || ''
        ).trim();

      const amount =
        Number(
          data.amount || 0
        );

      if (
        status !== 'success' ||
        !merchantOrderId
      ) {
        return res
          .status(400)
          .send('INVALID_REQUEST');
      }

      /*
       * Make sure the webhook belongs
       * to our merchant account.
       */
      if (
        merchantId &&
        merchantId !==
          RSPAY_MERCHANT_ID
      ) {
        console.error(
          'Invalid RSPay merchant ID:',
          merchantId
        );

        return res
          .status(403)
          .send('INVALID_MERCHANT');
      }

      const payment =
        await Payment.findOne({
          merchant_order_id:
            merchantOrderId
        });

      if (!payment) {
        return res
          .status(404)
          .send('ORDER_NOT_FOUND');
      }

      /*
       * Verify amount.
       *
       * Payment amount is stored in paise.
       */
      if (
        amount > 0 &&
        Math.round(
          amount * 100
        ) !==
          Number(payment.amount)
      ) {
        console.error(
          'RSPay amount mismatch',
          {
            expected:
              payment.amount / 100,

            received:
              amount
          }
        );

        return res
          .status(400)
          .send('AMOUNT_MISMATCH');
      }

      /*
       * Idempotency:
       * If already credited, do nothing again.
       */
      if (
        payment.status ===
        'captured'
      ) {
        return res.send('SUCCESS');
      }

      const dbSession =
        await mongoose.startSession();

      try {
        await dbSession.withTransaction(
          async () => {
            const currentPayment =
              await Payment.findById(
                payment._id
              ).session(
                dbSession
              );

            if (
              !currentPayment ||
              currentPayment.status ===
                'captured'
            ) {
              return;
            }

            let wallet =
              await Wallet.findOne({
                user_id:
                  currentPayment.user_id
              }).session(
                dbSession
              );

            if (!wallet) {
              wallet =
                new Wallet({
                  user_id:
                    currentPayment.user_id,

                  balance: 0
                });
            }

            const newBalance =
              Number(
                wallet.balance
              ) +
              Number(
                currentPayment.amount
              );

            wallet.balance =
              newBalance;

            wallet.updated_at =
              new Date();

            await wallet.save({
              session:
                dbSession
            });

            const existingTx =
              await WalletTransaction
                .findOne({
                  type:
                    'deposit',

                  reference_type:
                    'payment',

                  reference_id:
                    String(
                      currentPayment._id
                    )
                })
                .session(
                  dbSession
                );

            if (!existingTx) {
              await WalletTransaction.create(
                [
                  {
                    user_id:
                      currentPayment.user_id,

                    type:
                      'deposit',

                    amount:
                      currentPayment.amount,

                    balance_after:
                      newBalance,

                    reference_type:
                      'payment',

                    reference_id:
                      String(
                        currentPayment._id
                      )
                  }
                ],
                {
                  session:
                    dbSession
                }
              );
            }

            currentPayment.status =
              'captured';

            currentPayment.paid_at =
              new Date();

            currentPayment.gateway_response =
              data;

            await currentPayment.save({
              session:
                dbSession
            });
          }
        );
      } finally {
        await dbSession.endSession();
      }

      return res.send(
        'SUCCESS'
      );
    } catch (e) {
      console.error(
        'RSPAY WEBHOOK ERROR:',
        e
      );

      return res
        .status(500)
        .send('SERVER_ERROR');
    }
  }
);

/* ======================================================
   PAYMENT SUCCESS PAGE
   ====================================================== */

app.get(
  '/payment-success.html',
  (req, res) => {
    res.sendFile(
      path.join(
        __dirname,
        'payment-success.html'
      )
    );
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
        await Payment.find({
          user_id:
            req.session.userId
        })
          .sort({
            created_at: -1
          })
          .lean();

      return res.json({
        orders:
          rows.map((x) => ({
            ...x,

            id: x._id,

            amount:
              Number(x.amount) / 100
          }))
      });
    } catch (e) {
      console.error(
        'ORDERS ERROR:',
        e
      );

      return res.status(500).json({
        message:
          'Unable to load orders.'
      });
    }
  }
);

/* ======================================================
   RSPAY WITHDRAW
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

      if (
        !RSPAY_ACCESS_KEY
      ) {
        return res.status(503).json({
          success: false,

          message:
            'RSPay access key is not configured.'
        });
      }

      const method =
        String(
          req.body.method || 'BANK'
        ).toUpperCase();

      if (
        method !== 'BANK'
      ) {
        return res.status(400).json({
          success: false,

          message:
            'RSPay withdrawal API currently requires bank account details.'
        });
      }

      const accountName =
        String(
          req.body.accountName || ''
        ).trim();

      const accountNumber =
        String(
          req.body.accountNumber || ''
        ).trim();

      const confirmAccountNumber =
        String(
          req.body.confirmAccountNumber || ''
        ).trim();

      const ifsc =
        String(
          req.body.ifsc || ''
        )
          .trim()
          .toUpperCase();

      if (
        accountName.length < 2 ||
        !/^\d{9,18}$/.test(
          accountNumber
        ) ||
        accountNumber !==
          confirmAccountNumber
      ) {
        return res.status(400).json({
          success: false,

          message:
            'Please check bank account details.'
        });
      }

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

      /*
       * RSPay formula supplied by you:
       *
       * wallet deduction =
       * round((amount + 3) / 0.85, 2)
       */
      const walletDeducted =
        Math.round(
          ((amount + 3) / 0.85) *
            100
        ) / 100;

      const walletDeductedPaise =
        Math.round(
          walletDeducted * 100
        );

      const dbSession =
        await mongoose.startSession();

      let reserveResult = null;

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
              Number(wallet.balance) <
                walletDeductedPaise
            ) {
              reserveResult = {
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

            const withdrawal =
              await Withdrawal.create(
                [
                  {
                    user_id:
                      uid,

                    amount:
                      Math.round(
                        amount * 100
                      ),

                    currency:
                      'INR',

                    method:
                      'BANK',

                    account_name:
                      accountName,

                    account_last4:
                      accountNumber.slice(
                        -4
                      ),

                    ifsc,

                    wallet_deducted:
                      walletDeductedPaise,

                    status:
                      'reserved'
                  }
                ],
                {
                  session:
                    dbSession
                }
              );

            const newBalance =
              Number(
                wallet.balance
              ) -
              walletDeductedPaise;

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
                    uid,

                  type:
                    'withdrawal',

                  amount:
                    -walletDeductedPaise,

                  balance_after:
                    newBalance,

                  reference_type:
                    'withdrawal',

                  reference_id:
                    String(
                      withdrawal[0]._id
                    )
                }
              ],
              {
                session:
                  dbSession
              }
            );

            reserveResult = {
              id:
                withdrawal[0]._id,

              balance:
                newBalance
            };
          }
        );
      } finally {
        await dbSession.endSession();
      }

      if (
        reserveResult &&
        reserveResult.error ===
          'INSUFFICIENT'
      ) {
        return res.status(400).json({
          success: false,

          message:
            `Insufficient wallet balance. You need ₹${walletDeducted.toFixed(
              2
            )} in wallet.`,

          balance:
            reserveResult.balance /
            100,

          requiredBalance:
            walletDeducted
        });
      }

      /*
       * Send withdrawal to RSPay.
       *
       * accesskey stays server-side.
       */
      const payload = {
        user_id:
          RSPAY_MERCHANT_ID,

        amount:
          amount,

        accesskey:
          RSPAY_ACCESS_KEY,

        account_name:
          accountName,

        account_number:
          accountNumber,

        ifsc:
          ifsc
      };

      let gatewayResult;

      try {
        const gatewayResponse =
          await fetch(
            RSPAY_WITHDRAW_URL,
            {
              method:
                'POST',

              headers: {
                'Content-Type':
                  'application/json',

                Accept:
                  'application/json'
              },

              body:
                JSON.stringify(
                  payload
                )
            }
          );

        const text =
          await gatewayResponse.text();

        try {
          gatewayResult =
            JSON.parse(text);
        } catch {
          gatewayResult = {
            status:
              gatewayResponse.ok
                ? 'success'
                : 'error',

            message:
              text
          };
        }
      } catch (gatewayError) {
        console.error(
          'RSPAY WITHDRAW REQUEST ERROR:',
          gatewayError
        );

        /*
         * Gateway request failed.
         * Refund reserved amount.
         */
        await refundWithdrawal(
          reserveResult.id,
          'Gateway request failed.'
        );

        return res.status(502).json({
          success: false,

          message:
            'RSPay withdrawal service could not be reached.'
        });
      }

      if (
        !gatewayResult ||
        gatewayResult.status !==
          'success'
      ) {
        console.error(
          'RSPAY WITHDRAW FAILED:',
          gatewayResult
        );

        await refundWithdrawal(
          reserveResult.id,
          gatewayResult?.message ||
            'RSPay withdrawal failed.'
        );

        return res.status(400).json({
          success: false,

          message:
            gatewayResult?.message ||
            'RSPay withdrawal failed.',

          gateway:
            gatewayResult
        });
      }

      const gatewayData =
        gatewayResult.data ||
        {};

      const gatewayWithdrawalId =
        gatewayData.withdrawal_id ||
        null;

      await Withdrawal.updateOne(
        {
          _id:
            reserveResult.id
        },
        {
          $set: {
            status:
              gatewayData.status ||
              'pending',

            gateway_withdrawal_id:
              gatewayWithdrawalId,

            gateway_response:
              gatewayResult
          }
        }
      );

      const finalWallet =
        await ensureWallet(uid);

      return res.status(201).json({
        success: true,

        message:
          gatewayResult.message ||
          'Withdrawal request submitted successfully.',

        withdrawalId:
          reserveResult.id,

        gatewayWithdrawalId:
          gatewayWithdrawalId,

        receivedInBank:
          Number(
            gatewayData.received_in_bank ||
              amount
          ),

        walletDeducted:
          Number(
            gatewayData.wallet_deducted ||
              walletDeducted
          ),

        status:
          gatewayData.status ||
          'pending',

        balance:
          Number(
            finalWallet.balance
          ) / 100
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
          return;
        }

        /*
         * Don't refund twice.
         */
        if (
          withdrawal.status ===
            'rejected' ||
          withdrawal.status ===
            'refunded'
        ) {
          return;
        }

        /*
         * If gateway already accepted it,
         * don't automatically refund here.
         */
        if (
          withdrawal.gateway_withdrawal_id
        ) {
          return;
        }

        const wallet =
          await Wallet.findOne({
            user_id:
              withdrawal.user_id
          }).session(
            dbSession
          );

        if (!wallet) {
          return;
        }

        const refundAmount =
          Number(
            withdrawal.wallet_deducted
          );

        const newBalance =
          Number(
            wallet.balance
          ) +
          refundAmount;

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
                refundAmount,

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

        withdrawal.processed_at =
          new Date();

        withdrawal.gateway_response =
          {
            reason:
              reason
          };

        await withdrawal.save({
          session:
            dbSession
        });
      }
    );
  } finally {
    await dbSession.endSession();
  }
}

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
              Number(x.amount) / 100,

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
              x.account_name ||
              null,

            ifsc:
              x.ifsc || null,

            status:
              x.status,

            gatewayWithdrawalId:
              x.gateway_withdrawal_id ||
              null,

            walletDeducted:
              Number(
                x.wallet_deducted || 0
              ) / 100,

            createdAt:
              x.created_at,

            processedAt:
              x.processed_at ||
              null
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
          wallets.map(
            (w) => [
              String(
                w.user_id
              ),
              Number(
                w.balance
              )
            ]
          )
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
              (
                balanceMap.get(
                  String(x._id)
                ) || 0
              ) / 100
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
        Number(
          req.body.amount
        );

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
        !mongoose.isValidObjectId(
          uid
        ) ||
        !Number.isFinite(
          amount
        ) ||
        amount <= 0
      ) {
        return res.status(400).json({
          success: false,

          message:
            'Invalid user or amount.'
        });
      }

      if (
        ![
          'credit',
          'debit'
        ].includes(type)
      ) {
        return res.status(400).json({
          success: false,

          message:
            'Invalid balance adjustment type.'
        });
      }

      if (
        amount >
        10000000
      ) {
        return res.status(400).json({
          success: false,

          message:
            'Adjustment amount is too large.'
        });
      }

      const u =
        await User.findById(
          uid
        ).select(
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
        Math.round(
          amount * 100
        );

      const delta =
        type === 'debit'
          ? -pa
          : pa;

      const dbSession =
        await mongoose.startSession();

      let result;

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
              Number(
                w.balance
              );

            const newBalance =
              oldBalance +
              delta;

            if (
              newBalance < 0
            ) {
              result = {
                error:
                  'NEGATIVE',

                old:
                  oldBalance
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
                  user_id:
                    uid,

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
                      .randomBytes(
                        3
                      )
                      .toString(
                        'hex'
                      )
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
            result.old / 100
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
          result.old / 100,

        newBalance:
          result.nb / 100
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
      users.map(
        (u) => [
          String(
            u._id
          ),
          u
        ]
      )
    );

  return rows.map((x) => {
    const u =
      userMap.get(
        String(
          x.user_id
        )
      );

    return {
      id: x._id,

      userId:
        x.user_id,

      name:
        u
          ? u.name
          : '',

      phone:
        u
          ? u.phone
          : '',

      amount:
        Number(
          x.amount
        ) / 100,

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
        x.account_name ||
        null,

      ifsc:
        x.ifsc || null,

      walletDeducted:
        Number(
          x.wallet_deducted ||
            0
        ) / 100,

      gatewayWithdrawalId:
        x.gateway_withdrawal_id ||
        null,

      status:
        x.status,

      createdAt:
        x.created_at,

      processedAt:
        x.processed_at ||
        null
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
        !mongoose.isValidObjectId(
          id
        )
      ) {
        return res.status(400).json({
          success: false,

          message:
            'Invalid withdrawal ID.'
        });
      }

      const w =
        await Withdrawal.findById(
          id
        );

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
          'reserved'
        ].includes(
          w.status
        )
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
        !mongoose.isValidObjectId(
          id
        )
      ) {
        return res.status(400).json({
          success: false,

          message:
            'Invalid withdrawal ID.'
        });
      }

      const w =
        await Withdrawal.findById(
          id
        );

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
        ].includes(
          w.status
        )
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
          'This only records the payout status.',

        amount:
          Number(
            w.amount
          ) / 100
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
        !mongoose.isValidObjectId(
          id
        )
      ) {
        return res.status(400).json({
          success: false,

          message:
            'Invalid withdrawal ID.'
        });
      }

      const dbSession =
        await mongoose.startSession();

      let result;

      try {
        await dbSession.withTransaction(
          async () => {
            const w =
              await Withdrawal.findById(
                id
              ).session(
                dbSession
              );

            if (!w) {
              result = {
                error:
                  'NOT_FOUND'
              };

              return;
            }

            if (
              [
                'completed',
                'rejected',
                'refunded'
              ].includes(
                w.status
              )
            ) {
              result = {
                error:
                  'DONE',

                status:
                  w.status
              };

              return;
            }

            const wallet =
              (await Wallet.findOne({
                user_id:
                  w.user_id
              }).session(
                dbSession
              )) ||
              new Wallet({
                user_id:
                  w.user_id,

                balance: 0
              });

            const refund =
              Number(
                w.wallet_deducted ||
                  0
              );

            const newBalance =
              Number(
                wallet.balance
              ) +
              refund;

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
                    w.user_id,

                  type:
                    'withdrawal_refund',

                  amount:
                    refund,

                  balance_after:
                    newBalance,

                  reference_type:
                    'withdrawal',

                  reference_id:
                    String(
                      w._id
                    )
                }
              ],
              {
                session:
                  dbSession
              }
            );

            w.status =
              'rejected';

            w.processed_at =
              new Date();

            await w.save({
              session:
                dbSession
            });

            result = {
              amount:
                refund,

              balance:
                newBalance
            };
          }
        );
      } finally {
        await dbSession.endSession();
      }

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

      return res.json({
        success: true,

        message:
          'Withdrawal rejected and balance refunded.',

        refundedAmount:
          result.amount / 100,

        newBalance:
          result.balance / 100
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
                'reserved',
                'processing'
              ]
            }
          }),

          Payment.aggregate([
            {
              $match: {
                status:
                  'captured'
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

      const totalBalance =
        balanceAgg[0]?.total ||
        0;

      const totalWithdrawals =
        withdrawalsAgg[0]?.total ||
        0;

      const totalPayments =
        paymentsAgg[0]?.total ||
        0;

      return res.json({
        success: true,

        totalUsers:
          Number(
            totalUsers
          ),

        totalBalance:
          totalBalance /
          100,

        totalWithdrawals:
          totalWithdrawals /
          100,

        pendingWithdrawals:
          Number(
            pendingWithdrawals
          ),

        totalPayments:
          totalPayments /
          100
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
      'RSPay Merchant ID:',
      RSPAY_MERCHANT_ID
    );

    console.log(
      'RSPay payment API:',
      RSPAY_API_URL
    );

    console.log(
      'RSPay withdrawal API:',
      RSPAY_WITHDRAW_URL
    );

    console.log(
      RSPAY_ACCESS_KEY
        ? 'RSPay access key detected.'
        : 'WARNING: RSPay access key is not configured.'
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
