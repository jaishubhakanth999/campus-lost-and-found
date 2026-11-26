'use strict';

/**
 * Request schemas. Anything not listed here is discarded — handlers only ever
 * receive parsed, typed values, and a query string such as
 * ?status[$ne]=open fails validation instead of reaching SQL.
 */

const { z } = require('zod');
const { CATEGORIES, STATUSES } = require('../services/itemService');

const uuid = z.string().uuid('Invalid identifier');
const email = z
  .string()
  .trim()
  .min(3)
  .max(254)
  .email('Enter a valid email address')
  .transform((v) => v.toLowerCase());
const password = z.string().min(8, 'Use at least 8 characters').max(128);

const dateOnly = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, 'Use the date picker (YYYY-MM-DD)')
  .refine((v) => {
    const d = new Date(`${v}T00:00:00Z`);
    return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === v;
  }, 'That date does not exist')
  .refine((v) => new Date(`${v}T23:59:59Z`) <= new Date(Date.now() + 24 * 3600 * 1000), 'The date cannot be in the future');

const timeOnly = z
  .string()
  .regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'Use 24-hour time, e.g. 14:30')
  .optional()
  .or(z.literal('').transform(() => undefined));

/* ---------------------------------- auth ---------------------------------- */

const register = z.object({
  name: z.string().trim().min(2, 'Enter your full name').max(80),
  email,
  password,
});

const login = z.object({
  email,
  password: z.string().min(1, 'Enter your password').max(128),
  portal: z.enum(['student', 'admin']).optional().default('student'),
});

const verifyOtp = z.object({
  email,
  code: z.string().regex(/^\d{6}$/, 'Enter the 6-digit code'),
  purpose: z.enum(['signup', 'login', 'admin_login']).optional().default('login'),
});

const resendOtp = z.object({
  email,
  purpose: z.enum(['signup', 'login', 'admin_login']).optional().default('login'),
});

const updateProfile = z.object({
  name: z.string().trim().min(2).max(80).optional(),
  // Accept both spellings; the service stores student_id.
  studentId: z.string().trim().max(40).optional().or(z.literal('')),
  student_id: z.string().trim().max(40).optional().or(z.literal('')),
  department: z.string().trim().max(80).optional().or(z.literal('')),
  phone: z
    .string()
    .trim()
    .regex(/^[+]?[0-9 ()-]{7,20}$/, 'Enter a valid phone number')
    .optional()
    .or(z.literal('')),
});

const changePassword = z.object({
  currentPassword: z.string().min(1).max(128),
  newPassword: password,
});

/* ---------------------------------- items --------------------------------- */

const itemCreate = z.object({
  type: z.enum(['lost', 'found']),
  title: z.string().trim().min(3, 'Give the item a name').max(100),
  category: z.enum(CATEGORIES),
  description: z.string().trim().min(10, 'Add a little more detail').max(1000),
  location: z.string().trim().min(2, 'Where was it lost or found?').max(120),
  occurredOn: dateOnly,
  occurredTime: timeOnly,
  additionalInfo: z.string().trim().max(500).optional().or(z.literal('')),
});

const itemUpdate = itemCreate.partial();

const itemStatus = z.object({
  status: z.enum(STATUSES.filter((s) => s !== 'removed')),
  note: z.string().trim().max(300).optional(),
});

const listQuery = z.object({
  page: z.coerce.number().int().min(1).max(1000).optional().default(1),
  limit: z.coerce.number().int().min(1).max(50).optional().default(12),
  type: z.enum(['lost', 'found']).optional(),
  category: z.enum(CATEGORIES).optional(),
  status: z.enum(['open', 'claimed', 'returned', 'closed']).optional(),
  location: z.string().trim().max(60).optional(),
  search: z.string().trim().max(80).optional(),
  sort: z.enum(['newest', 'oldest', 'recent']).optional().default('newest'),
});

const idParam = z.object({ id: uuid });

/* --------------------------------- claims --------------------------------- */

const claimCreate = z.object({
  itemId: uuid,
  message: z.string().trim().min(10, 'Describe details only the owner would know').max(1000),
});

const claimDecision = z.object({
  decision: z.enum(['approved', 'rejected']),
  note: z.string().trim().max(500).optional(),
});

const handover = z.object({
  place: z.string().trim().min(3).max(120),
  at: z.string().datetime({ offset: true }).optional().or(z.literal('').transform(() => undefined)),
});

/* ---------------------------------- admin --------------------------------- */

const adminUsersQuery = z.object({
  page: z.coerce.number().int().min(1).optional().default(1),
  limit: z.coerce.number().int().min(1).max(100).optional().default(20),
  search: z.string().trim().max(80).optional(),
  role: z.enum(['student', 'admin']).optional(),
  status: z.enum(['active', 'suspended', 'deleted']).optional(),
  verified: z.enum(['true', 'false']).optional(),
});

const adminUserPatch = z
  .object({
    role: z.enum(['student', 'admin']).optional(),
    status: z.enum(['active', 'suspended']).optional(),
  })
  .refine((v) => v.role || v.status, 'Nothing to update');

const adminSessionsQuery = z.object({
  page: z.coerce.number().int().min(1).optional().default(1),
  limit: z.coerce.number().int().min(1).max(100).optional().default(25),
  userId: uuid.optional(),
  status: z.enum(['active', 'logged_out', 'expired', 'revoked']).optional(),
});

const adminItemsQuery = z.object({
  page: z.coerce.number().int().min(1).optional().default(1),
  limit: z.coerce.number().int().min(1).max(100).optional().default(20),
  search: z.string().trim().max(80).optional(),
  type: z.enum(['lost', 'found']).optional(),
  status: z.enum(STATUSES).optional(),
  moderation: z.enum(['pending', 'approved', 'rejected']).optional(),
});

const adminClaimsQuery = z.object({
  page: z.coerce.number().int().min(1).optional().default(1),
  limit: z.coerce.number().int().min(1).max(100).optional().default(20),
  status: z.enum(['pending', 'approved', 'rejected', 'withdrawn', 'completed']).optional(),
});

const adminModerate = z.object({
  action: z.enum(['approve', 'reject', 'remove', 'restore']),
  note: z.string().trim().max(300).optional(),
});

const adminAuditQuery = z.object({
  page: z.coerce.number().int().min(1).optional().default(1),
  limit: z.coerce.number().int().min(1).max(100).optional().default(25),
  action: z.string().trim().max(60).optional(),
});

const adminEventsQuery = z.object({
  page: z.coerce.number().int().min(1).optional().default(1),
  limit: z.coerce.number().int().min(1).max(100).optional().default(25),
  event: z
    .enum([
      'register',
      'login_success',
      'login_failed',
      'otp_sent',
      'otp_failed',
      'otp_verified',
      'otp_expired',
      'logout',
      'session_revoked',
      'admin_login_success',
      'admin_login_failed',
      'password_reset_requested',
    ])
    .optional(),
  email: z.string().trim().max(120).optional(),
});

module.exports = {
  register,
  login,
  verifyOtp,
  resendOtp,
  updateProfile,
  changePassword,
  itemCreate,
  itemUpdate,
  itemStatus,
  listQuery,
  idParam,
  claimCreate,
  claimDecision,
  handover,
  adminUsersQuery,
  adminUserPatch,
  adminSessionsQuery,
  adminItemsQuery,
  adminClaimsQuery,
  adminModerate,
  adminAuditQuery,
  adminEventsQuery,
};
