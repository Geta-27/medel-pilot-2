/**
 * CareX — Provider Veto Engine
 * Engine 1, Module 3
 *
 * When a slot opens, the provider gets notified first.
 * They have a configurable window (default 90s) to veto.
 * No response = auto-confirm assignment.
 * Provider can veto, override, or manually reassign at any time.
 *
 * This is the "human in the loop" layer that makes CareX
 * legally and professionally acceptable to providers.
 */

import {
  logSlotAssigned,
  logProviderVeto,
  logError,
  ACTIONS,
  log,
} from '../hipaa/auditLogger.js';
import { slotEvents } from './slotDetector.js';
import { classifySlotEvent, SLOT_EVENT_TYPES } from './slotClassifier.js';

// ─── Config ──────────────────────────────────────────────────
const DEFAULT_VETO_WINDOW_MS = 90 * 1000; // 90 seconds
const MAX_VETO_WINDOW_MS = 5 * 60 * 1000; // 5 minutes max

// ─── State ───────────────────────────────────────────────────
const pendingVetos = new Map(); // slotId → VetoRecord
const providerPreferences = new Map(); // providerId → ProviderPrefs

// ─── Provider Preferences ────────────────────────────────────
const DEFAULT_PREFS = {
  vetoWindowMs: DEFAULT_VETO_WINDOW_MS,
  autoActOnCancellation: true,
  autoActOnNoShow: false,
  autoActOnReschedule: true,
  maxMarketplaceSlots: 3,
  notifyViaPush: true,
  notifyViaSMS: true,
  minimumLeadTimeMin: 30,
};

function setProviderPreferences(providerId, prefs) {
  const current = providerPreferences.get(providerId) || DEFAULT_PREFS;
  const updated = {
    ...current,
    ...prefs,
    vetoWindowMs: Math.min(
      prefs.vetoWindowMs || current.vetoWindowMs,
      MAX_VETO_WINDOW_MS
    ),
  };
  providerPreferences.set(providerId, updated);

  log(ACTIONS.PROVIDER_RULE_SET, {
    actorId: providerId,
    actorType: 'provider',
    details: { prefsUpdated: Object.keys(prefs) },
  });

  return updated;
}

function getProviderPreferences(providerId) {
  return providerPreferences.get(providerId) || { ...DEFAULT_PREFS };
}

// ─── Core Veto Pipeline ──────────────────────────────────────
async function processSlotWithVeto(classifiedEvent) {
  const { providerId, classification } = classifiedEvent;
  const prefs = getProviderPreferences(providerId);

  const shouldAutoAct =
    canAutoAct(classification.type, prefs) &&
    classification.autoAct &&
    isWithinLeadTime(classifiedEvent.slotStart, prefs.minimumLeadTimeMin);

  if (!shouldAutoAct) {
    return await requestProviderDecision(classifiedEvent, prefs, 'manual_review_required');
  }

  return await startVetoWindow(classifiedEvent, prefs);
}

function canAutoAct(eventType, prefs) {
  switch (eventType) {
    case SLOT_EVENT_TYPES.CANCELLATION: return prefs.autoActOnCancellation;
    case SLOT_EVENT_TYPES.NO_SHOW: return prefs.autoActOnNoShow;
    case SLOT_EVENT_TYPES.RESCHEDULE: return prefs.autoActOnReschedule;
    case SLOT_EVENT_TYPES.NEW_OPENING: return true;
    default: return false;
  }
}

function isWithinLeadTime(slotStart, minimumLeadTimeMin) {
  const minutesUntilSlot = (new Date(slotStart) - new Date()) / (1000 * 60);
  return minutesUntilSlot >= minimumLeadTimeMin;
}

// ─── Veto Window ─────────────────────────────────────────────
async function startVetoWindow(classifiedEvent, prefs) {
  const { eventId, providerId, slotStart } = classifiedEvent;
  const vetoWindowMs = prefs.vetoWindowMs || DEFAULT_VETO_WINDOW_MS;

  const matchedPatient = await findBestMatch(classifiedEvent);

  if (!matchedPatient) {
    slotEvents.emit('slot:available', {
      ...classifiedEvent,
      matchedPatient: null,
      status: 'marketplace_pool',
    });
    return { action: 'added_to_pool', eventId };
  }

  const vetoRecord = {
    eventId,
    providerId,
    slotStart,
    matchedPatient,
    classifiedEvent,
    vetoWindowMs,
    startedAt: Date.now(),
    status: 'pending',
  };

  pendingVetos.set(eventId, vetoRecord);

  await sendProviderNotification(providerId, {
    type: 'VETO_WINDOW_OPEN',
    eventId,
    slotStart,
    patient: matchedPatient,
    vetoWindowMs,
    message: formatVetoMessage(classifiedEvent, matchedPatient, vetoWindowMs),
  });

  const timer = setTimeout(async () => {
    await onVetoWindowExpired(eventId);
  }, vetoWindowMs);

  vetoRecord.timer = timer;

  log(ACTIONS.AGENT_MATCH_FOUND, {
    actorType: 'agent',
    resourceId: eventId,
    details: {
      providerId,
      patientToken: matchedPatient.patientToken,
      vetoWindowMs,
      confidence: classifiedEvent.classification.confidence,
    },
  });

  return {
    action: 'veto_window_started',
    eventId,
    vetoWindowMs,
    expiresAt: new Date(Date.now() + vetoWindowMs).toISOString(),
    matchedPatient: { patientToken: matchedPatient.patientToken },
  };
}

// ─── Veto Window Expiry (Auto-Confirm) ───────────────────────
async function onVetoWindowExpired(eventId) {
  const record = pendingVetos.get(eventId);
  if (!record || record.status !== 'pending') return;

  record.status = 'confirmed';
  pendingVetos.set(eventId, record);

  logSlotAssigned({
    slotId: eventId,
    patientToken: record.matchedPatient.patientToken,
    providerId: record.providerId,
    autoAssigned: true,
    vetoWindowMs: record.vetoWindowMs,
  });

  slotEvents.emit('slot:confirmed', {
    ...record.classifiedEvent,
    matchedPatient: record.matchedPatient,
    autoAssigned: true,
    confirmedAt: new Date().toISOString(),
  });

  await sendProviderNotification(record.providerId, {
    type: 'AUTO_CONFIRMED',
    eventId,
    message: `Slot auto-filled. Patient notified. Tap to view or reassign.`,
  });

  slotEvents.emit('patient:notified', {
    patientToken: record.matchedPatient.patientToken,
    slotStart: record.classifiedEvent.slotStart,
    providerId: record.providerId,
    notificationType: 'booking_confirmed',
  });

  pendingVetos.delete(eventId);
}

// ─── Provider Actions ────────────────────────────────────────
async function providerVeto(eventId, providerId, reason = '') {
  const record = pendingVetos.get(eventId);

  if (!record) {
    return { success: false, message: 'Veto window has already expired' };
  }

  if (record.providerId !== providerId) {
    return { success: false, message: 'Not authorized for this event' };
  }

  if (record.timer) clearTimeout(record.timer);

  record.status = 'vetoed';
  pendingVetos.delete(eventId);

  logProviderVeto({ providerId, slotId: eventId, reason });

  slotEvents.emit('slot:vetoed', {
    ...record.classifiedEvent,
    vetoReason: reason,
    vetoedAt: new Date().toISOString(),
  });

  return {
    success: true,
    message: 'Assignment cancelled. Slot returned to pool.',
    eventId,
  };
}

async function providerManualAssign(eventId, providerId, patientToken) {
  const record = pendingVetos.get(eventId);

  if (record?.timer) clearTimeout(record.timer);
  if (record) pendingVetos.delete(eventId);

  logSlotAssigned({
    slotId: eventId,
    patientToken,
    providerId,
    autoAssigned: false,
    vetoWindowMs: 0,
  });

  log(ACTIONS.PROVIDER_OVERRIDE, {
    actorId: providerId,
    actorType: 'provider',
    resourceId: eventId,
    details: { patientToken, overrideType: 'manual_assign' },
  });

  slotEvents.emit('slot:confirmed', {
    eventId,
    providerId,
    matchedPatient: { patientToken },
    autoAssigned: false,
    confirmedAt: new Date().toISOString(),
  });

  return { success: true, message: 'Manual assignment confirmed', eventId };
}

// ─── Manual Review (Low Confidence) ─────────────────────────
async function requestProviderDecision(classifiedEvent, prefs, reason) {
  const { eventId, providerId, slotStart, classification } = classifiedEvent;

  await sendProviderNotification(providerId, {
    type: 'MANUAL_REVIEW',
    eventId,
    slotStart,
    message: `Scheduling change detected (${classification.type}, ${Math.round(classification.confidence * 100)}% confidence). Tap to review.`,
    actions: ['confirm_cancellation', 'ignore', 'view_details'],
  });

  log(ACTIONS.AGENT_SLOT_DETECTED, {
    actorType: 'agent',
    resourceId: eventId,
    details: {
      reason,
      confidence: classification.confidence,
      requiresManualReview: true,
    },
  });

  return { action: 'manual_review_requested', eventId };
}

// ─── Patient Matching (Stub) ──────────────────────────────────
async function findBestMatch(classifiedEvent) {
  const mockWaitlistPatient = {
    patientToken: 'PATIENT_MOCK_001',
    waitlistSince: new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString(),
    urgencyScore: 0.75,
    matchScore: 0.90,
  };

  return mockWaitlistPatient;
}

// ─── Notifications (Stub) ────────────────────────────────────
async function sendProviderNotification(providerId, notification) {
  console.log(`[NOTIFY → Provider ${providerId}]`, notification.message || notification.type);
  slotEvents.emit('provider:notification', { providerId, notification });
}

function formatVetoMessage(classifiedEvent, matchedPatient, vetoWindowMs) {
  const seconds = Math.round(vetoWindowMs / 1000);
  const slotTime = new Date(classifiedEvent.slotStart).toLocaleTimeString([], {
    hour: '2-digit', minute: '2-digit',
  });
  const type = classifiedEvent.classification.type.replace('_', '-');

  return `${type.charAt(0).toUpperCase() + type.slice(1)} detected at ${slotTime}. Auto-filling in ${seconds}s. Tap to veto.`;
}

// ─── Status Queries ──────────────────────────────────────────
function getPendingVetos(providerId) {
  return [...pendingVetos.values()]
    .filter((r) => r.providerId === providerId && r.status === 'pending')
    .map((r) => ({
      eventId: r.eventId,
      slotStart: r.slotStart,
      timeLeft: Math.max(0, r.vetoWindowMs - (Date.now() - r.startedAt)),
      matchScore: r.matchedPatient?.matchScore,
    }));
}

// ─── Wire Up to Slot Detector ────────────────────────────────
slotEvents.on('slot:changed', async (slotEvent) => {
  try {
    const classified = await classifySlotEvent(slotEvent);

    if (classified.classification.type === SLOT_EVENT_TYPES.UNKNOWN) {
      return;
    }

    await processSlotWithVeto(classified);
  } catch (err) {
    logError({
      action: 'VETO_PIPELINE_ERROR',
      error: err,
      context: { eventId: slotEvent.eventId },
    });
  }
});

// ─── Exports ─────────────────────────────────────────────────
export {
  processSlotWithVeto,
  providerVeto,
  providerManualAssign,
  setProviderPreferences,
  getProviderPreferences,
  getPendingVetos,
};

export default {
  processSlotWithVeto,
  providerVeto,
  providerManualAssign,
  setProviderPreferences,
  getProviderPreferences,
  getPendingVetos,
};
