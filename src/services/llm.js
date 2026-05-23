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

const STATE_ACTIONS = {
  WAITING:       ['MATCHES', 'CANCEL', 'EDIT_PICKUP', 'EDIT_DROP', 'STATUS', 'HELP', 'RESTART'],
  WAITING_RETRY: ['EXTEND_YES', 'EXTEND_NO', 'HELP'],
  MATCH_SENT:    ['CANCEL', 'EDIT_PICKUP', 'EDIT_DROP', 'STATUS', 'HELP'],
  MATCH_RECEIVED:['ACCEPT', 'DECLINE', 'HELP'],
  MATCHED:       ['TRIP_DONE', 'REPORT_ISSUE', 'CANCEL', 'STATUS', 'HELP'],
  IDLE:          ['START', 'HELP'],
  COMPLETED:     ['START', 'HELP'],
};

// ── System prompt (keep short → fewer tokens → cheaper) ──────────────────────

function buildSystemPrompt(state) {
  const actions = (STATE_ACTIONS[state] || ['HELP', 'STATUS', 'UNKNOWN']).join(', ');
  return `You are an intent classifier for AasPass, a WhatsApp cab-splitting app.
User state: ${state}. Valid actions: ${actions}, UNKNOWN.

Rules:
- Reply ONLY with valid JSON: {"action":"ACTION","followup":null}
- "followup" is a short reply to send if action is UNKNOWN or needs clarification (max 1 sentence), else null.
- Be generous — "stop searching", "quit", "exit" all → CANCEL
- "any luck?", "found someone?", "show options" → MATCHES
- "change pickup", "update my start" → EDIT_PICKUP
- "change drop", "update destination", "going to X instead" → EDIT_DROP
- "all done", "trip complete", "reached" → TRIP_DONE
- "problem", "issue", "complaint", "he was rude" → REPORT_ISSUE
- "extend", "yes keep looking", "5 more" → EXTEND_YES
- "no stop", "give up", "forget it" → EXTEND_NO
- Greetings / off-topic → UNKNOWN with a helpful followup hint.`;
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
      timeout: 8000,
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
      timeout: 8000,
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
