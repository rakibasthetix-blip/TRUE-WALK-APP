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

// =====================================================
// BASIC SETTINGS
// =====================================================

app.set('trust proxy', 1);

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// =====================================================
// ENVIRONMENT
// =====================================================

const MONGO_URI =
  process.env.MONGODB_URI ||
  process.env.MONGO_URI;

const SESSION_SECRET =
  process.env.SESSION_SECRET ||
  'CHANGE_THIS_SESSION_SECRET';

const ADMIN_USERNAME =
  process.env.ADMIN_USERNAME || '';

const ADMIN_PASSWORD =
  process.env.ADMIN_PASSWORD || '';


// =====================================================
// ASTROPAY CONFIG
// =====================================================

const ASTROPAY_BASE_URL =
  (
    process.env.ASTROPAY_BASE_URL ||
    'https://api.gpay.one'
  ).replace(/\/+$/, '');

const ASTROPAY_MERCHANT_KEY =
  process.env.ASTROPAY_MERCHANT_KEY || '';

const ASTROPAY_SECRET_KEY =
  process.env.ASTROPAY_SECRET_KEY || '';

const APP_URL =
  (process.env.APP_URL || '').replace(/\/+$/, '');

const ASTROPAY_DEPOSIT_CALLBACK_URL =
  process.env.ASTROPAY_DEPOSIT_CALLBACK_URL ||
  (
    APP_URL
      ? `${APP_URL}/api/payment/webhook`
      : ''
  );

const ASTROPAY_WITHDRAW_CALLBACK_URL =
  process.env.ASTROPAY_WITHDRAW_CALLBACK_URL ||
  (
    APP_URL
      ? `${APP_URL}/api/withdrawal/webhook`
      : ''
  );


// =====================================================
// MONGODB CHECK
// =====================================================

if (!MONGO_URI) {
  console.error(
    'ERROR: MONGODB_URI / MONGO_URI is missing.'
  );

  process.exit(1);
}


// =====================================================
// USER SCHEMA
// =====================================================

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
      index: true,
      trim: true
    },

    email: {
      type: String,
      default: null,
      trim: true,
      lowercase: true
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
      required: true,
      unique: true,
      index: true
    },

    referred_by: {
      type: String,
      default: null,
      index: true
    },

    banned: {
      type: Boolean,
      default: false,
      index: true
    }
  },
  {
    timestamps: false
  }
);


// =====================================================
// WALLET
// ALL AMOUNTS ARE STORED IN PAISE
// =====================================================

const walletSchema = new mongoose.Schema(
  {
    user_id: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: true,
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
  }
);


// =====================================================
// WALLET TRANSACTION
// =====================================================

const walletTransactionSchema =
  new mongoose.Schema(
    {
      user_id: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'User',
        required: true,
        index: true
      },

      type: {
        type: String,
        required: true,
        enum: [
          'credit',
          'debit',
          'refund'
        ]
      },

      amount: {
        type: Number,
        required: true
      },

      balance_after: {
        type: Number,
        required: true
      },

      reference_type: {
        type: String,
        default: null
      },

      reference_id: {
        type: String,
        default: null
      },

      created_at: {
        type: Date,
        default: Date.now
      }
    }
  );


// Prevent duplicate transaction
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


// =====================================================
// PAYMENT / DEPOSIT
// =====================================================

const paymentSchema =
  new mongoose.Schema(
    {
      user_id: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'User',
        required: true,
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

      pay_url: {
        type: String,
        default: null
      },

      commission: {
        type: Number,
        default: 0
      },

      utr: {
        type: String,
        default: null
      },

      status: {
        type: String,
        default: 'created',
        index: true
      },

      created_at: {
        type: Date,
        default: Date.now
      },

      paid_at: {
        type: Date,
        default: null
      }
    }
  );


// =====================================================
// WITHDRAWAL
// =====================================================

const withdrawalSchema =
  new mongoose.Schema(
    {
      user_id: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'User',
        required: true,
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
        default: 'UPI'
      },

      upi_id: {
        type: String,
        default: null
      },

      account_name: {
        type: String,
        default: null
      },

      account_last4: {
        type: String,
        default: null
      },

      ifsc: {
        type: String,
        default: null
      },

      account_phone: {
        type: String,
        default: null
      },

      astropay_order_id: {
        type: String,
        unique: true,
        sparse: true,
        index: true
      },

      astropay_utr: {
        type: String,
        default: null
      },

      commission: {
        type: Number,
        default: 0
      },

      remark: {
        type: String,
        default: null
      },

      status: {
        type: String,
        default: 'pending',
        index: true
      },

      created_at: {
        type: Date,
        default: Date.now
      },

      processed_at: {
        type: Date,
        default: null
      }
    }
  );


// =====================================================
// MODELS
// =====================================================

const User =
  mongoose.models.User ||
  mongoose.model(
    'User',
    userSchema
  );

const Wallet =
  mongoose.models.Wallet ||
  mongoose.model(
    'Wallet',
    walletSchema
  );

const WalletTransaction =
  mongoose.models.WalletTransaction ||
  mongoose.model(
    'WalletTransaction',
    walletTransactionSchema
  );

const Payment =
  mongoose.models.Payment ||
  mongoose.model(
    'Payment',
    paymentSchema
  );

const Withdrawal =
  mongoose.models.Withdrawal ||
  mongoose.model(
    'Withdrawal',
    withdrawalSchema
  );


// =====================================================
// PASSWORD HELPERS
// =====================================================

function createSalt() {
  return crypto
    .randomBytes(16)
    .toString('hex');
}


function hashPassword(
  password,
  salt
) {
  return crypto
    .scryptSync(
      String(password),
      salt,
      64
    )
    .toString('hex');
}


function verifyPassword(
  password,
  salt,
  passwordHash
) {
  const hash =
    hashPassword(
      password,
      salt
    );

  const a =
    Buffer.from(
      hash,
      'hex'
    );

  const b =
    Buffer.from(
      passwordHash,
      'hex'
    );

  if (a.length !== b.length) {
    return false;
  }

  return crypto.timingSafeEqual(
    a,
    b
  );
}


// =====================================================
// UNIQUE ORDER ID
// =====================================================

function makeRef(
  prefix = 'TW'
) {
  return (
    prefix +
    '_' +
    Date.now() +
    '_' +
    crypto
      .randomBytes(6)
      .toString('hex')
  );
}


// =====================================================
// WALLET
// =====================================================

async function ensureWallet(
  userId,
  mongoSession = null
) {
  let wallet =
    await Wallet.findOne({
      user_id: userId
    }).session(
      mongoSession
    );

  if (!wallet) {
    const created =
      await Wallet.create(
        [
          {
            user_id: userId,
            balance: 0,
            updated_at: new Date()
          }
        ],
        mongoSession
          ? {
              session:
                mongoSession
            }
          : undefined
      );

    wallet = created[0];
  }

  return wallet;
}


// =====================================================
// SAFE USER
// =====================================================

function safeUser(user) {
  if (!user) {
    return null;
  }

  return {
    id: user._id,
    name: user.name,
    phone: user.phone,
    email: user.email || null,
    referral_code:
      user.referral_code,
    referred_by:
      user.referred_by
  };
}


// =====================================================
// USER LOGIN MIDDLEWARE
// =====================================================

async function login(
  req,
  res,
  next
) {
  try {
    if (!req.session.userId) {
      return res.status(401).json({
        success: false,
        message:
          'Login required.'
      });
    }

    const user =
      await User.findById(
        req.session.userId
      );

    if (!user) {
      req.session.destroy(
        () => {}
      );

      return res.status(401).json({
        success: false,
        message:
          'User account not found.'
      });
    }

    if (user.banned === true) {
      req.session.destroy(
        () => {}
      );

      return res.status(403).json({
        success: false,
        message:
          'Your account has been banned.'
      });
    }

    req.currentUser = user;

    next();

  } catch (error) {
    console.error(
      'Login middleware error:',
      error
    );

    return res.status(500).json({
      success: false,
      message:
        'Authentication error.'
    });
  }
}


// =====================================================
// ADMIN MIDDLEWARE
// =====================================================

function admin(
  req,
  res,
  next
) {
  if (!req.session.isAdmin) {
    return res.status(401).json({
      success: false,
      message:
        'Admin login required.'
    });
  }

  next();
}


// =====================================================
// SESSION
// =====================================================

const isProduction =
  process.env.NODE_ENV ===
  'production';

app.use(
  session({
    name:
      'truewalk.sid',

    secret:
      SESSION_SECRET,

    resave:
      false,

    saveUninitialized:
      false,

    proxy:
      true,

    store:
      MongoStore.create({
        mongoUrl:
          MONGO_URI,

        collectionName:
          'sessions',

        ttl:
          14 * 24 * 60 * 60
      }),

    cookie: {
      httpOnly:
        true,

      secure:
        isProduction,

      sameSite:
        isProduction
          ? 'none'
          : 'lax',

      maxAge:
        14 *
        24 *
        60 *
        60 *
        1000
    }
  })
);


// =====================================================
// HOME PROTECTION
// =====================================================

app.get(
  '/home.html',
  (req, res, next) => {
    if (
      !req.session ||
      !req.session.userId
    ) {
      return res.redirect(
        '/login.html'
      );
    }

    next();
  }
);


// =====================================================
// ASTROPAY API HELPER
// =====================================================

async function astroPayRequest(
  endpoint,
  body
) {
  const url =
    `${ASTROPAY_BASE_URL}${endpoint}`;

  const response =
    await fetch(
      url,
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
          JSON.stringify({
            merchantKey:
              ASTROPAY_MERCHANT_KEY,

            secretKey:
              ASTROPAY_SECRET_KEY,

            ...body
          })
      }
    );

  const text =
    await response.text();

  let result;

  try {
    result =
      JSON.parse(text);
  } catch {
    throw new Error(
      'AstroPay returned invalid JSON.'
    );
  }

  return {
    httpStatus:
      response.status,

    result
  };
}


// =====================================================
// ASTROPAY WEBHOOK SIGNATURE
// =====================================================

function createAstroPaySignature(
  payload
) {
  const fields = {
    orderId:
      payload.orderId,

    amount:
      payload.amount,

    commission:
      payload.commission,

    status:
      payload.status,

    utr:
      payload.utr
  };

  const sortedKeys =
    Object.keys(fields)
      .sort();

  const parts = [];

  for (
    const key of sortedKeys
  ) {
    const value =
      fields[key];

    if (
      value === null ||
      value === undefined ||
      value === ''
    ) {
      continue;
    }

    parts.push(
      `${key}=${value}`
    );
  }

  const signString =
    parts.join('&') +
    '&secret=' +
    ASTROPAY_SECRET_KEY;

  return crypto
    .createHash('md5')
    .update(signString)
    .digest('hex')
    .toUpperCase();
}


function verifyAstroPayWebhook(
  payload
) {
  if (
    !payload ||
    !payload.sign
  ) {
    return false;
  }

  const expected =
    createAstroPaySignature(
      payload
    );

  const received =
    String(
      payload.sign
    )
      .trim()
      .toUpperCase();

  if (
    expected.length !==
    received.length
  ) {
    return false;
  }

  return crypto.timingSafeEqual(
    Buffer.from(expected),
    Buffer.from(received)
  );
}


// =====================================================
// ADMIN LOGIN
// =====================================================

app.post(
  '/api/admin/login',
  async (req, res) => {
    try {
      const username =
        String(
          req.body.username || ''
        ).trim();

      const password =
        String(
          req.body.password || ''
        );

      if (
        !ADMIN_USERNAME ||
        !ADMIN_PASSWORD
      ) {
        return res.status(500).json({
          success: false,
          message:
            'Admin credentials are not configured.'
        });
      }

      if (
        username !==
          ADMIN_USERNAME ||
        password !==
          ADMIN_PASSWORD
      ) {
        return res.status(401).json({
          success: false,
          message:
            'Invalid admin credentials.'
        });
      }

      req.session.regenerate(
        error => {
          if (error) {
            return res.status(500).json({
              success: false,
              message:
                'Unable to create admin session.'
            });
          }

          req.session.userId =
            null;

          req.session.isAdmin =
            true;

          req.session.save(
            saveError => {
              if (saveError) {
                return res.status(500).json({
                  success: false,
                  message:
                    'Unable to save admin session.'
                });
              }

              return res.json({
                success: true,
                isAdmin: true,
                message:
                  'Admin login successful.'
              });
            }
          );
        }
      );

    } catch (error) {
      console.error(
        'Admin login error:',
        error
      );

      return res.status(500).json({
        success: false,
        message:
          'Admin login failed.'
      });
    }
  }
);


// =====================================================
// ADMIN ME
// =====================================================

app.get(
  '/api/admin/me',
  admin,
  (req, res) => {
    return res.json({
      success: true,
      isAdmin: true
    });
  }
);


// =====================================================
// ADMIN LOGOUT
// =====================================================

app.post(
  '/api/admin/logout',
  (req, res) => {
    if (!req.session) {
      return res.json({
        success: true
      });
    }

    req.session.isAdmin =
      false;

    req.session.userId =
      null;

    req.session.save(
      error => {
        if (error) {
          return res.status(500).json({
            success: false,
            message:
              'Admin logout failed.'
          });
        }

        return res.json({
          success: true,
          message:
            'Admin logged out.'
        });
      }
    );
  }
);


// =====================================================
// REGISTER
// =====================================================

app.post(
  '/api/register',
  async (req, res) => {
    try {
      const name =
        String(
          req.body.name || ''
        ).trim();

      const phone =
        String(
          req.body.phone || ''
        ).trim();

      const email =
        String(
          req.body.email || ''
        ).trim()
        .toLowerCase();

      const password =
        String(
          req.body.password || ''
        );

      const referral =
        String(
          req.body.referral_code ||
          req.body.referral ||
          ''
        ).trim();

      if (!name) {
        return res.status(400).json({
          success: false,
          message:
            'Name is required.'
        });
      }

      if (!phone) {
        return res.status(400).json({
          success: false,
          message:
            'Phone is required.'
        });
      }

      if (
        password.length < 6
      ) {
        return res.status(400).json({
          success: false,
          message:
            'Password must be at least 6 characters.'
        });
      }

      const existing =
        await User.findOne({
          phone
        });

      if (existing) {
        return res.status(409).json({
          success: false,
          message:
            'Phone number is already registered.'
        });
      }

      const salt =
        createSalt();

      const passwordHash =
        hashPassword(
          password,
          salt
        );

      let referralCode;

      while (true) {
        referralCode =
          crypto
            .randomBytes(4)
            .toString('hex')
            .toUpperCase();

        const exists =
          await User.findOne({
            referral_code:
              referralCode
          });

        if (!exists) {
          break;
        }
      }

      let referredBy =
        null;

      if (referral) {
        const referrer =
          await User.findOne({
            referral_code:
              referral.toUpperCase()
          });

        if (referrer) {
          referredBy =
            referrer.referral_code;
        }
      }

      const user =
        await User.create({
          name,
          phone,
          email:
            email || null,
          salt,
          password_hash:
            passwordHash,
          referral_code:
            referralCode,
          referred_by:
            referredBy,
          banned:
            false
        });

      await Wallet.create({
        user_id:
          user._id,

        balance:
          0,

        updated_at:
          new Date()
      });

      req.session.userId =
        user._id.toString();

      req.session.isAdmin =
        false;

      return res.json({
        success: true,
        message:
          'Registration successful.',
        user:
          safeUser(user)
      });

    } catch (error) {
      console.error(
        'Register error:',
        error
      );

      return res.status(500).json({
        success: false,
        message:
          'Registration failed.'
      });
    }
  }
);


// =====================================================
// LOGIN
// =====================================================

app.post(
  '/api/login',
  async (req, res) => {
    try {
      const phone =
        String(
          req.body.phone || ''
        ).trim();

      const password =
        String(
          req.body.password || ''
        );

      if (!phone || !password) {
        return res.status(400).json({
          success: false,
          message:
            'Phone and password are required.'
        });
      }

      const user =
        await User.findOne({
          phone
        });

      if (!user) {
        return res.status(401).json({
          success: false,
          message:
            'Invalid phone or password.'
        });
      }

      if (user.banned) {
        return res.status(403).json({
          success: false,
          message:
            'Your account has been banned.'
        });
      }

      const valid =
        verifyPassword(
          password,
          user.salt,
          user.password_hash
        );

      if (!valid) {
        return res.status(401).json({
          success: false,
          message:
            'Invalid phone or password.'
        });
      }

      req.session.userId =
        user._id.toString();

      req.session.isAdmin =
        false;

      return res.json({
        success: true,
        message:
          'Login successful.',
        user:
          safeUser(user)
      });

    } catch (error) {
      console.error(
        'Login error:',
        error
      );

      return res.status(500).json({
        success: false,
        message:
          'Login failed.'
      });
    }
  }
);


// =====================================================
// ME
// =====================================================

app.get(
  '/api/me',
  login,
  async (req, res) => {
    try {
      const wallet =
        await ensureWallet(
          req.currentUser._id
        );

      return res.json({
        success: true,

        user:
          safeUser(
            req.currentUser
          ),

        wallet: {
          balance:
            Number(
              wallet.balance || 0
            ) / 100
        }
      });

    } catch (error) {
      console.error(
        'Me error:',
        error
      );

      return res.status(500).json({
        success: false,
        message:
          'Unable to load account.'
      });
    }
  }
);


// =====================================================
// WALLET
// =====================================================

app.get(
  '/api/wallet',
  login,
  async (req, res) => {
    try {
      const wallet =
        await ensureWallet(
          req.currentUser._id
        );

      return res.json({
        success: true,

        balance:
          Number(
            wallet.balance || 0
          ) / 100,

        balance_paise:
          Number(
            wallet.balance || 0
          )
      });

    } catch (error) {
      console.error(
        'Wallet error:',
        error
      );

      return res.status(500).json({
        success: false,
        message:
          'Unable to load wallet.'
      });
    }
  }
);


// =====================================================
// REFERRAL
// =====================================================

app.get(
  '/api/referral',
  login,
  async (req, res) => {
    try {
      const user =
        req.currentUser;

      return res.json({
        success: true,

        referral_code:
          user.referral_code,

        referral_link:
          `${APP_URL || ''}/register.html?ref=${encodeURIComponent(user.referral_code)}`
      });

    } catch (error) {
      return res.status(500).json({
        success: false,
        message:
          'Unable to load referral.'
      });
    }
  }
);


// =====================================================
// REFERRALS
// =====================================================

app.get(
  '/api/referrals',
  login,
  async (req, res) => {
    try {
      const referrals =
        await User.find({
          referred_by:
            req.currentUser.referral_code
        })
        .select(
          'name phone referral_code'
        )
        .sort({
          _id: -1
        });

      return res.json({
        success: true,
        referrals
      });

    } catch (error) {
      console.error(
        'Referrals error:',
        error
      );

      return res.status(500).json({
        success: false,
        message:
          'Unable to load referrals.'
      });
    }
  }
);


// =====================================================
// ASTROPAY - CREATE DEPOSIT
// =====================================================

app.post(
  '/api/payment/create-order',
  login,
  async (req, res) => {
    try {
      const amount =
        Number(
          req.body.amount
        );

      const plan =
        String(
          req.body.plan || ''
        ).trim();

      const email =
        String(
          req.body.email ||
          req.currentUser.email ||
          ''
        ).trim();

      if (
        !Number.isFinite(amount) ||
        amount <= 0
      ) {
        return res.status(400).json({
          success: false,
          message:
            'Invalid deposit amount.'
        });
      }

      if (!ASTROPAY_MERCHANT_KEY) {
        return res.status(500).json({
          success: false,
          message:
            'AstroPay merchant key is not configured.'
        });
      }

      if (!ASTROPAY_SECRET_KEY) {
        return res.status(500).json({
          success: false,
          message:
            'AstroPay secret key is not configured.'
        });
      }

      if (
        !ASTROPAY_DEPOSIT_CALLBACK_URL
      ) {
        return res.status(500).json({
          success: false,
          message:
            'AstroPay deposit callback URL is not configured.'
        });
      }

      if (!email) {
        return res.status(400).json({
          success: false,
          message:
            'Email is required for payment.'
        });
      }

      const orderId =
        makeRef('DEP');

      const astro =
        await astroPayRequest(
          '/v1/payins/create',
          {
            orderId,

            amount:
              amount.toFixed(2),

            callbackUrl:
              ASTROPAY_DEPOSIT_CALLBACK_URL,

            name:
              req.currentUser.name,

            phone:
              req.currentUser.phone,

            email,

            channel:
              req.body.channel ||
              undefined
          }
        );

      const result =
        astro.result;

      if (
        !result ||
        Number(result.code) !==
          1000
      ) {
        return res.status(
          astro.httpStatus >= 400
            ? astro.httpStatus
            : 400
        ).json({
          success: false,
          message:
            result?.msg ||
            'AstroPay deposit creation failed.',
          code:
            result?.code || null
        });
      }

      if (
        !result.data ||
        !result.data.pay_url
      ) {
        return res.status(502).json({
          success: false,
          message:
            'AstroPay did not return pay_url.'
        });
      }

      const payment =
        await Payment.create({
          user_id:
            req.currentUser._id,

          plan:
            plan || null,

          amount:
            Math.round(
              amount * 100
            ),

          currency:
            'INR',

          merchant_order_id:
            result.data.order_id ||
            orderId,

          platform_order_id:
            result.data.order_id ||
            orderId,

          pay_url:
            result.data.pay_url,

          status:
            'created',

          created_at:
            new Date()
        });

      return res.json({
        success: true,

        paymentId:
          payment._id,

        orderId:
          payment.merchant_order_id,

        payUrl:
          payment.pay_url,

        amount,

        currency:
          'INR'
      });

    } catch (error) {
      console.error(
        'AstroPay create deposit error:',
        error
      );

      return res.status(500).json({
        success: false,
        message:
          error.message ||
          'Unable to create deposit order.'
      });
    }
  }
);


// =====================================================
// ASTROPAY - QUERY DEPOSIT
// =====================================================

app.get(
  '/api/payment/status/:orderId',
  login,
  async (req, res) => {
    try {
      const orderId =
        String(
          req.params.orderId || ''
        ).trim();

      const payment =
        await Payment.findOne({
          merchant_order_id:
            orderId,

          user_id:
            req.currentUser._id
        });

      if (!payment) {
        return res.status(404).json({
          success: false,
          message:
            'Payment not found.'
        });
      }

      const astro =
        await astroPayRequest(
          '/v1/payins/query',
          {
            orderId
          }
        );

      const result =
        astro.result;

      if (
        !result ||
        Number(result.code) !==
          1000
      ) {
        return res.status(
          astro.httpStatus >= 400
            ? astro.httpStatus
            : 400
        ).json({
          success: false,
          message:
            result?.msg ||
            'Unable to query AstroPay payment.'
        });
      }

      const data =
        result.data || {};

      return res.json({
        success: true,

        status:
          Number(data.status),

        orderId:
          data.orderId,

        amount:
          Number(
            data.amount || 0
          ),

        commission:
          Number(
            data.commission || 0
          ),

        utr:
          data.utr || null,

        created_at:
          data.createTime || null,

        updated_at:
          data.updateTime || null
      });

    } catch (error) {
      console.error(
        'AstroPay deposit query error:',
        error
      );

      return res.status(500).json({
        success: false,
        message:
          'Unable to check payment status.'
      });
    }
  }
);


// =====================================================
// ASTROPAY - DEPOSIT WEBHOOK
// =====================================================

app.post(
  '/api/payment/webhook',
  async (req, res) => {
    try {
      const payload =
        req.body || {};

      console.log(
        'ASTROPAY DEPOSIT WEBHOOK:',
        payload
      );

      if (
        !verifyAstroPayWebhook(
          payload
        )
      ) {
        console.error(
          'Invalid AstroPay deposit signature.'
        );

        return res.status(400).json({
          success: false,
          message:
            'Invalid signature.'
        });
      }

      const orderId =
        String(
          payload.orderId || ''
        ).trim();

      if (!orderId) {
        return res.status(400).json({
          success: false,
          message:
            'Missing orderId.'
        });
      }

      const status =
        Number(
          payload.status
        );

      if (
        status !== 9 &&
        status !== 10
      ) {
        return res.status(200).json({
          success: true,
          message:
            'Pending status ignored.'
        });
      }

      const payment =
        await Payment.findOne({
          merchant_order_id:
            orderId
        });

      if (!payment) {
        return res.status(404).json({
          success: false,
          message:
            'Payment order not found.'
        });
      }

      // Already processed
      if (
        (
          status === 10 &&
          (
            payment.status ===
              'paid' ||
            payment.status ===
              'captured'
          )
        ) ||
        (
          status === 9 &&
          payment.status ===
            'failed'
        )
      ) {
        return res.status(200).json({
          success: true,
          message:
            'Already processed.'
        });
      }

      const webhookAmount =
        Number(
          payload.amount
        );

      const expectedAmount =
        Number(
          payment.amount
        ) / 100;

      if (
        !Number.isFinite(
          webhookAmount
        ) ||
        Math.abs(
          webhookAmount -
          expectedAmount
        ) > 0.01
      ) {
        console.error(
          'AstroPay deposit amount mismatch.',
          {
            orderId,
            webhookAmount,
            expectedAmount
          }
        );

        return res.status(400).json({
          success: false,
          message:
            'Amount mismatch.'
        });
      }

      // FAILED
      if (status === 9) {
        payment.status =
          'failed';

        payment.commission =
          Math.round(
            Number(
              payload.commission || 0
            ) * 100
          );

        payment.utr =
          payload.utr ||
          null;

        await payment.save();

        return res.status(200).json({
          success: true,
          message:
            'Failed payment recorded.'
        });
      }

      // SUCCESS
      const mongoSession =
        await mongoose.startSession();

      try {
        await mongoSession.withTransaction(
          async () => {
            const freshPayment =
              await Payment.findOne({
                merchant_order_id:
                  orderId
              }).session(
                mongoSession
              );

            if (!freshPayment) {
              throw new Error(
                'Payment not found.'
              );
            }

            if (
              freshPayment.status ===
                'paid' ||
              freshPayment.status ===
                'captured'
            ) {
              return;
            }

            const wallet =
              await ensureWallet(
                freshPayment.user_id,
                mongoSession
              );

            const oldBalance =
              Number(
                wallet.balance || 0
              );

            const creditAmount =
              Number(
                freshPayment.amount
              );

            const newBalance =
              oldBalance +
              creditAmount;

            wallet.balance =
              newBalance;

            wallet.updated_at =
              new Date();

            await wallet.save({
              session:
                mongoSession
            });

            await WalletTransaction.create(
              [
                {
                  user_id:
                    freshPayment.user_id,

                  type:
                    'credit',

                  amount:
                    creditAmount,

                  balance_after:
                    newBalance,

                  reference_type:
                    'payment',

                  reference_id:
                    String(
                      freshPayment._id
                    ),

                  created_at:
                    new Date()
                }
              ],
              {
                session:
                  mongoSession
              }
            );

            freshPayment.status =
              'paid';

            freshPayment.commission =
              Math.round(
                Number(
                  payload.commission ||
                    0
                ) * 100
              );

            freshPayment.utr =
              payload.utr ||
              null;

            freshPayment.paid_at =
              new Date();

            await freshPayment.save({
              session:
                mongoSession
            });
          }
        );

      } finally {
        await mongoSession.endSession();
      }

      return res.status(200).json({
        success: true,
        message:
          'Deposit processed successfully.'
      });

    } catch (error) {
      console.error(
        'AstroPay deposit webhook error:',
        error
      );

      return res.status(500).json({
        success: false,
        message:
          'Webhook processing failed.'
      });
    }
  }
);


// =====================================================
// ORDERS
// =====================================================

app.get(
  '/api/orders',
  login,
  async (req, res) => {
    try {
      const payments =
        await Payment.find({
          user_id:
            req.currentUser._id
        })
        .sort({
          created_at: -1
        })
        .lean();

      const orders =
        payments.map(
          payment => ({
            id:
              payment._id,

            plan:
              payment.plan,

            amount:
              Number(
                payment.amount || 0
              ) / 100,

            currency:
              payment.currency,

            merchant_order_id:
              payment.merchant_order_id,

            platform_order_id:
              payment.platform_order_id,

            status:
              payment.status,

            pay_url:
              payment.pay_url,

            commission:
              Number(
                payment.commission || 0
              ) / 100,

            utr:
              payment.utr,

            created_at:
              payment.created_at,

            paid_at:
              payment.paid_at
          })
        );

      return res.json({
        success: true,
        orders
      });

    } catch (error) {
      console.error(
        'Orders error:',
        error
      );

      return res.status(500).json({
        success: false,
        message:
          'Unable to load orders.'
      });
    }
  }
);


// =====================================================
// CREATE ASTROPAY WITHDRAWAL
// =====================================================

app.post(
  '/api/withdrawals',
  login,
  async (req, res) => {
    let mongoSession =
      null;

    try {
      const amount =
        Number(
          req.body.amount
        );

      const method =
        String(
          req.body.method ||
          req.body.withdrawalMethod ||
          'UPI'
        )
        .trim()
        .toUpperCase();

      const upiId =
        String(
          req.body.upi_id ||
          req.body.upiId ||
          req.body.account ||
          ''
        ).trim();

      const accountName =
        String(
          req.body.account_name ||
          req.body.accountName ||
          req.body.personName ||
          ''
        ).trim();

      const accountNumber =
        String(
          req.body.account_number ||
          req.body.accountNumber ||
          ''
        ).trim();

      const accountPhone =
        String(
          req.body.account_phone ||
          req.body.accountPhone ||
          req.currentUser.phone ||
          ''
        ).trim();

      const ifsc =
        String(
          req.body.ifsc ||
          req.body.IFSC ||
          req.body.bank_code ||
          ''
        )
        .trim()
        .toUpperCase();

      if (
        !Number.isFinite(amount) ||
        amount <= 0
      ) {
        return res.status(400).json({
          success: false,
          message:
            'Invalid withdrawal amount.'
        });
      }

      if (amount < 50) {
        return res.status(400).json({
          success: false,
          message:
            'Minimum withdrawal amount is ₹50.'
        });
      }

      if (
        !ASTROPAY_MERCHANT_KEY ||
        !ASTROPAY_SECRET_KEY
      ) {
        return res.status(500).json({
          success: false,
          message:
            'AstroPay credentials are not configured.'
        });
      }

      if (
        !ASTROPAY_WITHDRAW_CALLBACK_URL
      ) {
        return res.status(500).json({
          success: false,
          message:
            'AstroPay withdrawal callback URL is not configured.'
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
            'Only UPI and BANK withdrawals are supported.'
        });
      }

      // -------------------------------------------------
      // UPI VALIDATION
      // -------------------------------------------------

      if (
        method === 'UPI'
      ) {
        if (!upiId) {
          return res.status(400).json({
            success: false,
            message:
              'UPI ID is required.'
          });
        }

        if (
          !/^[a-zA-Z0-9._-]+@[a-zA-Z0-9._-]+$/
            .test(upiId)
        ) {
          return res.status(400).json({
            success: false,
            message:
              'Please enter a valid UPI ID.'
          });
        }
      }

      // -------------------------------------------------
      // BANK VALIDATION
      // -------------------------------------------------

      if (
        method === 'BANK'
      ) {
        if (!accountName) {
          return res.status(400).json({
            success: false,
            message:
              'Account holder name is required.'
          });
        }

        if (!accountNumber) {
          return res.status(400).json({
            success: false,
            message:
              'Bank account number is required.'
          });
        }

        if (!ifsc) {
          return res.status(400).json({
            success: false,
            message:
              'IFSC / bank code is required.'
          });
        }
      }

      const amountPaise =
        Math.round(
          amount * 100
        );

      // -------------------------------------------------
      // CHECK WALLET FIRST
      // -------------------------------------------------

      const wallet =
        await ensureWallet(
          req.currentUser._id
        );

      const balance =
        Number(
          wallet.balance || 0
        );

      if (
        balance < amountPaise
      ) {
        return res.status(400).json({
          success: false,
          message:
            'Insufficient wallet balance.'
        });
      }

      // -------------------------------------------------
      // CREATE ASTROPAY ORDER ID
      // -------------------------------------------------

      const orderId =
        makeRef('WDR');

      // -------------------------------------------------
      // ASTROPAY PAYOUT REQUEST
      // -------------------------------------------------

      const payoutBody = {
        orderId,

        amount:
          amount.toFixed(2),

        callbackUrl:
          ASTROPAY_WITHDRAW_CALLBACK_URL,

        accountType:
          method === 'UPI'
            ? 'UPI'
            : 'BANK',

        account:
          method === 'UPI'
            ? upiId
            : accountNumber,

        bank_code:
          method === 'BANK'
            ? ifsc
            : '',

        accountPhone,

        personName:
          method === 'BANK'
            ? accountName
            : (
                accountName ||
                req.currentUser.name
              )
      };

      const astro =
        await astroPayRequest(
          '/v1/payouts/create',
          payoutBody
        );

      const result =
        astro.result;

      if (
        !result ||
        Number(result.code) !==
          1000
      ) {
        return res.status(
          astro.httpStatus >= 400
            ? astro.httpStatus
            : 400
        ).json({
          success: false,
          message:
            result?.msg ||
            'AstroPay withdrawal creation failed.',
          code:
            result?.code || null
        });
      }

      const data =
        result.data || {};

      // -------------------------------------------------
      // NOW DEDUCT USER WALLET
      // -------------------------------------------------

      mongoSession =
        await mongoose.startSession();

      let withdrawal;

      try {
        await mongoSession.withTransaction(
          async () => {
            const freshWallet =
              await ensureWallet(
                req.currentUser._id,
                mongoSession
              );

            const currentBalance =
              Number(
                freshWallet.balance || 0
              );

            if (
              currentBalance <
              amountPaise
            ) {
              throw new Error(
                'Insufficient wallet balance.'
              );
            }

            const newBalance =
              currentBalance -
              amountPaise;

            freshWallet.balance =
              newBalance;

            freshWallet.updated_at =
              new Date();

            await freshWallet.save({
              session:
                mongoSession
            });

            const created =
              await Withdrawal.create(
                [
                  {
                    user_id:
                      req.currentUser._id,

                    amount:
                      amountPaise,

                    currency:
                      'INR',

                    method:
                      method,

                    upi_id:
                      method === 'UPI'
                        ? upiId
                        : null,

                    account_name:
                      method === 'BANK'
                        ? accountName
                        : (
                            accountName ||
                            null
                          ),

                    account_last4:
                      method === 'BANK'
                        ? accountNumber.slice(-4)
                        : null,

                    ifsc:
                      method === 'BANK'
                        ? ifsc
                        : null,

                    account_phone:
                      accountPhone,

                    astropay_order_id:
                      data.orderId ||
                      orderId,

                    astropay_utr:
                      data.utr ||
                      null,

                    commission:
                      Math.round(
                        Number(
                          data.commission ||
                            0
                        ) * 100
                      ),

                    remark:
                      null,

                    status:
                      Number(
                        data.status
                      ) === 10
                        ? 'completed'
                        : Number(
                            data.status
                          ) === 9
                          ? 'failed'
                          : 'processing',

                    created_at:
                      new Date(),

                    processed_at:
                      Number(
                        data.status
                      ) === 10 ||
                      Number(
                        data.status
                      ) === 9
                        ? new Date()
                        : null
                  }
                ],
                {
                  session:
                    mongoSession
                }
              );

            withdrawal =
              created[0];

            // If AstroPay immediately says FAILED,
            // refund the user's wallet.
            if (
              Number(
                data.status
              ) === 9
            ) {
              freshWallet.balance =
                currentBalance;

              freshWallet.updated_at =
                new Date();

              await freshWallet.save({
                session:
                  mongoSession
              });

              await WalletTransaction.create(
                [
                  {
                    user_id:
                      req.currentUser._id,

                    type:
                      'refund',

                    amount:
                      amountPaise,

                    balance_after:
                      currentBalance,

                    reference_type:
                      'withdrawal_refund',

                    reference_id:
                      String(
                        withdrawal._id
                      ),

                    created_at:
                      new Date()
                  }
                ],
                {
                  session:
                    mongoSession
                }
              );
            } else {
              await WalletTransaction.create(
                [
                  {
                    user_id:
                      req.currentUser._id,

                    type:
                      'debit',

                    amount:
                      amountPaise,

                    balance_after:
                      newBalance,

                    reference_type:
                      'withdrawal',

                    reference_id:
                      String(
                        withdrawal._id
                      ),

                    created_at:
                      new Date()
                  }
                ],
                {
                  session:
                    mongoSession
                }
              );
            }
          }
        );

      } finally {
        await mongoSession.endSession();
      }

      return res.json({
        success: true,

        message:
          Number(data.status) === 9
            ? 'Withdrawal failed and amount was refunded.'
            : 'Withdrawal request submitted successfully.',

        withdrawal: {
          id:
            withdrawal._id,

          orderId:
            withdrawal.astropay_order_id,

          amount,

          status:
            withdrawal.status,

          method,

          commission:
            Number(
              data.commission || 0
            ),

          utr:
            data.utr ||
            null
        }
      });

    } catch (error) {
      console.error(
        'AstroPay withdrawal error:',
        error
      );

      return res.status(500).json({
        success: false,
        message:
          error.message ||
          'Unable to submit withdrawal request.'
      });

    } finally {
      if (mongoSession) {
        try {
          await mongoSession.endSession();
        } catch {}
      }
    }
  }
);


// =====================================================
// ASTROPAY WITHDRAWAL WEBHOOK
// =====================================================

app.post(
  '/api/withdrawal/webhook',
  async (req, res) => {
    try {
      const payload =
        req.body || {};

      console.log(
        'ASTROPAY WITHDRAWAL WEBHOOK:',
        payload
      );

      if (
        !verifyAstroPayWebhook(
          payload
        )
      ) {
        return res.status(400).json({
          success: false,
          message:
            'Invalid signature.'
        });
      }

      const orderId =
        String(
          payload.orderId || ''
        ).trim();

      if (!orderId) {
        return res.status(400).json({
          success: false,
          message:
            'Missing orderId.'
        });
      }

      const status =
        Number(
          payload.status
        );

      if (
        status !== 9 &&
        status !== 10
      ) {
        return res.status(200).json({
          success: true,
          message:
            'Pending status ignored.'
        });
      }

      const withdrawal =
        await Withdrawal.findOne({
          astropay_order_id:
            orderId
        });

      if (!withdrawal) {
        return res.status(404).json({
          success: false,
          message:
            'Withdrawal order not found.'
        });
      }

      // -------------------------------------------------
      // ALREADY FINAL
      // -------------------------------------------------

      if (
        status === 10 &&
        withdrawal.status ===
          'completed'
      ) {
        return res.status(200).json({
          success: true,
          message:
            'Withdrawal already completed.'
        });
      }

      if (
        status === 9 &&
        withdrawal.status ===
          'failed'
      ) {
        return res.status(200).json({
          success: true,
          message:
            'Withdrawal already failed.'
        });
      }

      // -------------------------------------------------
      // AMOUNT CHECK
      // -------------------------------------------------

      const webhookAmount =
        Number(
          payload.amount
        );

      const expectedAmount =
        Number(
          withdrawal.amount
        ) / 100;

      if (
        !Number.isFinite(
          webhookAmount
        ) ||
        Math.abs(
          webhookAmount -
          expectedAmount
        ) > 0.01
      ) {
        return res.status(400).json({
          success: false,
          message:
            'Withdrawal amount mismatch.'
        });
      }

      // -------------------------------------------------
      // SUCCESS
      // -------------------------------------------------

      if (status === 10) {
        withdrawal.status =
          'completed';

        withdrawal.astropay_utr =
          payload.utr ||
          null;

        withdrawal.commission =
          Math.round(
            Number(
              payload.commission || 0
            ) * 100
          );

        withdrawal.remark =
          payload.remark ||
          null;

        withdrawal.processed_at =
          new Date();

        await withdrawal.save();

        return res.status(200).json({
          success: true,
          message:
            'Withdrawal completed.'
        });
      }

      // -------------------------------------------------
      // FAILED
      // -------------------------------------------------

      if (status === 9) {
        const mongoSession =
          await mongoose.startSession();

        try {
          await mongoSession.withTransaction(
            async () => {
              const freshWithdrawal =
                await Withdrawal.findOne({
                  astropay_order_id:
                    orderId
                }).session(
                  mongoSession
                );

              if (!freshWithdrawal) {
                throw new Error(
                  'Withdrawal not found.'
                );
              }

              if (
                freshWithdrawal.status ===
                  'failed'
              ) {
                return;
              }

              const wallet =
                await ensureWallet(
                  freshWithdrawal.user_id,
                  mongoSession
                );

              const oldBalance =
                Number(
                  wallet.balance || 0
                );

              const refundAmount =
                Number(
                  freshWithdrawal.amount
                );

              const newBalance =
                oldBalance +
                refundAmount;

              wallet.balance =
                newBalance;

              wallet.updated_at =
                new Date();

              await wallet.save({
                session:
                  mongoSession
              });

              await WalletTransaction.create(
                [
                  {
                    user_id:
                      freshWithdrawal.user_id,

                    type:
                      'refund',

                    amount:
                      refundAmount,

                    balance_after:
                      newBalance,

                    reference_type:
                      'withdrawal_refund',

                    reference_id:
                      String(
                        freshWithdrawal._id
                      ),

                    created_at:
                      new Date()
                  }
                ],
                {
                  session:
                    mongoSession
                }
              );

              freshWithdrawal.status =
                'failed';

              freshWithdrawal.astropay_utr =
                payload.utr ||
                null;

              freshWithdrawal.commission =
                Math.round(
                  Number(
                    payload.commission ||
                      0
                  ) * 100
                );

              freshWithdrawal.remark =
                payload.remark ||
                null;

              freshWithdrawal.processed_at =
                new Date();

              await freshWithdrawal.save({
                session:
                  mongoSession
              });
            }
          );

        } finally {
          await mongoSession.endSession();
        }

        return res.status(200).json({
          success: true,
          message:
            'Withdrawal failed and amount refunded.'
        });
      }

    } catch (error) {
      console.error(
        'AstroPay withdrawal webhook error:',
        error
      );

      return res.status(500).json({
        success: false,
        message:
          'Withdrawal webhook failed.'
      });
    }
  }
);


// =====================================================
// USER WITHDRAWAL HISTORY
// =====================================================

app.get(
  '/api/withdrawals',
  login,
  async (req, res) => {
    try {
      const withdrawals =
        await Withdrawal.find({
          user_id:
            req.currentUser._id
        })
        .sort({
          created_at: -1
        })
        .lean();

      return res.json({
        success: true,

        withdrawals:
          withdrawals.map(
            item => ({
              id:
                item._id,

              amount:
                Number(
                  item.amount || 0
                ) / 100,

              currency:
                item.currency,

              method:
                item.method,

              upi_id:
                item.upi_id,

              account_name:
                item.account_name,

              account_last4:
                item.account_last4,

              ifsc:
                item.ifsc,

              account_phone:
                item.account_phone,

              astropay_order_id:
                item.astropay_order_id,

              utr:
                item.astropay_utr,

              commission:
                Number(
                  item.commission || 0
                ) / 100,

              remark:
                item.remark,

              status:
                item.status,

              created_at:
                item.created_at,

              processed_at:
                item.processed_at
            })
          )
      });

    } catch (error) {
      console.error(
        'Withdrawal history error:',
        error
      );

      return res.status(500).json({
        success: false,
        message:
          'Unable to load withdrawals.'
      });
    }
  }
);


// =====================================================
// ASTROPAY WITHDRAWAL QUERY
// =====================================================

app.get(
  '/api/withdrawals/status/:orderId',
  login,
  async (req, res) => {
    try {
      const orderId =
        String(
          req.params.orderId || ''
        ).trim();

      const withdrawal =
        await Withdrawal.findOne({
          astropay_order_id:
            orderId,

          user_id:
            req.currentUser._id
        });

      if (!withdrawal) {
        return res.status(404).json({
          success: false,
          message:
            'Withdrawal not found.'
        });
      }

      const astro =
        await astroPayRequest(
          '/v1/payouts/query',
          {
            orderId
          }
        );

      const result =
        astro.result;

      if (
        !result ||
        Number(result.code) !==
          1000
      ) {
        return res.status(
          astro.httpStatus >= 400
            ? astro.httpStatus
            : 400
        ).json({
          success: false,
          message:
            result?.msg ||
            'Unable to query AstroPay withdrawal.'
        });
      }

      const data =
        result.data || {};

      const status =
        Number(
          data.status
        );

      return res.json({
        success: true,

        orderId:
          data.orderId,

        amount:
          Number(
            data.amount || 0
          ),

        status,

        utr:
          data.utr ||
          null,

        created_at:
          data.createTime ||
          null,

        updated_at:
          data.updateTime ||
          null
      });

    } catch (error) {
      console.error(
        'Withdrawal query error:',
        error
      );

      return res.status(500).json({
        success: false,
        message:
          'Unable to check withdrawal status.'
      });
    }
  }
);


// =====================================================
// ADMIN USERS
// =====================================================

app.get(
  '/api/admin/users',
  admin,
  async (req, res) => {
    try {
      const users =
        await User.find()
          .select(
            'name phone email referral_code referred_by banned'
          )
          .sort({
            _id: -1
          })
          .lean();

      const result = [];

      for (
        const user of users
      ) {
        const wallet =
          await Wallet.findOne({
            user_id:
              user._id
          }).lean();

        result.push({
          id:
            user._id,

          name:
            user.name,

          phone:
            user.phone,

          email:
            user.email,

          referral_code:
            user.referral_code,

          referred_by:
            user.referred_by,

          balance:
            Number(
              wallet?.balance || 0
            ) / 100,

          banned:
            user.banned === true
        });
      }

      return res.json({
        success: true,
        users:
          result
      });

    } catch (error) {
      console.error(
        'Admin users error:',
        error
      );

      return res.status(500).json({
        success: false,
        message:
          'Unable to load users.'
      });
    }
  }
);


// =====================================================
// ADMIN BAN
// =====================================================

app.post(
  '/api/admin/users/:userId/ban',
  admin,
  async (req, res) => {
    try {
      if (
        !mongoose.isValidObjectId(
          req.params.userId
        )
      ) {
        return res.status(400).json({
          success: false,
          message:
            'Invalid user ID.'
        });
      }

      const user =
        await User.findById(
          req.params.userId
        );

      if (!user) {
        return res.status(404).json({
          success: false,
          message:
            'User not found.'
        });
      }

      user.banned =
        true;

      await user.save();

      return res.json({
        success: true,
        message:
          'User banned successfully.'
      });

    } catch (error) {
      console.error(
        'Ban user error:',
        error
      );

      return res.status(500).json({
        success: false,
        message:
          'Unable to ban user.'
      });
    }
  }
);


// =====================================================
// ADMIN UNBAN
// =====================================================

app.post(
  '/api/admin/users/:userId/unban',
  admin,
  async (req, res) => {
    try {
      if (
        !mongoose.isValidObjectId(
          req.params.userId
        )
      ) {
        return res.status(400).json({
          success: false,
          message:
            'Invalid user ID.'
        });
      }

      const user =
        await User.findById(
          req.params.userId
        );

      if (!user) {
        return res.status(404).json({
          success: false,
          message:
            'User not found.'
        });
      }

      user.banned =
        false;

      await user.save();

      return res.json({
        success: true,
        message:
          'User unbanned successfully.'
      });

    } catch (error) {
      console.error(
        'Unban user error:',
        error
      );

      return res.status(500).json({
        success: false,
        message:
          'Unable to unban user.'
      });
    }
  }
);


// =====================================================
// ADMIN LOGIN AS USER
// =====================================================

app.post(
  '/api/admin/users/:userId/login-as',
  admin,
  async (req, res) => {
    try {
      const user =
        await User.findById(
          req.params.userId
        );

      if (!user) {
        return res.status(404).json({
          success: false,
          message:
            'User not found.'
        });
      }

      if (user.banned) {
        return res.status(403).json({
          success: false,
          message:
            'This user is banned.'
        });
      }

      req.session.regenerate(
        error => {
          if (error) {
            return res.status(500).json({
              success: false,
              message:
                'Unable to create session.'
            });
          }

          req.session.userId =
            user._id.toString();

          req.session.isAdmin =
            false;

          req.session.save(
            saveError => {
              if (saveError) {
                return res.status(500).json({
                  success: false,
                  message:
                    'Unable to save session.'
                });
              }

              return res.json({
                success: true,
                message:
                  'Logged in as user successfully.',
                user:
                  safeUser(user)
              });
            }
          );
        }
      );

    } catch (error) {
      console.error(
        'Login as user error:',
        error
      );

      return res.status(500).json({
        success: false,
        message:
          'Unable to login as user.'
      });
    }
  }
);


// =====================================================
// ADMIN BALANCE ADJUSTMENT
// =====================================================

app.post(
  '/api/admin/users/:userId/balance',
  admin,
  async (req, res) => {
    let mongoSession =
      null;

    try {
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
        !Number.isFinite(amount) ||
        amount <= 0
      ) {
        return res.status(400).json({
          success: false,
          message:
            'Invalid amount.'
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
            'Invalid adjustment type.'
        });
      }

      const amountPaise =
        Math.round(
          amount * 100
        );

      mongoSession =
        await mongoose.startSession();

      let newBalance =
        0;

      try {
        await mongoSession.withTransaction(
          async () => {
            const user =
              await User.findById(
                req.params.userId
              ).session(
                mongoSession
              );

            if (!user) {
              throw new Error(
                'User not found.'
              );
            }

            const wallet =
              await ensureWallet(
                user._id,
                mongoSession
              );

            const oldBalance =
              Number(
                wallet.balance || 0
              );

            if (
              type === 'debit' &&
              oldBalance <
                amountPaise
            ) {
              throw new Error(
                'Insufficient wallet balance.'
              );
            }

            newBalance =
              type === 'credit'
                ? oldBalance +
                  amountPaise
                : oldBalance -
                  amountPaise;

            wallet.balance =
              newBalance;

            wallet.updated_at =
              new Date();

            await wallet.save({
              session:
                mongoSession
            });

            await WalletTransaction.create(
              [
                {
                  user_id:
                    user._id,

                  type:
                    type,

                  amount:
                    amountPaise,

                  balance_after:
                    newBalance,

                  reference_type:
                    'admin_adjustment',

                  reference_id:
                    makeRef('ADMIN'),

                  created_at:
                    new Date()
                }
              ],
              {
                session:
                  mongoSession
              }
            );
          }
        );

      } finally {
        await mongoSession.endSession();
        mongoSession =
          null;
      }

      return res.json({
        success: true,

        message:
          reason,

        balance:
          newBalance / 100
      });

    } catch (error) {
      if (mongoSession) {
        try {
          await mongoSession.endSession();
        } catch {}
      }

      console.error(
        'Admin balance error:',
        error
      );

      return res.status(400).json({
        success: false,
        message:
          error.message ||
          'Unable to update balance.'
      });
    }
  }
);


// =====================================================
// ADMIN WITHDRAWALS
// =====================================================

app.get(
  '/api/admin/withdrawals',
  admin,
  async (req, res) => {
    try {
      const withdrawals =
        await Withdrawal.find()
          .populate(
            'user_id',
            'name phone'
          )
          .sort({
            created_at: -1
          })
          .lean();

      return res.json({
        success: true,

        withdrawals:
          withdrawals.map(
            item => ({
              id:
                item._id,

              user:
                item.user_id
                  ? {
                      id:
                        item.user_id._id,

                      name:
                        item.user_id.name,

                      phone:
                        item.user_id.phone
                    }
                  : null,

              amount:
                Number(
                  item.amount || 0
                ) / 100,

              currency:
                item.currency,

              method:
                item.method,

              upi_id:
                item.upi_id,

              account_name:
                item.account_name,

              account_last4:
                item.account_last4,

              ifsc:
                item.ifsc,

              astropay_order_id:
                item.astropay_order_id,

              utr:
                item.astropay_utr,

              commission:
                Number(
                  item.commission || 0
                ) / 100,

              remark:
                item.remark,

              status:
                item.status,

              created_at:
                item.created_at,

              processed_at:
                item.processed_at
            })
          )
      });

    } catch (error) {
      console.error(
        'Admin withdrawals error:',
        error
      );

      return res.status(500).json({
        success: false,
        message:
          'Unable to load withdrawals.'
      });
    }
  }
);


// =====================================================
// ADMIN PROCESSING
// =====================================================

app.post(
  '/api/admin/withdrawals/:id/processing',
  admin,
  async (req, res) => {
    try {
      const withdrawal =
        await Withdrawal.findById(
          req.params.id
        );

      if (!withdrawal) {
        return res.status(404).json({
          success: false,
          message:
            'Withdrawal not found.'
        });
      }

      if (
        withdrawal.status !==
        'processing'
      ) {
        return res.status(400).json({
          success: false,
          message:
            'Withdrawal is not in processing state.'
        });
      }

      return res.json({
        success: true,
        message:
          'Withdrawal is already being processed by AstroPay.'
      });

    } catch (error) {
      return res.status(500).json({
        success: false,
        message:
          'Unable to update withdrawal.'
      });
    }
  }
);


// =====================================================
// ADMIN COMPLETE
// =====================================================

app.post(
  '/api/admin/withdrawals/:id/complete',
  admin,
  async (req, res) => {
    try {
      const withdrawal =
        await Withdrawal.findById(
          req.params.id
        );

      if (!withdrawal) {
        return res.status(404).json({
          success: false,
          message:
            'Withdrawal not found.'
        });
      }

      return res.json({
        success: true,

        message:
          'AstroPay controls final settlement. Use the webhook/query status.'
      });

    } catch (error) {
      return res.status(500).json({
        success: false,
        message:
          'Unable to complete withdrawal.'
      });
    }
  }
);


// =====================================================
// ADMIN REJECT
// =====================================================

app.post(
  '/api/admin/withdrawals/:id/reject',
  admin,
  async (req, res) => {
    try {
      const withdrawal =
        await Withdrawal.findById(
          req.params.id
        );

      if (!withdrawal) {
        return res.status(404).json({
          success: false,
          message:
            'Withdrawal not found.'
        });
      }

      if (
        withdrawal.status ===
          'failed' ||
        withdrawal.status ===
          'completed'
      ) {
        return res.status(400).json({
          success: false,
          message:
            'This withdrawal is already finalized by AstroPay.'
        });
      }

      return res.status(400).json({
        success: false,
        message:
          'Do not manually reject an active AstroPay payout. AstroPay will send status 9 if the payout fails and the server will automatically refund the wallet.'
      });

    } catch (error) {
      console.error(
        'Admin reject error:',
        error
      );

      return res.status(500).json({
        success: false,
        message:
          'Unable to reject withdrawal.'
      });
    }
  }
);


// =====================================================
// ADMIN SUMMARY
// =====================================================

app.get(
  '/api/admin/summary',
  admin,
  async (req, res) => {
    try {
      const totalUsers =
        await User.countDocuments();

      const walletResult =
        await Wallet.aggregate([
          {
            $group: {
              _id:
                null,

              total: {
                $sum: {
                  $ifNull: [
                    '$balance',
                    0
                  ]
                }
              }
            }
          }
        ]);

      const totalBalancePaise =
        Number(
          walletResult[0]?.total ||
          0
        );

      const withdrawalResult =
        await Withdrawal.aggregate([
          {
            $group: {
              _id:
                '$status',

              totalAmount: {
                $sum: {
                  $ifNull: [
                    '$amount',
                    0
                  ]
                }
              },

              count: {
                $sum:
                  1
              }
            }
          }
        ]);

      let pending =
        0;

      let processing =
        0;

      let completed =
        0;

      let failed =
        0;

      let totalWithdrawnPaise =
        0;

      for (
        const item of
        withdrawalResult
      ) {
        const status =
          String(
            item._id || ''
          ).toLowerCase();

        const count =
          Number(
            item.count || 0
          );

        const amount =
          Number(
            item.totalAmount || 0
          );

        if (
          status === 'pending'
        ) {
          pending =
            count;
        }

        if (
          status === 'processing'
        ) {
          processing =
            count;
        }

        if (
          status === 'completed'
        ) {
          completed =
            count;

          totalWithdrawnPaise +=
            amount;
        }

        if (
          status === 'failed'
        ) {
          failed =
            count;
        }
      }

      const paymentResult =
        await Payment.aggregate([
          {
            $match: {
              status: {
                $in: [
                  'paid',
                  'captured'
                ]
              }
            }
          },

          {
            $group: {
              _id:
                null,

              totalAmount: {
                $sum: {
                  $ifNull: [
                    '$amount',
                    0
                  ]
                }
              },

              count: {
                $sum:
                  1
              }
            }
          }
        ]);

      const totalPaymentsPaise =
        Number(
          paymentResult[0]?.totalAmount ||
          0
        );

      const successfulPayments =
        Number(
          paymentResult[0]?.count ||
          0
        );

      return res.json({
        success: true,

        total_users:
          totalUsers,

        totalUsers:
          totalUsers,

        totalBalance:
          totalBalancePaise / 100,

        total_balance:
          totalBalancePaise / 100,

        totalWithdrawn:
          totalWithdrawnPaise / 100,

        total_withdrawals:
          totalWithdrawnPaise / 100,

        pending:
          pending,

        pending_withdrawals:
          pending,

        processing:
          processing,

        processing_withdrawals:
          processing,

        completed_withdrawals:
          completed,

        failed_withdrawals:
          failed,

        successful_payments:
          successfulPayments,

        totalPayments:
          totalPaymentsPaise / 100,

        total_payments:
          totalPaymentsPaise / 100
      });

    } catch (error) {
      console.error(
        'Admin summary error:',
        error
      );

      return res.status(500).json({
        success: false,
        message:
          'Unable to load summary.'
      });
    }
  }
);


// =====================================================
// ADMIN TOTAL USERS
// =====================================================

app.get(
  '/api/admin/total-users',
  admin,
  async (req, res) => {
    try {
      const count =
        await User.countDocuments();

      return res.json({
        success: true,
        total_users:
          count
      });

    } catch (error) {
      return res.status(500).json({
        success: false,
        message:
          'Unable to get total users.'
      });
    }
  }
);


// =====================================================
// LOGOUT
// =====================================================

app.post(
  '/api/logout',
  (req, res) => {
    if (!req.session) {
      return res.json({
        success: true
      });
    }

    req.session.destroy(
      error => {
        if (error) {
          console.error(
            'Logout error:',
            error
          );

          return res.status(500).json({
            success: false,
            message:
              'Logout failed.'
          });
        }

        res.clearCookie(
          'truewalk.sid'
        );

        return res.json({
          success: true,
          message:
            'Logged out successfully.'
        });
      }
    );
  }
);


// =====================================================
// STATIC FILES
// =====================================================

app.use(
  express.static(
    path.join(
      __dirname
    )
  )
);


// =====================================================
// ROOT
// =====================================================

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


// =====================================================
// ERROR HANDLER
// =====================================================

app.use(
  (
    err,
    req,
    res,
    next
  ) => {
    console.error(
      'Unhandled server error:',
      err
    );

    if (
      res.headersSent
    ) {
      return next(err);
    }

    return res.status(500).json({
      success: false,
      message:
        'Internal server error.'
    });
  }
);


// =====================================================
// START SERVER
// =====================================================

async function startServer() {
  try {
    await mongoose.connect(
      MONGO_URI
    );

    console.log(
      'MongoDB connected successfully.'
    );

    console.log(
      'AstroPay:',
      ASTROPAY_MERCHANT_KEY
        ? 'configured'
        : 'NOT configured'
    );

    console.log(
      'Deposit callback:',
      ASTROPAY_DEPOSIT_CALLBACK_URL ||
        'NOT CONFIGURED'
    );

    console.log(
      'Withdrawal callback:',
      ASTROPAY_WITHDRAW_CALLBACK_URL ||
        'NOT CONFIGURED'
    );

    app.listen(
      PORT,
      () => {
        console.log(
          `TRUE WALK server running on port ${PORT}`
        );

        console.log(
          `Local: http://localhost:${PORT}`
        );
      }
    );

  } catch (error) {
    console.error(
      'MongoDB connection failed:',
      error
    );

    process.exit(1);
  }
}

startServer();
