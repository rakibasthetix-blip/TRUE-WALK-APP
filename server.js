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
// BASIC APP SETTINGS
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
// RS PAYMENT CONFIG
// =====================================================

const RSPAY_MERCHANT_ID =
  process.env.RSPAY_MERCHANT_ID || '';

const RSPAY_ACCESS_KEY =
  process.env.RSPAY_ACCESS_KEY || '';

const RSPAY_API_URL =
  process.env.RSPAY_API_URL ||
  'https://rspayment.shop/api.php';

const RSPAY_WITHDRAW_URL =
  process.env.RSPAY_WITHDRAW_URL ||
  'https://rspayment.shop/withdraw_api.php';

const APP_URL =
  (process.env.APP_URL || '').replace(/\/+$/, '');

const RSPAY_WEBHOOK_URL =
  process.env.RSPAY_WEBHOOK_URL ||
  (APP_URL
    ? `${APP_URL}/api/payment/webhook`
    : '');

const RSPAY_RETURN_URL =
  process.env.RSPAY_RETURN_URL ||
  (APP_URL
    ? `${APP_URL}/home.html`
    : '');


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
    }
  },
  {
    timestamps: false
  }
);


// =====================================================
// WALLET SCHEMA
// Amount is stored in PAISE
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


// Prevent duplicate wallet transaction
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
// PAYMENT SCHEMA
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

      // Stored in paise
      amount: {
        type: Number,
        required: true
      },

      currency: {
        type: String,
        default: 'INR'
      },

      // RS Payment merchant order ID
      merchant_order_id: {
        type: String,
        unique: true,
        sparse: true,
        index: true
      },

      // RS Payment platform order ID
      platform_order_id: {
        type: String,
        default: null
      },

      // Payment page URL
      pay_url: {
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
// WITHDRAWAL SCHEMA
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

      // Requested amount in paise
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
        default: 'BANK'
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
  mongoose.model('User', userSchema);

const Wallet =
  mongoose.models.Wallet ||
  mongoose.model('Wallet', walletSchema);

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

  return crypto.timingSafeEqual(
    Buffer.from(hash, 'hex'),
    Buffer.from(passwordHash, 'hex')
  );
}


// =====================================================
// RANDOM REFERENCE
// =====================================================

function makeRef(prefix = 'TW') {
  return (
    prefix +
    '_' +
    Date.now() +
    '_' +
    crypto
      .randomBytes(5)
      .toString('hex')
  );
}


// =====================================================
// WALLET HELPER
// =====================================================

async function ensureWallet(
  userId,
  session = null
) {

  let wallet =
    await Wallet.findOne({
      user_id: userId
    }).session(session);


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
        session
          ? { session }
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
    referral_code: user.referral_code,
    referred_by: user.referred_by
  };
}


// =====================================================
// LOGIN MIDDLEWARE
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
        message: 'Login required.'
      });

    }

    next();

  } catch (error) {

    console.error(
      'Login middleware error:',
      error
    );

    return res.status(500).json({
      success: false,
      message: 'Authentication error.'
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
      message: 'Admin login required.'
    });

  }

  next();
}


// =====================================================
// SESSION
// =====================================================

app.use(
  session({
    name: 'truewalk.sid',

    secret:
      SESSION_SECRET,

    resave: false,

    saveUninitialized: false,

    store:
      MongoStore.create({
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


// =====================================================
// HOME PROTECTION
// =====================================================

app.get(
  '/home.html',
  (req, res, next) => {

    if (!req.session.userId) {
      return res.redirect('/login.html');
    }

    next();
  }
);


// =====================================================
// ADMIN LOGIN
// =====================================================

app.post(
  '/api/admin/login',
  async (req, res) => {

    try {

      const username =
        String(req.body.username || '').trim();

      const password =
        String(req.body.password || '');

      if (!ADMIN_USERNAME || !ADMIN_PASSWORD) {

        return res.status(500).json({
          success: false,
          message: 'Admin credentials are not configured.'
        });

      }

      if (
        username !== ADMIN_USERNAME ||
        password !== ADMIN_PASSWORD
      ) {

        return res.status(401).json({
          success: false,
          message: 'Invalid admin credentials.'
        });

      }

      // Clear normal user session state
      req.session.userId = null;

      // Set admin session
      req.session.isAdmin = true;

      // Explicitly save session before responding.
      // This prevents redirect/dashboard race conditions
      // with MongoStore.
      req.session.save((error) => {

        if (error) {

          console.error(
            'Admin session save error:',
            error
          );

          return res.status(500).json({
            success: false,
            message: 'Unable to save admin session.'
          });

        }

        return res.json({
          success: true,
          message: 'Admin login successful.'
        });

      });

    } catch (error) {

      console.error(
        'Admin login error:',
        error
      );

      return res.status(500).json({
        success: false,
        message: 'Admin login failed.'
      });

    }

  }
);


      if (
        username !== ADMIN_USERNAME ||
        password !== ADMIN_PASSWORD
      ) {

        return res.status(401).json({
          success: false,
          message:
            'Invalid admin credentials.'
        });

      }


      req.session.isAdmin = true;


      return res.json({
        success: true,
        message: 'Admin login successful.'
      });

    } catch (error) {

      console.error(
        'Admin login error:',
        error
      );

      return res.status(500).json({
        success: false,
        message: 'Admin login failed.'
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

    res.json({
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

    req.session.isAdmin = false;

    res.json({
      success: true,
      message: 'Admin logged out.'
    });

  }
);


// =====================================================
// USER REGISTER
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
          message: 'Name is required.'
        });

      }


      if (!phone) {

        return res.status(400).json({
          success: false,
          message: 'Phone is required.'
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

      for (;;) {

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


      let referredBy = null;

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
          salt,
          password_hash:
            passwordHash,
          referral_code:
            referralCode,
          referred_by:
            referredBy
        });


      await Wallet.create({
        user_id: user._id,
        balance: 0,
        updated_at: new Date()
      });


      req.session.userId =
        user._id.toString();


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
// USER LOGIN
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
        message: 'Login successful.',
        user:
          safeUser(user)
      });

    } catch (error) {

      console.error(
        'User login error:',
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
// USER ME
// =====================================================

app.get(
  '/api/me',
  login,
  async (req, res) => {

    try {

      const user =
        await User.findById(
          req.session.userId
        );

      if (!user) {

        return res.status(404).json({
          success: false,
          message: 'User not found.'
        });

      }


      const wallet =
        await ensureWallet(
          user._id
        );


      return res.json({
        success: true,
        user:
          safeUser(user),
        wallet: {
          balance:
            Number(wallet.balance || 0) / 100
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
          req.session.userId
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
        await User.findById(
          req.session.userId
        );

      if (!user) {

        return res.status(404).json({
          success: false,
          message: 'User not found.'
        });

      }


      return res.json({
        success: true,

        referral_code:
          user.referral_code,

        referral_link:
          `${APP_URL || ''}/register.html?ref=${encodeURIComponent(user.referral_code)}`
      });

    } catch (error) {

      console.error(
        'Referral error:',
        error
      );

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

      const user =
        await User.findById(
          req.session.userId
        );

      if (!user) {

        return res.status(404).json({
          success: false,
          message: 'User not found.'
        });

      }


      const referrals =
        await User.find({
          referred_by:
            user.referral_code
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
// RS PAYMENT - CREATE PAYMENT
// =====================================================

app.post(
  '/api/payment/create-order',
  login,
  async (req, res) => {

    try {

      const amount =
        Number(req.body.amount);

      const plan =
        String(
          req.body.plan || ''
        ).trim();


      // RS Payment minimum = ₹200
      if (
        !Number.isFinite(amount) ||
        amount < 200
      ) {

        return res.status(400).json({
          success: false,
          message:
            'Minimum deposit amount is ₹200.'
        });

      }


      if (!RSPAY_MERCHANT_ID) {

        return res.status(500).json({
          success: false,
          message:
            'RS Payment merchant ID is not configured.'
        });

      }


      if (
        !RSPAY_WEBHOOK_URL ||
        !RSPAY_RETURN_URL
      ) {

        return res.status(500).json({
          success: false,
          message:
            'RS Payment callback URLs are not configured.'
        });

      }


      // Unique order ID
      const merchantOrderId =
        makeRef('TW');


      // RS Payment expects amount in INR
      const params =
        new URLSearchParams();


      params.set(
        'amount',
        amount.toFixed(2)
      );

      params.set(
        'user_id',
        RSPAY_MERCHANT_ID
      );

      params.set(
        'order_id',
        merchantOrderId
      );

      params.set(
        'ext',
        'TRUE WALK'
      );

      params.set(
        'webhook_url',
        RSPAY_WEBHOOK_URL
      );

      params.set(
        'return_url',
        RSPAY_RETURN_URL
      );


      console.log(
        'Creating RS Payment:',
        {
          order_id:
            merchantOrderId,
          amount
        }
      );


      const response =
        await fetch(
          `${RSPAY_API_URL}?${params.toString()}`,
          {
            method: 'GET',

            headers: {
              Accept:
                'application/json'
            }
          }
        );


      const responseText =
        await response.text();


      let result;

      try {

        result =
          JSON.parse(
            responseText
          );

      } catch (parseError) {

        console.error(
          'RS Payment returned non-JSON:',
          responseText
        );

        return res.status(502).json({
          success: false,
          message:
            'RS Payment returned an invalid response.'
        });

      }


      if (!response.ok) {

        console.error(
          'RS Payment HTTP error:',
          result
        );

        return res.status(502).json({
          success: false,
          message:
            result.message ||
            'RS Payment API request failed.'
        });

      }


      if (
        !result.status ||
        !result.data ||
        !result.data.payUrl
      ) {

        console.error(
          'RS Payment API error:',
          result
        );

        return res.status(400).json({
          success: false,
          message:
            result.message ||
            'RS Payment did not return a payment URL.'
        });

      }


      const payment =
        await Payment.create({

          user_id:
            req.session.userId,

          plan:
            plan || null,

          // Our DB stores paise
          amount:
            Math.round(
              amount * 100
            ),

          currency:
            'INR',

          merchant_order_id:
            result.data.merchant_order_id ||
            merchantOrderId,

          platform_order_id:
            result.data.platform_order_id ||
            null,

          pay_url:
            result.data.payUrl,

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

        amount:
          amount,

        currency:
          'INR'

      });


    } catch (error) {

      console.error(
        'RS Payment create error:',
        error
      );

      return res.status(500).json({
        success: false,
        message:
          'Unable to create RS Payment order.'
      });

    }

  }
);


// =====================================================
// RS PAYMENT - WEBHOOK
// =====================================================

app.post(
  '/api/payment/webhook',
  async (req, res) => {

    try {

      const {
        status,
        user_id,
        merchant_order_id,
        amount
      } = req.body;


      console.log(
        'RS Payment webhook received:',
        req.body
      );


      if (!merchant_order_id) {

        return res.status(400).json({
          success: false,
          message:
            'Missing merchant_order_id.'
        });

      }


      // Verify merchant ID
      if (
        String(user_id || '') !==
        String(RSPAY_MERCHANT_ID)
      ) {

        console.error(
          'Invalid RS Payment merchant:',
          user_id
        );

        return res.status(403).json({
          success: false,
          message:
            'Invalid merchant.'
        });

      }


      // Only process successful payment
      if (
        String(status || '')
          .toLowerCase() !==
        'success'
      ) {

        return res.status(200).json({
          success: true,
          message:
            'Payment is not successful.'
        });

      }


      const payment =
        await Payment.findOne({
          merchant_order_id
        });


      if (!payment) {

        console.error(
          'Payment not found:',
          merchant_order_id
        );

        return res.status(404).json({
          success: false,
          message:
            'Payment order not found.'
        });

      }


      // Already credited
      if (
        payment.status === 'paid' ||
        payment.status === 'captured'
      ) {

        return res.status(200).json({
          success: true,
          message:
            'Payment already processed.'
        });

      }


      // Compare webhook amount with DB amount
      const webhookAmount =
        Number(amount);

      const expectedAmount =
        Number(payment.amount) / 100;


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
          'Payment amount mismatch:',
          {
            merchant_order_id,
            webhookAmount,
            expectedAmount
          }
        );

        return res.status(400).json({
          success: false,
          message:
            'Payment amount mismatch.'
        });

      }


      const mongoSession =
        await mongoose.startSession();


      try {

        await mongoSession.withTransaction(
          async () => {

            const freshPayment =
              await Payment.findOne({
                merchant_order_id
              }).session(
                mongoSession
              );


            if (!freshPayment) {
              throw new Error(
                'Payment not found.'
              );
            }


            // Idempotency
            if (
              freshPayment.status === 'paid' ||
              freshPayment.status === 'captured'
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


      console.log(
        'RS Payment credited:',
        merchant_order_id
      );


      return res.status(200).json({
        success: true,
        message:
          'Payment processed successfully.'
      });


    } catch (error) {

      console.error(
        'RS Payment webhook error:',
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
// PAYMENT STATUS
// =====================================================

app.get(
  '/api/payment/status/:orderId',
  login,
  async (req, res) => {

    try {

      const payment =
        await Payment.findOne({
          merchant_order_id:
            req.params.orderId,

          user_id:
            req.session.userId
        });


      if (!payment) {

        return res.status(404).json({
          success: false,
          message:
            'Payment not found.'
        });

      }


      return res.json({
        success: true,

        status:
          payment.status,

        orderId:
          payment.merchant_order_id,

        amount:
          payment.amount / 100,

        paid_at:
          payment.paid_at
      });

    } catch (error) {

      console.error(
        'Payment status error:',
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
            req.session.userId
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
// WITHDRAWAL REQUEST
// =====================================================

app.post(
  '/api/withdrawals',
  login,
  async (req, res) => {

    try {

      const amount =
        Number(req.body.amount);

      const method =
        String(
          req.body.method ||
          'BANK'
        ).toUpperCase();

      const upiId =
        String(
          req.body.upi_id || ''
        ).trim();

      const accountName =
        String(
          req.body.account_name || ''
        ).trim();

      const accountNumber =
        String(
          req.body.account_number || ''
        ).trim();

      const confirmAccountNumber =
        String(
          req.body.confirm_account_number ||
          req.body.confirmAccountNumber ||
          ''
        ).trim();

      const ifsc =
        String(
          req.body.ifsc || ''
        ).trim().toUpperCase();


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


      /*
       * Current withdrawal system supports
       * UPI/BANK manually.
       *
       * RS Payment withdrawal API supports
       * BANK details only, so we keep the
       * existing withdrawal system here.
       */

      if (
        method === 'UPI' &&
        !upiId
      ) {

        return res.status(400).json({
          success: false,
          message:
            'UPI ID is required.'
        });

      }


      if (
        method === 'BANK'
      ) {

        if (
          !accountName ||
          !accountNumber ||
          !ifsc
        ) {

          return res.status(400).json({
            success: false,
            message:
              'Bank account details are required.'
          });

        }


        if (
          confirmAccountNumber &&
          accountNumber !==
          confirmAccountNumber
        ) {

          return res.status(400).json({
            success: false,
            message:
              'Bank account numbers do not match.'
          });

        }


        if (
          !/^[A-Z]{4}0[A-Z0-9]{6}$/i.test(
            ifsc
          )
        ) {

          return res.status(400).json({
            success: false,
            message:
              'Invalid IFSC code.'
          });

        }

      }


      const amountPaise =
        Math.round(
          amount * 100
        );


      const mongoSession =
        await mongoose.startSession();


      let withdrawal;


      try {

        await mongoSession.withTransaction(
          async () => {

            const wallet =
              await ensureWallet(
                req.session.userId,
                mongoSession
              );


            const balance =
              Number(
                wallet.balance || 0
              );


            if (
              balance <
              amountPaise
            ) {

              throw new Error(
                'Insufficient wallet balance.'
              );

            }


            const newBalance =
              balance -
              amountPaise;


            wallet.balance =
              newBalance;

            wallet.updated_at =
              new Date();


            await wallet.save({
              session:
                mongoSession
            });


            const created =
              await Withdrawal.create(
                [
                  {
                    user_id:
                      req.session.userId,

                    amount:
                      amountPaise,

                    currency:
                      'INR',

                    method,

                    upi_id:
                      method === 'UPI'
                        ? upiId
                        : null,

                    account_name:
                      method === 'BANK'
                        ? accountName
                        : null,

                    account_last4:
                      method === 'BANK'
                        ? accountNumber.slice(-4)
                        : null,

                    ifsc:
                      method === 'BANK'
                        ? ifsc
                        : null,

                    status:
                      'pending',

                    created_at:
                      new Date()
                  }
                ],
                {
                  session:
                    mongoSession
                }
              );


            withdrawal =
              created[0];


            await WalletTransaction.create(
              [
                {
                  user_id:
                    req.session.userId,

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
        );


      } catch (error) {

        if (
          error.message ===
          'Insufficient wallet balance.'
        ) {

          return res.status(400).json({
            success: false,
            message:
              error.message
          });

        }

        throw error;

      } finally {

        await mongoSession.endSession();

      }


      return res.json({
        success: true,

        message:
          'Withdrawal request submitted and amount reserved.',

        withdrawal: {
          id:
            withdrawal._id,

          amount:
            amount,

          status:
            withdrawal.status
        }
      });

    } catch (error) {

      console.error(
        'Withdrawal error:',
        error
      );

      return res.status(500).json({
        success: false,
        message:
          'Unable to submit withdrawal request.'
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
            req.session.userId
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
            'name phone referral_code referred_by'
          )
          .sort({
            _id: -1
          })
          .lean();


      const result = [];


      for (const user of users) {

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

          referral_code:
            user.referral_code,

          referred_by:
            user.referred_by,

          balance:
            Number(
              wallet?.balance || 0
            ) / 100
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
// ADMIN BALANCE ADJUSTMENT
// =====================================================

app.post(
  '/api/admin/users/:userId/balance',
  admin,
  async (req, res) => {

    try {

      const userId =
        req.params.userId;

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


      const mongoSession =
        await mongoose.startSession();


      let newBalance;


      try {

        await mongoSession.withTransaction(
          async () => {

            const user =
              await User.findById(
                userId
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


            if (
              type === 'credit'
            ) {

              newBalance =
                oldBalance +
                amountPaise;

            } else {

              newBalance =
                oldBalance -
                amountPaise;

            }


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
                    type === 'credit'
                      ? 'credit'
                      : 'debit',

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


      } catch (error) {

        if (
          error.message ===
            'User not found.' ||
          error.message ===
            'Insufficient wallet balance.'
        ) {

          return res.status(400).json({
            success: false,
            message:
              error.message
          });

        }

        throw error;

      } finally {

        await mongoSession.endSession();

      }


      return res.json({
        success: true,

        message:
          reason,

        balance:
          newBalance / 100
      });

    } catch (error) {

      console.error(
        'Admin balance error:',
        error
      );

      return res.status(500).json({
        success: false,
        message:
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
// ADMIN COMPLETE WITHDRAWAL
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


      if (
        withdrawal.status !==
        'pending'
      ) {

        return res.status(400).json({
          success: false,
          message:
            'Withdrawal is already processed.'
        });

      }


      withdrawal.status =
        'completed';

      withdrawal.processed_at =
        new Date();


      await withdrawal.save();


      return res.json({
        success: true,
        message:
          'Withdrawal marked as completed.'
      });

    } catch (error) {

      console.error(
        'Complete withdrawal error:',
        error
      );

      return res.status(500).json({
        success: false,
        message:
          'Unable to complete withdrawal.'
      });

    }

  }
);


// =====================================================
// ADMIN REJECT WITHDRAWAL + REFUND
// =====================================================

app.post(
  '/api/admin/withdrawals/:id/reject',
  admin,
  async (req, res) => {

    const mongoSession =
      await mongoose.startSession();


    try {

      await mongoSession.withTransaction(
        async () => {

          const withdrawal =
            await Withdrawal.findById(
              req.params.id
            ).session(
              mongoSession
            );


          if (!withdrawal) {
            throw new Error(
              'Withdrawal not found.'
            );
          }


          if (
            withdrawal.status !==
            'pending'
          ) {

            throw new Error(
              'Withdrawal is already processed.'
            );

          }


          const wallet =
            await ensureWallet(
              withdrawal.user_id,
              mongoSession
            );


          const oldBalance =
            Number(
              wallet.balance || 0
            );


          const newBalance =
            oldBalance +
            Number(
              withdrawal.amount
            );


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
                  withdrawal.user_id,

                type:
                  'refund',

                amount:
                  withdrawal.amount,

                balance_after:
                  newBalance,

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


          withdrawal.status =
            'rejected';

          withdrawal.processed_at =
            new Date();


          await withdrawal.save({
            session:
              mongoSession
          });

        }
      );


      return res.json({
        success: true,
        message:
          'Withdrawal rejected and amount refunded.'
      });

    } catch (error) {

      console.error(
        'Reject withdrawal error:',
        error
      );

      return res.status(400).json({
        success: false,
        message:
          error.message ||
          'Unable to reject withdrawal.'
      });

    } finally {

      await mongoSession.endSession();

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


      const pendingWithdrawals =
        await Withdrawal.countDocuments({
          status: 'pending'
        });


      const completedWithdrawals =
        await Withdrawal.countDocuments({
          status: 'completed'
        });


      const paymentCount =
        await Payment.countDocuments({
          status: 'paid'
        });


      return res.json({
        success: true,

        total_users:
          totalUsers,

        pending_withdrawals:
          pendingWithdrawals,

        completed_withdrawals:
          completedWithdrawals,

        successful_payments:
          paymentCount
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
    path.join(__dirname)
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


    if (res.headersSent) {
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
      'RS Payment:',
      RSPAY_MERCHANT_ID
        ? 'configured'
        : 'NOT configured'
    );


    app.listen(
      PORT,
      () => {

        console.log(
          `TRUE WALK server running on port ${PORT}`
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
