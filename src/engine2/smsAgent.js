/**
 * CareX — SMS Monitoring Agent
 * Engine 2, Module 3
 *
 * Intercepts patient SMS cancellations via a Twilio number.
 * Provider gives patients the CareX scheduling number instead
 * of their front desk — we handle the signals automatically.
 *
 * Two modes:
 *   1. Dedicated number: Provider uses CareX Twilio number for scheduling
 *   2. Forward mode: Existing number forwards to CareX via Twilio
 *
 * Pipeline:
 *   Patient texts → Twilio webhook → PHI scrub →
 *   AI intent → Engine 1 slot event → Auto-reply to patient
 *
 * HIPAA: Phone numbers are tokenized immediately on receipt.
 *        Agent never processes raw phone numbers.
 */

import { scrubText, generateToken } from '../hipaa/phiScrubber.js';
import { log, logError, ACTIONS } from '../hipaa/auditLogger.js';
import { ingestSignal, signalToSlotEvent, SIGNAL_SOURCES } from './agentCore.js';

// ─── Number Registry ─────────────────────────────────────────
const numberRegistry = new Map(); // twilioNumber → providerId

function registerProviderNumber(providerId, twilioNumber) {
  numberRegistry.set(twilioNumber, providerId);
  log(ACTIONS.PROVIDER_RULE_SET, {
    actorId: providerId,
    actorType: 'provider',
    details: { smsRegistered: true, twilioNumber: twilioNumber.slice(-4) + '****' },
  });
}

function getProviderByNumber(twilioNumber) {
  return numberRegistry.get(twilioNumber);
}

// ─── Twilio Webhook Handler ───────────────────────────────────
async function handleIncomingSMS(req, res) {
  const twimlAck = `<?xml version="1.0" encoding="UTF-8"?>
<Response><Message>Got it. We'll follow up shortly.</Message></Response>`;
  res.type('text/xml').send(twimlAck);

  const rawBody = req.body?.Body || '';
  const fromNumber = req.body?.From || '';
  const toNumber = req.body?.To || '';

  if (!rawBody || !fromNumber || !toNumber) return;

  const providerId = getProviderByNumber(toNumber);
  if (!providerId) {
    logError({
      action: 'SMS_UNKNOWN_NUMBER',
      error: new Error(`No provider for number ${toNumber.slice(-4)}`),
      context: {},
    });
    return;
  }

  try {
    await processSMS(providerId, rawBody, fromNumber);
  } catch (err) {
    logError({ action: 'SMS_PROCESS_ERROR', error: err, context: { providerId } });
  }
}

// ─── SMS Processing Pipeline ──────────────────────────────────
async function processSMS(providerId, rawBody, fromNumber) {
  const phoneToken = generateToken('phone', fromNumber);
  const { scrubbedText, fieldCount } = scrubText(rawBody);

  const intent = await extractSMSIntent(scrubbedText);

  if (!intent || intent.type === 'irrelevant') return null;

  const cleanSignal = await ingestSignal(providerId, {
    source: SIGNAL_SOURCES.SMS_TWILIO,
    signalType: intent.type,
    text: scrubbedText,
    metadata: {
      phoneToken,
      intentType: intent.type,
      confidence: intent.confidence,
      phiFields: fieldCount,
    },
  });

  if (intent.confidence >= 0.72) {
    const slotEvent = await signalToSlotEvent(providerId, cleanSignal, {
      eventId: `sms_${phoneToken}_${Date.now()}`,
      slotStart: intent.slotStart || null,
      slotEnd: intent.slotEnd || null,
      status: intent.type === 'cancellation' ? 'cancelled' : 'changed',
      patientPhone: phoneToken,
    });

    await sendAutoReply(fromNumber, intent, providerId);
    return slotEvent;
  }

  await sendClarificationRequest(fromNumber, scrubbedText);
  return null;
}

// ─── SMS Intent Extraction ────────────────────────────────────
async function extractSMSIntent(scrubbedText) {
  const ruled = ruleBasedSMSIntent(scrubbedText);
  if (ruled.confidence >= 0.80) return ruled;

  if (!process.env.ANTHROPIC_API_KEY) return ruled;

  try {
    const prompt = `Classify this medical appointment SMS (patient identifiers replaced with tokens):

"${scrubbedText.slice(0, 300)}"

Respond ONLY with JSON:
{
  "type": "cancellation|reschedule|confirmation|question|irrelevant",
  "confidence": 0.0-1.0,
  "slotStart": "ISO datetime if mentioned, else null",
  "slotEnd": null
}`;

    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': process.env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 150,
        messages: [{ role: 'user', content: prompt }],
      }),
    });

    if (!response.ok) throw new Error(`API ${response.status}`);

    const data = await response.json();
    const text = data.content?.[0]?.text || '{}';
    const clean = text.replace(/```json|```/g, '').trim();
    return JSON.parse(clean);

  } catch (err) {
    logError({ action: 'SMS_INTENT_AI_ERROR', error: err, context: {} });
    return ruled;
  }
}

function ruleBasedSMSIntent(text) {
  const t = text.toLowerCase();

  if (/\bcancel\b|\bcan't make\b|\bcannot make\b|\bwon't be\b|\bunable\b/i.test(t)) {
    return { type: 'cancellation', confidence: 0.90, slotStart: null, slotEnd: null };
  }
  if (/reschedul|need to move|different time|another day/i.test(t)) {
    return { type: 'reschedule', confidence: 0.88, slotStart: null, slotEnd: null };
  }
  if (/confirm|yes|i'll be there|on my way|coming in/i.test(t)) {
    return { type: 'confirmation', confidence: 0.85, slotStart: null, slotEnd: null };
  }
  if (/\?|what time|where|address|directions/i.test(t)) {
    return { type: 'question', confidence: 0.78, slotStart: null, slotEnd: null };
  }
  return { type: 'irrelevant', confidence: 0.55, slotStart: null, slotEnd: null };
}

// ─── Auto-Reply System ────────────────────────────────────────
const AUTO_REPLIES = {
  cancellation: () =>
    `Got it — your appointment has been cancelled. You'll receive a confirmation shortly. To rebook, reply BOOK or visit our portal.`,

  reschedule: () =>
    `Thanks — we'll find you a new time. A team member will follow up within the hour. Or visit our portal to self-schedule.`,

  confirmation: () =>
    `You're confirmed! See you soon. Reply CANCEL if your plans change.`,

  question: () =>
    `Thanks for your message. A team member will respond shortly. For urgent matters, please call the office directly.`,
};

async function sendAutoReply(toNumber, intent, providerId) {
  if (!process.env.TWILIO_ACCOUNT_SID || !process.env.TWILIO_AUTH_TOKEN) {
    console.log(`[SMS AUTO-REPLY → ${toNumber.slice(-4)}]`, intent.type);
    return;
  }

  const replyFn = AUTO_REPLIES[intent.type] || AUTO_REPLIES.question;
  const body = replyFn(providerId);
  const fromNumber = process.env.TWILIO_PHONE_NUMBER;

  await fetch(
    `https://api.twilio.com/2010-04-01/Accounts/${process.env.TWILIO_ACCOUNT_SID}/Messages.json`,
    {
      method: 'POST',
      headers: {
        Authorization: `Basic ${Buffer.from(`${process.env.TWILIO_ACCOUNT_SID}:${process.env.TWILIO_AUTH_TOKEN}`).toString('base64')}`,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: new URLSearchParams({ To: toNumber, From: fromNumber, Body: body }),
    }
  );
}

async function sendClarificationRequest(toNumber, scrubbedText) {
  console.log(`[SMS CLARIFY → ${toNumber.slice(-4)}] Requesting clarification for: "${scrubbedText.slice(0, 50)}"`);

  if (!process.env.TWILIO_ACCOUNT_SID) return;

  const body = `Hi! We received your message but need a bit more info. Are you trying to cancel or reschedule an appointment? Reply CANCEL or RESCHEDULE.`;

  await fetch(
    `https://api.twilio.com/2010-04-01/Accounts/${process.env.TWILIO_ACCOUNT_SID}/Messages.json`,
    {
      method: 'POST',
      headers: {
        Authorization: `Basic ${Buffer.from(`${process.env.TWILIO_ACCOUNT_SID}:${process.env.TWILIO_AUTH_TOKEN}`).toString('base64')}`,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: new URLSearchParams({
        To: toNumber,
        From: process.env.TWILIO_PHONE_NUMBER,
        Body: body,
      }),
    }
  );
}

// ─── Exports ─────────────────────────────────────────────────
export {
  handleIncomingSMS,
  processSMS,
  extractSMSIntent,
  registerProviderNumber,
  getProviderByNumber,
  ruleBasedSMSIntent,
};

export default {
  handleIncomingSMS,
  processSMS,
  extractSMSIntent,
  registerProviderNumber,
  getProviderByNumber,
  ruleBasedSMSIntent,
};
