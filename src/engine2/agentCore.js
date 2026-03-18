/**
 * CareX — AI Schedule Agent Core
 * Engine 2, Module 1
 *
 * The agent that replaces EMR integration entirely.
 * Monitors provider signals the same way a smart receptionist would:
 *   - Calendar changes (OAuth)
 *   - Email cancellations (Gmail/IMAP)
 *   - SMS/text cancellations (Twilio)
 *   - Native CareX portal (direct DB)
 *
 * Architecture:
 *   Signal Sources → Agent Core → Signal Normalizer → Slot Detector (Engine 1)
 *
 * HIPAA: Agent operates entirely on anonymized tokens.
 *        PHI is scrubbed at the edge before agent sees anything.
 */

import { scrubText, scrubAppointment } from '../hipaa/phiScrubber.js';
import { log, logError, ACTIONS } from '../hipaa/auditLogger.js';
import { processChangedEvents } from '../engine1/slotDetector.js';

// ─── Agent State ─────────────────────────────────────────────
const agentRegistry = new Map(); // providerId → AgentConfig

const SIGNAL_SOURCES = {
  CALENDAR_GOOGLE: 'calendar_google',
  CALENDAR_MICROSOFT: 'calendar_microsoft',
  EMAIL_GMAIL: 'email_gmail',
  EMAIL_IMAP: 'email_imap',
  SMS_TWILIO: 'sms_twilio',
  NATIVE_PORTAL: 'native_portal',
};

// ─── Agent Registration ───────────────────────────────────────
function registerProvider(providerId, config = {}) {
  const agentConfig = {
    providerId,
    enabledSources: config.enabledSources || [SIGNAL_SOURCES.CALENDAR_GOOGLE],
    watchMode: config.watchMode || 'active', // 'active' | 'suggest' | 'watch_only'
    createdAt: new Date().toISOString(),
    lastSignalAt: null,
    signalCount: 0,
    status: 'running',
  };

  agentRegistry.set(providerId, agentConfig);

  log(ACTIONS.PROVIDER_CONNECTED, {
    actorId: providerId,
    actorType: 'provider',
    details: {
      agentRegistered: true,
      enabledSources: agentConfig.enabledSources,
      watchMode: agentConfig.watchMode,
    },
  });

  return agentConfig;
}

function getAgentStatus(providerId) {
  if (!agentRegistry.has(providerId)) {
    return { registered: false };
  }

  const config = agentRegistry.get(providerId);
  return {
    registered: true,
    status: config.status,
    watchMode: config.watchMode,
    enabledSources: config.enabledSources,
    lastSignalAt: config.lastSignalAt,
    signalCount: config.signalCount,
  };
}

// ─── Signal Ingestion ─────────────────────────────────────────
async function ingestSignal(providerId, rawSignal) {
  const config = agentRegistry.get(providerId);

  if (!config) {
    throw new Error(`Provider ${providerId} not registered with agent`);
  }

  try {
    const { scrubbedText, tokensUsed, fieldCount } = scrubText(rawSignal.text || '');

    const cleanSignal = {
      providerId,
      source: rawSignal.source,
      signalType: rawSignal.signalType || 'unknown',
      scrubbedText,
      tokensCreated: fieldCount,
      receivedAt: new Date().toISOString(),
      metadata: rawSignal.metadata || {}, // Non-PHI metadata only
    };

    config.lastSignalAt = cleanSignal.receivedAt;
    config.signalCount++;
    agentRegistry.set(providerId, config);

    log(ACTIONS.CALENDAR_READ, {
      actorType: 'agent',
      resourceId: providerId,
      details: {
        source: cleanSignal.source,
        tokensCreated: fieldCount,
        signalType: cleanSignal.signalType,
        tokenCount: tokensUsed.length,
      },
    });

    return cleanSignal;
  } catch (error) {
    logError({
      action: 'AGENT_INGEST_SIGNAL_ERROR',
      error,
      context: { providerId, source: rawSignal?.source },
    });
    throw error;
  }
}

// ─── Signal → Slot Event Converter ───────────────────────────
async function signalToSlotEvent(providerId, cleanSignal, appointmentData = {}) {
  const { scrubbedAppointment } = scrubAppointment({
    ...appointmentData,
    notes: cleanSignal.scrubbedText,
  });

  const slotEvent = {
    eventId: appointmentData.eventId || `agent_${Date.now()}`,
    title: scrubbedAppointment.patientName || '',
    start: appointmentData.slotStart,
    end: appointmentData.slotEnd,
    status: appointmentData.status || 'cancelled',
    attendees: [],
    notes: cleanSignal.scrubbedText,
    source: cleanSignal.source,
    agentDetected: true,
  };

  await processChangedEvents(providerId, [slotEvent], cleanSignal.source);
  return slotEvent;
}

// ─── Auto-Online Status Engine ────────────────────────────────
function computeOnlineStatus(providerId, scheduleState) {
  const {
    openSlots = [],
    workingHours = { start: 8, end: 18 },
    manualOverride = null,
    currentTime = new Date(),
    marketplaceRules = {},
  } = scheduleState;

  if (manualOverride === 'unavailable') {
    return {
      online: false,
      reason: 'manual_override',
      message: 'Provider set to unavailable',
    };
  }

  const hour = currentTime.getHours();
  if (hour < workingHours.start || hour >= workingHours.end) {
    return {
      online: false,
      reason: 'outside_hours',
      message: `Outside working hours (${workingHours.start}:00–${workingHours.end}:00)`,
    };
  }

  const availableSlots = openSlots.filter((slot) => {
    const slotTime = new Date(slot.start);
    const minsUntil = (slotTime - currentTime) / (1000 * 60);
    return minsUntil >= 30 && minsUntil <= 480;
  });

  if (availableSlots.length === 0) {
    return {
      online: false,
      reason: 'no_slots',
      message: 'No available slots today',
    };
  }

  const dailyMarketplaceUsed = marketplaceRules.slotsUsedToday || 0;
  const dailyMarketplaceMax = marketplaceRules.maxSlotsPerDay || 3;

  if (dailyMarketplaceUsed >= dailyMarketplaceMax) {
    return {
      online: false,
      reason: 'marketplace_limit',
      message: `Daily marketplace limit reached (${dailyMarketplaceMax} slots)`,
    };
  }

  return {
    online: true,
    reason: 'slots_available',
    availableCount: availableSlots.length,
    nextSlot: availableSlots[0]?.start,
    message: `${availableSlots.length} slot(s) available`,
  };
}

// ─── Exports ─────────────────────────────────────────────────
export {
  registerProvider,
  getAgentStatus,
  ingestSignal,
  signalToSlotEvent,
  computeOnlineStatus,
  SIGNAL_SOURCES,
};

export default {
  registerProvider,
  getAgentStatus,
  ingestSignal,
  signalToSlotEvent,
  computeOnlineStatus,
  SIGNAL_SOURCES,
};
