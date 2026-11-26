'use strict';

/**
 * Configuration layer.
 *
 * Every environment variable the app needs is declared here and validated once
 * at boot. If something is missing or malformed the process exits with a clear
 * list of problems instead of failing later with a confusing database error.
 */

const path = require('node:path');
const dotenv = require('dotenv');
const { z } = require('zod');

dotenv.config({ path: process.env.ENV_FILE || path.join(process.cwd(), '.env') });

const bool = (def) =>
  z
    .string()
    .optional()
    .transform((v) => (v === undefined || v === '' ? def : v === 'true' || v === '1'));

const list = (def = '') =>
  z
    .string()
    .optional()
    .transform((v) => (v === undefined ? def : v))
    .transform((v) =>
      v
        .split(',')
        .map((s) => s.trim().toLowerCase().replace(/^@/, ''))
        .filter(Boolean)
    );

const schema = z
  .object({
    NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
    PORT: z.coerce.number().int().positive().default(3000),
    APP_URL: z.string().url().default('http://localhost:3000'),

    DATABASE_URL: z
      .string()
      .min(10, 'DATABASE_URL is required (Supabase Postgres connection string)'),
    DATABASE_SSL: bool(false),
    DATABASE_POOL_MAX: z.coerce.number().int().positive().default(10),

    JWT_SECRET: z.string().min(32, 'JWT_SECRET must be at least 32 characters'),
    JWT_EXPIRES_IN: z.string().default('12h'),
    SESSION_TTL_HOURS: z.coerce.number().int().positive().default(72),

    ALLOWED_EMAIL_DOMAINS: list(''),
    ALLOWED_ADMIN_EMAIL_DOMAINS: list(''),
    REQUIRE_EMAIL_DOMAIN: bool(true),

    // bcrypt cost. 12 in production; tests lower it to keep the suite fast.
    BCRYPT_ROUNDS: z.coerce.number().int().min(4).max(15).default(12),
    OTP_PEPPER: z.string().min(32, 'OTP_PEPPER must be at least 32 characters'),
    OTP_TTL_MINUTES: z.coerce.number().int().positive().default(5),
    OTP_MAX_ATTEMPTS: z.coerce.number().int().positive().default(5),
    OTP_RESEND_COOLDOWN_SECONDS: z.coerce.number().int().nonnegative().default(60),
    OTP_MAX_PER_HOUR: z.coerce.number().int().positive().default(6),

    // Password reset links and listing lifetime.
    PASSWORD_RESET_TTL_MINUTES: z.coerce.number().int().positive().default(30),
    ITEM_EXPIRY_DAYS: z.coerce.number().int().positive().default(60),
    ITEM_EXPIRY_WARN_DAYS: z.coerce.number().int().nonnegative().default(7),

    MAIL_TRANSPORT: z.enum(['smtp', 'file', 'capture']).default('file'),
    MAIL_FROM: z.string().default('CampusConnect <no-reply@campusconnect.local>'),
    MAIL_OUTBOX_DIR: z.string().default('tmp/mail-outbox'),
    SMTP_HOST: z.string().optional(),
    SMTP_PORT: z.coerce.number().int().positive().optional(),
    SMTP_SECURE: bool(true),
    SMTP_USER: z.string().optional(),
    SMTP_PASS: z.string().optional(),

    STORAGE_DRIVER: z.enum(['local', 'supabase']).default('local'),
    LOCAL_UPLOAD_DIR: z.string().default('uploads'),
    MAX_UPLOAD_MB: z.coerce.number().positive().default(5),
    SUPABASE_URL: z.string().optional(),
    SUPABASE_SERVICE_ROLE_KEY: z.string().optional(),
    SUPABASE_BUCKET_PUBLIC: z.string().default('item-images'),
    SUPABASE_BUCKET_PRIVATE: z.string().default('claim-evidence'),

    CORS_ORIGINS: list(''),
    TRUST_PROXY: z.string().optional(),
    RATE_LIMIT_WINDOW_MINUTES: z.coerce.number().int().positive().default(15),
    RATE_LIMIT_MAX: z.coerce.number().int().positive().default(600),
    RATE_LIMIT_AUTH_MAX: z.coerce.number().int().positive().default(30),
    RATE_LIMIT_OTP_MAX: z.coerce.number().int().positive().default(10),
    RATE_LIMIT_WRITE_MAX: z.coerce.number().int().positive().default(60),
    LOG_LEVEL: z.enum(['debug', 'info', 'warn', 'error', 'silent']).default('info'),
  })
  .superRefine((v, ctx) => {
    if (v.REQUIRE_EMAIL_DOMAIN && v.ALLOWED_EMAIL_DOMAINS.length === 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['ALLOWED_EMAIL_DOMAINS'],
        message:
          'Set the university email domain(s), e.g. ALLOWED_EMAIL_DOMAINS=your-university.edu.in',
      });
    }
    if (v.MAIL_TRANSPORT === 'smtp') {
      for (const key of ['SMTP_HOST', 'SMTP_PORT', 'SMTP_USER', 'SMTP_PASS']) {
        if (!v[key]) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: [key],
            message: `${key} is required when MAIL_TRANSPORT=smtp`,
          });
        }
      }
    }
    if (v.STORAGE_DRIVER === 'supabase') {
      for (const key of ['SUPABASE_URL', 'SUPABASE_SERVICE_ROLE_KEY']) {
        if (!v[key]) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: [key],
            message: `${key} is required when STORAGE_DRIVER=supabase`,
          });
        }
      }
    }
    if (v.NODE_ENV === 'production' && v.JWT_SECRET.startsWith('dev-')) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['JWT_SECRET'],
        message: 'Refusing to start in production with a development JWT_SECRET',
      });
    }
  });

function buildConfig(source = process.env) {
  const parsed = schema.safeParse(source);
  if (!parsed.success) {
    const lines = parsed.error.issues.map((i) => `  - ${i.path.join('.')}: ${i.message}`);
    const err = new Error(`Invalid configuration:\n${lines.join('\n')}`);
    err.code = 'E_CONFIG';
    throw err;
  }
  const v = parsed.data;

  const adminDomains = v.ALLOWED_ADMIN_EMAIL_DOMAINS.length
    ? v.ALLOWED_ADMIN_EMAIL_DOMAINS
    : v.ALLOWED_EMAIL_DOMAINS;

  // A session must not outlive the token that identifies it, otherwise the
  // history shows "active" rows that can never be used again.
  const tokenHours = (() => {
    const m = /^(\d+)\s*([smhd])$/i.exec(String(v.JWT_EXPIRES_IN).trim());
    if (!m) return v.SESSION_TTL_HOURS;
    const n = Number(m[1]);
    const unit = m[2].toLowerCase();
    return unit === 's' ? n / 3600 : unit === 'm' ? n / 60 : unit === 'h' ? n : n * 24;
  })();
  const sessionHours = Math.min(v.SESSION_TTL_HOURS, Math.max(1, Math.floor(tokenHours)));

  return {
    ...v,
    adminEmailDomains: adminDomains,
    SESSION_TTL_HOURS: sessionHours,
    isProd: v.NODE_ENV === 'production',
    isTest: v.NODE_ENV === 'test',
    trustProxy:
      v.TRUST_PROXY === undefined
        ? v.NODE_ENV === 'production'
          ? 1
          : false
        : v.TRUST_PROXY === 'true'
          ? true
          : Number(v.TRUST_PROXY),
    sessionTtlMs: sessionHours * 3600 * 1000,
    otpTtlMs: v.OTP_TTL_MINUTES * 60 * 1000,
    resetTtlMs: v.PASSWORD_RESET_TTL_MINUTES * 60 * 1000,
  };
}

let cached;
function getConfig() {
  if (!cached) cached = buildConfig(process.env);
  return cached;
}

module.exports = { getConfig, buildConfig, schema };
