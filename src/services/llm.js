/**
 * LLM Intent Classifier for AasPass
 *
 * Only fires when a user sends ambiguous text that doesn't match
 * any known command. Buttons, locations, list taps never reach here.
 *
 * Supports:  OpenAI (gpt-4o-mini)  ← default, cheapest
 *            Anthropic (claude-haiku-3-5)  ← set LLM_PROVIDER=anthropic
 *
 * Cost estimate (gpt-4o-mini):
 *   ~500 tokens per call × $0.15/1M input + $0.60/1M output ≈ $0.00008 per call
 *   1,000 ambiguous texts/day ≈ $0.08/day = ~$2.5/month
 */

const axios = require('axios');

const ENABLED  = process.env.LLM_ENABLED !== 'false'; // default ON if key exists
const PROVIDER = (process.env.LLM_PROVIDER || 'openai').toLowerCase();
const MODEL    = process.env.LLM_MODEL || (PROVIDER === 'anthropic' ? 'claude-haiku-3-5-20241022' : 'gpt-4o-mini');

// ── What actions are valid in each state ──────────────────────────────────────
// LLM will only return actions from this list for the current state.
// This prevents the LLM from suggesting actions impossible in the current context.

const STATE_ACTIONS = {
  // ── Pre-pool / onboarding ──
  IDLE:                        ['START', 'HELP'],
  COMPLETED:                   ['START', 'HELP'],
  ONBOARDING_NAME:             ['CANCEL', 'HELP'],
  ONBOARDING_GENDER:           ['CANCEL', 'HELP'],
  ONBOARDING_PREFERRED_GENDER: ['CANCEL', 'HELP'],
  ONBOARDING_PICKUP:           ['CANCEL', 'HELP'],
  ONBOARDING_DROP:             ['CANCEL', 'HELP'],
  ONBOARDING_CONFIRM:          ['CONFIRM', 'CANCEL', 'HELP'],
  EDITING_NAME:                ['CANCEL', 'HELP'],
  EDITING_GENDER:              ['CANCEL', 'HELP'],
  EDITING_PREFERRED_GENDER:    ['CANCEL', 'HELP'],
  EDITING_PICKUP:              ['CANCEL', 'HELP'],
  EDITING_DROP:                ['CANCEL', 'HELP'],
  // ── Active pool states ──
  WAITING:                     ['MATCHES', 'CANCEL', 'EDIT_PICKUP', 'EDIT_DROP', 'STATUS', 'HELP', 'RESTART'],
  WAITING_RETRY:               ['EXTEND_YES', 'EXTEND_NO', 'HELP'],
  MATCH_SENT:                  ['CANCEL', 'EDIT_PICKUP', 'EDIT_DROP', 'STATUS', 'HELP'],
  MATCH_RECEIVED:              ['ACCEPT', 'DECLINE', 'HELP'],
  MATCHED:                     ['TRIP_DONE', 'REPORT_ISSUE', 'CANCEL', 'STATUS', 'HELP'],
  POOL_EDIT_PICKUP:            ['CANCEL', 'HELP'],
  POOL_EDIT_DROP:              ['CANCEL', 'HELP'],
  // ── Post-match ──
  RATING:                      ['HELP'],
  RATING_FEEDBACK:             ['HELP'],
  REPORTING:                   ['HELP'],
};

// ── System prompt (keep short → fewer tokens → cheaper) ──────────────────────

function buildSystemPrompt(state) {
  const actions = (STATE_ACTIONS[state] || ['HELP', 'UNKNOWN']).join(', ');
  return `You are an intent classifier for AasPass, a WhatsApp cab-splitting app.
User state: ${state}. Valid actions: ${actions}, UNKNOWN.

Rules:
- Reply ONLY with valid JSON: {"action":"ACTION","followup":null}
- "followup": 1-sentence WhatsApp reply when action is UNKNOWN (else null). Keep friendly, plain text, no markdown.
- Always pick the closest valid action. Only use UNKNOWN if truly off-topic.

Intent mappings (use only actions listed as valid for current state):
  START      ← "hi", "hello", "start", "begin", any greeting from IDLE/COMPLETED
  CANCEL     ← "cancel", "stop", "quit", "exit", "go back", "start over", "nevermind"
  CONFIRM    ← "yes", "confirm", "looks good", "ok", "proceed"
  MATCHES    ← "any luck?", "found someone?", "show matches", "who's available", "options"
  EDIT_PICKUP ← "change pickup", "update my start", "pickup is wrong", "edit where I'm starting"
  EDIT_DROP  ← "change drop", "change destination", "going to X instead", "update my drop"
  TRIP_DONE  ← "all done", "trip complete", "reached", "we made it", "finished"
  REPORT_ISSUE ← "problem", "issue", "complaint", "he was rude", "report"
  EXTEND_YES ← "yes keep looking", "extend", "5 more minutes", "keep searching"
  EXTEND_NO  ← "no stop", "give up", "forget it", "stop searching"
  ACCEPT     ← "accept", "yes I'll share", "sounds good"
  DECLINE    ← "decline", "no thanks", "reject", "not interested"
  STATUS     ← "what's my status", "where am I", "my details"
  HELP       ← "help", "what can I do", "commands", "options"
  RESTART    ← "restart", "start fresh", "reset"
  UNKNOWN    ← off-topic questions, typos with no clear intent, location names (NOT commands)`;
}

// ── OpenAI call ───────────────────────────────────────────────────────────────

async function callOpenAI(systemPrompt, userMessage) {
  const key = process.env.OPENAI_API_KEY;
  if (!key) throw new Error('OPENAI_API_KEY not set');

  const res = await axios.post(
    'https://api.openai.com/v1/chat/completions',
    {
      model:       MODEL,
      temperature: 0,
      max_tokens:  60,
      messages: [
        { role: 'system',  content: systemPrompt },
        { role: 'user',    content: userMessage  },
      ],
    },
    {
      headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
      timeout: 2500, // hard 2.5s — LLM must not block user experience
    }
  );

  return res.data.choices[0].message.content.trim();
}

// ── Anthropic call ────────────────────────────────────────────────────────────

async function callAnthropic(systemPrompt, userMessage) {
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) throw new Error('ANTHROPIC_API_KEY not set');

  const res = await axios.post(
    'https://api.anthropic.com/v1/messages',
    {
      model:      MODEL,
      max_tokens: 60,
      system:     systemPrompt,
      messages:   [{ role: 'user', content: userMessage }],
    },
    {
      headers: {
        'x-api-key':         key,
        'anthropic-version': '2023-06-01',
        'Content-Type':      'application/json',
      },
      timeout: 2500,
    }
  );

  return res.data.content[0].text.trim();
}

// ── Main exported function ────────────────────────────────────────────────────

/**
 * Classify user intent from a natural language message.
 * @param {string} message   - raw user text
 * @param {string} state     - current user state
 * @returns {{ action: string, followup: string|null }}
 */
async function detectIntent(message, state) {
  const hasKey = PROVIDER === 'anthropic'
    ? !!process.env.ANTHROPIC_API_KEY
    : !!process.env.OPENAI_API_KEY;

  if (!ENABLED || !hasKey) return { action: 'UNKNOWN', followup: null };

  const systemPrompt = buildSystemPrompt(state);
  const userMessage  = `Message: "${message.slice(0, 300)}"`;

  try {
    const raw = PROVIDER === 'anthropic'
      ? await callAnthropic(systemPrompt, userMessage)
      : await callOpenAI(systemPrompt, userMessage);

    // Extract JSON even if model adds surrounding text
    const jsonMatch = raw.match(/\{[\s\S]*\}/);
    if (!jsonMatch) throw new Error('No JSON in response');

    const parsed = JSON.parse(jsonMatch[0]);
    const validActions = [...(STATE_ACTIONS[state] || []), 'UNKNOWN'];

    return {
      action:   validActions.includes(parsed.action) ? parsed.action : 'UNKNOWN',
      followup: parsed.followup || null,
    };

  } catch (e) {
    console.error('LLM detectIntent error:', e.message);
    return { action: 'UNKNOWN', followup: null };
  }
}

module.exports = { detectIntent };
