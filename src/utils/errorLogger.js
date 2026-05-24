/**
 * AasPass — Centralised Error Logger
 *
 * Fire-and-forget: always logs to console (Railway live logs) AND writes a row
 * to the error_logs Supabase table for historical querying.
 *
 * Never throws — a logging failure must NEVER break the user-facing flow.
 *
 * Usage:
 *   const { logError } = require('../utils/errorLogger');
 *
 *   logError({
 *     severity:    'ERROR',              // INFO | WARNING | ERROR | CRITICAL
 *     type:        'WHATSAPP',           // broad category
 *     operation:   'sendText',           // specific function/operation name
 *     message:     e.message,            // human-readable description
 *     phone:       '919876543210',       // affected user phone (nullable)
 *     userState:   'WAITING',            // FSM state at time of error (nullable)
 *     waMessageId: msg.id,               // WhatsApp message ID for tracing (nullable)
 *     requestId:   reqId,                // internal correlation ID (nullable)
 *     error:       e,                    // the actual Error object (nullable)
 *     context:     { raw: apiResponse }, // extra data — auto-sanitized before storing
 *   });
 *
 * Sensitive keys are automatically redacted before anything is written to the DB.
 */

const supabase = require('../config/supabase');

// ── Sensitive-key redaction ───────────────────────────────────────────────────

const SENSITIVE_KEYS = new Set([
  'access_token', 'token', 'authorization', 'api_key', 'apiKey',
  'secret', 'password', 'key', 'WHATSAPP_TOKEN', 'SUPABASE_SERVICE_KEY',
  'RAZORPAY_KEY_SECRET', 'RAZORPAY_WEBHOOK_SECRET', 'SESSION_SECRET',
  'WEBHOOK_VERIFY_TOKEN', 'OPENCAGE_API_KEY', 'MAPPLS_API_KEY',
  'cookie', 'set-cookie',
]);

function sanitize(obj, depth = 0) {
  if (!obj || typeof obj !== 'object' || depth > 4) return obj;
  if (Array.isArray(obj)) return obj.map(v => sanitize(v, depth + 1));
  const clean = {};
  for (const [k, v] of Object.entries(obj)) {
    clean[k] = SENSITIVE_KEYS.has(k) ? '[REDACTED]' : sanitize(v, depth + 1);
  }
  return clean;
}

// ── Core logger ───────────────────────────────────────────────────────────────

async function logError({
  severity    = 'ERROR',
  type        = 'INTERNAL',
  operation   = null,
  message     = 'Unknown error',
  phone       = null,
  userState   = null,
  waMessageId = null,
  requestId   = null,
  error       = null,
  context     = null,
} = {}) {

  // ── 1. Console first — always works, never blocked by DB ──
  const tag = `[${severity}][${type}]${operation ? `[${operation}]` : ''}`;
  console.error(`${tag} ${message}`, error instanceof Error ? error.stack : (error || ''));

  // ── 2. DB insert — fire-and-forget ──
  try {
    const stack       = error instanceof Error ? error.stack?.slice(0, 5000) : null;
    const safeContext = context ? sanitize(context) : null;

    // Guard: supabase client may not be initialised in unit tests
    if (!supabase) return;

    await supabase.from('error_logs').insert({
      severity,
      error_type:     type,
      operation_name: operation,
      phone,
      user_state:     userState,
      message:        String(message).slice(0, 2000),
      stack,
      context:        safeContext,
      wa_message_id:  waMessageId,
      request_id:     requestId,
    });
  } catch (logErr) {
    // Logging itself failed — fall back to console, never re-throw
    console.error('[LOGGER] Failed to write to error_logs:', logErr.message);
  }
}

module.exports = { logError };
