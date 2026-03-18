/**
 * CareX — Slot Event Classifier
 * Engine 1, Module 2
 *
 * Takes a raw SlotEvent and determines:
 *   1. What type of change happened (cancel, no-show, reschedule, new opening)
 *   2. Confidence score (0.0 - 1.0)
 *   3. Whether to auto-act or ask provider
 *
 * High confidence (>= 0.85) → auto-act with veto window
 * Low confidence  (<  0.85) → ask provider to confirm
 *
 * Uses Claude API for ambiguous signals.
 * Uses fast rule-based logic for clear signals (saves API costs).
 */

import { logSlotDetected, logError } from '../hipaa/auditLogger.js';

// ─── Classification Types ────────────────────────────────────
const SLOT_EVENT_TYPES = {
  CANCELLATION: 'cancellation',
  NO_SHOW: 'no_show',
  RESCHEDULE: 'reschedule',
  NEW_OPENING: 'new_opening',
  BLOCK_REMOVED: 'block_removed',
  UNKNOWN: 'unknown',
};

const AUTO_ACT_THRESHOLD = 0.85;

// ─── Rule-Based Fast Classification ─────────────────────────
const CANCELLATION_SIGNALS = [
  /cancel/i, /cancelled/i, /canceling/i,
  /no.?show/i, /no longer/i, /won't be/i,
  /unable to/i, /need to reschedule/i,
  /can't make/i, /cannot make/i,
];

const RESCHEDULE_SIGNALS = [
  /reschedul/i, /move.*appointment/i, /change.*time/i,
  /different time/i, /another day/i, /need to reschedule/i,
  /want to reschedule/i, /can we reschedule/i,
];

const NEW_OPENING_SIGNALS = [
  /available/i, /opening/i, /open slot/i, /free slot/i,
];

/**
 * Fast rule-based classifier for clear-cut cases.
 * Returns null if signal is ambiguous (falls through to AI).
 */
function ruleBasedClassify(slotEvent) {
  const { status, scrubbedTitle = '', scrubbedNotes = '' } = slotEvent;
  const text = `${scrubbedTitle} ${scrubbedNotes}`.toLowerCase();

  if (status === 'cancelled') {
    const slotTime = new Date(slotEvent.slotStart);
    const now = new Date();

    if (slotTime < now) {
      const minutesPast = (now - slotTime) / (1000 * 60);
      if (minutesPast < 30) {
        return {
          type: SLOT_EVENT_TYPES.NO_SHOW,
          confidence: 0.82,
          reasoning: 'Slot cancelled within 30 min of start time — likely no-show',
          autoAct: false,
        };
      }
      return {
        type: SLOT_EVENT_TYPES.CANCELLATION,
        confidence: 0.92,
        reasoning: 'Past appointment marked cancelled',
        autoAct: true,
      };
    }

    return {
      type: SLOT_EVENT_TYPES.CANCELLATION,
      confidence: 0.95,
      reasoning: 'Future appointment explicitly cancelled in calendar',
      autoAct: true,
    };
  }

  if (RESCHEDULE_SIGNALS.some((re) => re.test(text))) {
    return {
      type: SLOT_EVENT_TYPES.RESCHEDULE,
      confidence: 0.87,
      reasoning: 'Reschedule language detected',
      autoAct: true,
    };
  }

  if (CANCELLATION_SIGNALS.some((re) => re.test(text))) {
    return {
      type: SLOT_EVENT_TYPES.CANCELLATION,
      confidence: 0.88,
      reasoning: 'Cancellation language detected in appointment notes',
      autoAct: true,
    };
  }

  if (NEW_OPENING_SIGNALS.some((re) => re.test(text))) {
    return {
      type: SLOT_EVENT_TYPES.NEW_OPENING,
      confidence: 0.80,
      reasoning: 'New availability signal detected',
      autoAct: false,
    };
  }

  return null;
}

// ─── AI-Powered Classifier ───────────────────────────────────
async function aiClassify(slotEvent) {
  if (!process.env.ANTHROPIC_API_KEY) {
    return {
      type: SLOT_EVENT_TYPES.UNKNOWN,
      confidence: 0.40,
      reasoning: 'ANTHROPIC_API_KEY not set — cannot classify',
      autoAct: false,
    };
  }

  const prompt = `You are a medical scheduling assistant. Classify this calendar event change.

Event details (all patient identifiers have been anonymized):
- Slot time: ${slotEvent.slotStart}
- Current status: ${slotEvent.status}
- Title (anonymized): ${slotEvent.scrubbedTitle || 'none'}
- Notes (anonymized): ${slotEvent.scrubbedNotes || 'none'}
- Signal source: ${slotEvent.source}
- Time until slot: ${getTimeUntilSlot(slotEvent.slotStart)}

Classify this event change as exactly one of:
- cancellation: patient cancelled appointment
- no_show: patient didn't arrive (slot time has passed)
- reschedule: appointment moved to different time
- new_opening: a new available slot appeared
- unknown: cannot determine from available information

Respond with ONLY a JSON object, no other text:
{
  "type": "cancellation|no_show|reschedule|new_opening|unknown",
  "confidence": 0.0-1.0,
  "reasoning": "brief explanation under 20 words"
}`;

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
        max_tokens: 150,
        messages: [{ role: 'user', content: prompt }],
      }),
    });

    if (!response.ok) {
      throw new Error(`Anthropic API error: ${response.status}`);
    }

    const data = await response.json();
    const text = data.content?.[0]?.text || '{}';
    const clean = text.replace(/```json|```/g, '').trim();
    const result = JSON.parse(clean);

    return {
      type: result.type || SLOT_EVENT_TYPES.UNKNOWN,
      confidence: result.confidence || 0.50,
      reasoning: result.reasoning || 'AI classification',
      autoAct: (result.confidence || 0) >= AUTO_ACT_THRESHOLD,
      source: 'ai',
    };
  } catch (err) {
    logError({ action: 'AI_CLASSIFY_ERROR', error: err, context: { slotEvent } });
    return {
      type: SLOT_EVENT_TYPES.UNKNOWN,
      confidence: 0.30,
      reasoning: 'Classification failed — needs provider review',
      autoAct: false,
    };
  }
}

// ─── Main Classifier ─────────────────────────────────────────
async function classifySlotEvent(slotEvent) {
  let classification = ruleBasedClassify(slotEvent);

  if (!classification) {
    classification = await aiClassify(slotEvent);
  }

  const classified = {
    ...slotEvent,
    classification: {
      type: classification.type,
      confidence: Math.round(classification.confidence * 100) / 100,
      reasoning: classification.reasoning,
      autoAct: classification.confidence >= AUTO_ACT_THRESHOLD,
      classifiedAt: new Date().toISOString(),
      method: classification.source || 'rules',
    },
  };

  logSlotDetected({
    providerId: slotEvent.providerId,
    slotId: slotEvent.eventId,
    slotTime: slotEvent.slotStart,
    signalSource: slotEvent.source,
    confidence: classified.classification.confidence,
  });

  return classified;
}

// ─── Helpers ─────────────────────────────────────────────────
function getTimeUntilSlot(slotStart) {
  if (!slotStart) return 'unknown';
  const ms = new Date(slotStart) - new Date();
  const hours = Math.round(ms / (1000 * 60 * 60));
  if (hours < 0) return `${Math.abs(hours)} hours ago`;
  if (hours === 0) return 'right now';
  if (hours < 24) return `${hours} hours from now`;
  return `${Math.round(hours / 24)} days from now`;
}

// ─── Exports ─────────────────────────────────────────────────
export {
  classifySlotEvent,
  SLOT_EVENT_TYPES,
  AUTO_ACT_THRESHOLD,
  ruleBasedClassify,
};

export default {
  classifySlotEvent,
  SLOT_EVENT_TYPES,
  AUTO_ACT_THRESHOLD,
  ruleBasedClassify,
};
