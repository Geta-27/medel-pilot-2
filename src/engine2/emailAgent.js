/**
 * CareX — Email Monitoring Agent
 * Engine 2, Module 2
 *
 * Watches provider's email inbox for patient cancellation signals.
 * Two modes:
 *   1. Gmail API (OAuth) — provider grants read access to inbox
 *   2. Forwarding rule — patient cancellations CC'd to agent inbox
 *
 * Pipeline:
 *   Email arrives → PHI scrubbed → AI extracts intent →
 *   Slot details extracted → Fires signal to Engine 1
 *
 * HIPAA: Email content is scrubbed BEFORE any AI call.
 *        Agent never sees patient names, only tokens.
 */

import { scrubText } from '../hipaa/phiScrubber.js';
import { log, logError, ACTIONS } from '../hipaa/auditLogger.js';
import { ingestSignal, signalToSlotEvent, SIGNAL_SOURCES } from './agentCore.js';

// ─── Gmail API Watcher ────────────────────────────────────────
async function setupGmailWatch(providerId, accessToken, webhookTopicName) {
  const response = await fetch(
    'https://gmail.googleapis.com/gmail/v1/users/me/watch',
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        topicName: webhookTopicName,
        labelIds: ['INBOX'],
        labelFilterAction: 'include',
      }),
    }
  );

  if (!response.ok) {
    throw new Error(`Gmail watch setup failed: ${await response.text()}`);
  }

  return await response.json();
}

/**
 * Fetch and process new emails since last check.
 * Called when Gmail webhook fires OR on polling interval.
 */
async function processNewEmails(providerId, accessToken, sinceHistoryId = null) {
  let emails = [];

  if (sinceHistoryId) {
    emails = await fetchEmailsSinceHistory(accessToken, sinceHistoryId);
  } else {
    emails = await fetchRecentEmails(accessToken, 24);
  }

  const results = [];
  for (const email of emails) {
    const result = await processEmail(providerId, email);
    if (result) results.push(result);
  }

  return results;
}

async function fetchEmailsSinceHistory(accessToken, historyId) {
  const response = await fetch(
    `https://gmail.googleapis.com/gmail/v1/users/me/history?startHistoryId=${historyId}&historyTypes=messageAdded`,
    { headers: { Authorization: `Bearer ${accessToken}` } }
  );

  if (!response.ok) return [];

  const data = await response.json();
  const msgIds = (data.history || [])
    .flatMap((h) => h.messagesAdded || [])
    .map((m) => m.message.id);

  return await Promise.all(msgIds.map((id) => fetchEmailById(accessToken, id)));
}

async function fetchRecentEmails(accessToken, hoursBack = 24) {
  const after = Math.floor((Date.now() - hoursBack * 3600000) / 1000);
  const query = `in:inbox after:${after}`;

  const response = await fetch(
    `https://gmail.googleapis.com/gmail/v1/users/me/messages?q=${encodeURIComponent(query)}&maxResults=20`,
    { headers: { Authorization: `Bearer ${accessToken}` } }
  );

  if (!response.ok) return [];

  const data = await response.json();
  const msgIds = (data.messages || []).map((m) => m.id);

  return await Promise.all(msgIds.map((id) => fetchEmailById(accessToken, id)));
}

async function fetchEmailById(accessToken, messageId) {
  const response = await fetch(
    `https://gmail.googleapis.com/gmail/v1/users/me/messages/${messageId}?format=full`,
    { headers: { Authorization: `Bearer ${accessToken}` } }
  );

  if (!response.ok) return null;

  const msg = await response.json();
  const headers = msg.payload?.headers || [];

  const subject = headers.find((h) => h.name === 'Subject')?.value || '';
  const from = headers.find((h) => h.name === 'From')?.value || '';
  const date = headers.find((h) => h.name === 'Date')?.value || '';
  const body = extractEmailBody(msg.payload);

  return { messageId, subject, from, date, body };
}

function extractEmailBody(payload) {
  if (!payload) return '';

  if (payload.parts) {
    for (const part of payload.parts) {
      if (part.mimeType === 'text/plain' && part.body?.data) {
        return Buffer.from(part.body.data, 'base64').toString('utf-8');
      }
    }
  }

  if (payload.body?.data) {
    return Buffer.from(payload.body.data, 'base64').toString('utf-8');
  }

  return '';
}

// ─── Email Processing Pipeline ────────────────────────────────
async function processEmail(providerId, email) {
  if (!email) return null;

  const rawText = `Subject: ${email.subject}\n\n${email.body}`;

  if (!isSchedulingRelated(rawText)) return null;

  const { scrubbedText, tokensUsed } = scrubText(rawText);

  const intent = await extractEmailIntent(scrubbedText, email.date);

  if (!intent || intent.type === 'irrelevant') return null;

  const cleanSignal = await ingestSignal(providerId, {
    source: SIGNAL_SOURCES.EMAIL_GMAIL,
    signalType: intent.type,
    text: scrubbedText,
    metadata: {
      messageId: email.messageId,
      intentType: intent.type,
      confidence: intent.confidence,
      tokensFound: tokensUsed.length,
    },
  });

  if (intent.slotStart && intent.confidence >= 0.70) {
    return await signalToSlotEvent(providerId, cleanSignal, {
      eventId: `email_${email.messageId}`,
      slotStart: intent.slotStart,
      slotEnd: intent.slotEnd,
      status: intent.type === 'cancellation' ? 'cancelled' : 'changed',
    });
  }

  log(ACTIONS.EMAIL_SCANNED, {
    actorType: 'agent',
    resourceId: providerId,
    details: {
      intentType: intent.type,
      confidence: intent.confidence,
      hasSlotTime: !!intent.slotStart,
      action: 'logged_no_slot_time',
    },
  });

  return null;
}

// ─── Relevance Filter ─────────────────────────────────────────
const SCHEDULING_KEYWORDS = [
  'appointment', 'cancel', 'reschedule', "can't make",
  'unable to', "won't be", 'no longer', 'need to change',
  'visit', 'schedule', 'booking', 'session',
];

function isSchedulingRelated(text) {
  const lower = text.toLowerCase();
  return SCHEDULING_KEYWORDS.some((kw) => lower.includes(kw));
}

// ─── AI Intent Extraction ─────────────────────────────────────
async function extractEmailIntent(scrubbedText, emailDate) {
  if (!process.env.ANTHROPIC_API_KEY) {
    return ruleBasedEmailIntent(scrubbedText);
  }

  const prompt = `You are a medical scheduling assistant analyzing an email.
All patient identifiers have been replaced with tokens like [NAME_ABC123].

Email text:
---
${scrubbedText.slice(0, 800)}
---

Email received: ${emailDate || 'unknown'}

Extract scheduling intent. Respond ONLY with JSON, no other text:
{
  "type": "cancellation|reschedule|confirmation|inquiry|irrelevant",
  "confidence": 0.0-1.0,
  "slotStart": "ISO datetime if mentioned, or null",
  "slotEnd": "ISO datetime if mentioned, or null",
  "reasoning": "under 15 words"
}

Rules:
- slotStart/slotEnd: only include if a specific date/time is clearly referenced
- confidence: how certain you are about the intent type
- irrelevant: use for emails clearly unrelated to scheduling`;

  try {
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': process.env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 200,
        messages: [{ role: 'user', content: prompt }],
      }),
    });

    if (!response.ok) throw new Error(`API error: ${response.status}`);

    const data = await response.json();
    const text = data.content?.[0]?.text || '{}';
    const clean = text.replace(/```json|```/g, '').trim();
    return JSON.parse(clean);
  } catch (err) {
    logError({
      action: 'EMAIL_INTENT_ERROR',
      error: err,
      context: { scrubbedText: scrubbedText.slice(0, 100) },
    });
    return ruleBasedEmailIntent(scrubbedText);
  }
}

function ruleBasedEmailIntent(text) {
  const lower = text.toLowerCase();

  if (/cancel|won't be|unable to|can't make|no longer/i.test(lower)) {
    return { type: 'cancellation', confidence: 0.78, slotStart: null, slotEnd: null };
  }
  if (/reschedul|move.*appointment|change.*time/i.test(lower)) {
    return { type: 'reschedule', confidence: 0.75, slotStart: null, slotEnd: null };
  }
  if (/confirm|see you|appointment is/i.test(lower)) {
    return { type: 'confirmation', confidence: 0.70, slotStart: null, slotEnd: null };
  }
  return { type: 'irrelevant', confidence: 0.60, slotStart: null, slotEnd: null };
}

// ─── Forwarding Address Mode ──────────────────────────────────
async function processForwardedEmail(forwardedEmail) {
  const providerId = forwardedEmail.to?.split('@')[0];
  if (!providerId) throw new Error('Cannot extract provider ID from forwarded email');

  return await processEmail(providerId, {
    messageId: forwardedEmail.messageId || `fwd_${Date.now()}`,
    subject: forwardedEmail.subject,
    body: forwardedEmail.body,
    date: forwardedEmail.date,
  });
}

// ─── Exports ─────────────────────────────────────────────────
export {
  setupGmailWatch,
  processNewEmails,
  processEmail,
  processForwardedEmail,
  extractEmailIntent,
  isSchedulingRelated,
};

export default {
  setupGmailWatch,
  processNewEmails,
  processEmail,
  processForwardedEmail,
  extractEmailIntent,
  isSchedulingRelated,
};
