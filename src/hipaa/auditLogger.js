/**
 * CareX — HIPAA Audit Logger
 *
 * Append-only log of PHI-related and agent/provider actions.
 */

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

// ─── Config ──────────────────────────────────────────────────
const LOG_DIR = process.env.AUDIT_LOG_DIR || './logs/audit';

function dateStamp() {
  return new Date().toISOString().slice(0, 10);
}

const LOG_FILE = path.join(LOG_DIR, `audit-${dateStamp()}.jsonl`);

// Action type constants
export const ACTIONS = {
  // PHI access
  PHI_SCRUBBED: 'PHI_SCRUBBED',
  PHI_RE_IDENTIFIED: 'PHI_RE_IDENTIFIED',
  PHI_VAULT_CLEARED: 'PHI_VAULT_CLEARED',

  // Agent actions
  AGENT_SLOT_DETECTED: 'AGENT_SLOT_DETECTED',
  AGENT_SLOT_RELEASED: 'AGENT_SLOT_RELEASED',
  AGENT_MATCH_FOUND: 'AGENT_MATCH_FOUND',
  AGENT_ASSIGN_AUTO: 'AGENT_ASSIGN_AUTO',
  AGENT_ASSIGN_VETOED: 'AGENT_ASSIGN_VETOED',
  AGENT_ASSIGN_MANUAL: 'AGENT_ASSIGN_MANUAL',

  // Provider actions
  PROVIDER_CONNECTED: 'PROVIDER_CONNECTED',
  PROVIDER_DISCONNECTED: 'PROVIDER_DISCONNECTED',
  PROVIDER_VETO: 'PROVIDER_VETO',
  PROVIDER_OVERRIDE: 'PROVIDER_OVERRIDE',
  PROVIDER_RULE_SET: 'PROVIDER_RULE_SET',

  // Patient actions
  PATIENT_BOOKED: 'PATIENT_BOOKED',
  PATIENT_CANCELLED: 'PATIENT_CANCELLED',
  PATIENT_WAITLISTED: 'PATIENT_WAITLISTED',

  // Calendar access
  CALENDAR_READ: 'CALENDAR_READ',
  CALENDAR_WEBHOOK: 'CALENDAR_WEBHOOK',
  EMAIL_SCANNED: 'EMAIL_SCANNED',

  // System
  SYSTEM_ERROR: 'SYSTEM_ERROR',
  SYSTEM_START: 'SYSTEM_START',
};

// ─── Helpers ─────────────────────────────────────────────────
function ensureLogDir() {
  if (!fs.existsSync(LOG_DIR)) {
    fs.mkdirSync(LOG_DIR, { recursive: true });
  }
}

function hashEntry(entry) {
  return crypto
    .createHash('sha256')
    .update(JSON.stringify(entry))
    .digest('hex')
    .slice(0, 16);
}

// ─── Core Logger ─────────────────────────────────────────────
let entryCount = 0;

export function log(action, context = {}) {
  ensureLogDir();

  const entry = {
    entryId: `${Date.now()}-${++entryCount}`,
    timestamp: new Date().toISOString(),
    action,

    actorId: context.actorId || 'system',
    actorType: context.actorType || 'system',

    resourceId: context.resourceId || null,
    resourceType: context.resourceType || null,

    details: context.details || {},
    outcome: context.outcome || 'success',
    reason: context.reason || null,

    env: process.env.NODE_ENV || 'development',
  };

  entry.hash = hashEntry(entry);

  try {
    fs.appendFileSync(LOG_FILE, JSON.stringify(entry) + '\n', 'utf8');
  } catch (err) {
    console.error('[AUDIT_CRITICAL] Failed to write audit log:', err.message);
  }

  return entry;
}

// ─── Convenience Wrappers ────────────────────────────────────
export function logSlotDetected({ providerId, slotId, slotTime, signalSource, confidence }) {
  return log(ACTIONS.AGENT_SLOT_DETECTED, {
    actorType: 'agent',
    resourceId: slotId,
    resourceType: 'slot',
    details: { providerId, slotTime, signalSource, confidence },
  });
}

export function logSlotAssigned({ slotId, patientToken, providerId, autoAssigned, vetoWindowMs }) {
  return log(autoAssigned ? ACTIONS.AGENT_ASSIGN_AUTO : ACTIONS.AGENT_ASSIGN_MANUAL, {
    actorType: 'agent',
    resourceId: slotId,
    resourceType: 'slot',
    details: { patientToken, providerId, autoAssigned, vetoWindowMs },
  });
}

export function logProviderVeto({ providerId, slotId, reason }) {
  return log(ACTIONS.AGENT_ASSIGN_VETOED, {
    actorId: providerId,
    actorType: 'provider',
    resourceId: slotId,
    resourceType: 'slot',
    reason,
  });
}

export function logPHIScrubbed({ fieldCount, fieldTypes, requestSource }) {
  return log(ACTIONS.PHI_SCRUBBED, {
    actorType: 'system',
    details: { fieldCount, fieldTypes, requestSource },
  });
}

export function logReIdentification({ token, fieldType, requestedBy, reason, success }) {
  return log(ACTIONS.PHI_RE_IDENTIFIED, {
    actorId: requestedBy || 'system',
    actorType: 'system',
    details: { token, fieldType, reason },
    outcome: success ? 'success' : 'failure',
    reason,
  });
}

export function logCalendarAccess({ providerId, calendarType, slotCount, webhookEvent }) {
  return log(ACTIONS.CALENDAR_READ, {
    actorType: 'agent',
    resourceId: providerId,
    resourceType: 'calendar',
    details: { calendarType, slotCount, webhookEvent },
  });
}

export function logProviderConnected({ providerId, calendarType, oauthScopes }) {
  return log(ACTIONS.PROVIDER_CONNECTED, {
    actorId: providerId,
    actorType: 'provider',
    resourceType: 'calendar',
    details: { calendarType, oauthScopes },
  });
}

export function logError({ action, error, context }) {
  return log(ACTIONS.SYSTEM_ERROR, {
    actorType: 'system',
    outcome: 'failure',
    details: { action, error: error?.message || String(error), ...context },
  });
}

// ─── Audit Query ─────────────────────────────────────────────
function summarizeAction(entry) {
  const summaries = {
    [ACTIONS.AGENT_SLOT_DETECTED]: `Slot change detected from ${entry.details?.signalSource || 'calendar'}`,
    [ACTIONS.AGENT_ASSIGN_AUTO]: 'Slot auto-assigned to patient (veto window passed)',
    [ACTIONS.AGENT_ASSIGN_VETOED]: 'Auto-assignment vetoed by provider',
    [ACTIONS.AGENT_ASSIGN_MANUAL]: 'Slot manually assigned by provider',
    [ACTIONS.PROVIDER_CONNECTED]: `Calendar connected (${entry.details?.calendarType || 'unknown'})`,
    [ACTIONS.CALENDAR_READ]: `Schedule checked — ${entry.details?.slotCount || 0} slots read`,
    [ACTIONS.PHI_SCRUBBED]: 'Patient data de-identified before processing',
    [ACTIONS.PHI_RE_IDENTIFIED]: 'Patient identity revealed for confirmed booking',
    [ACTIONS.PATIENT_BOOKED]: 'Patient booking confirmed',
  };
  return summaries[entry.action] || entry.action;
}

export function queryProviderAudit(providerId, options = {}) {
  const { limit = 100, since = null } = options;

  try {
    if (!fs.existsSync(LOG_FILE)) return [];

    const lines = fs.readFileSync(LOG_FILE, 'utf8')
      .split('\n')
      .filter(Boolean);

    return lines
      .map((line) => {
        try { return JSON.parse(line); } catch { return null; }
      })
      .filter((entry) =>
        entry &&
        (entry.actorId === providerId || entry.details?.providerId === providerId) &&
        (!since || new Date(entry.timestamp) > new Date(since))
      )
      .slice(-limit)
      .map((entry) => ({
        entryId: entry.entryId,
        timestamp: entry.timestamp,
        action: entry.action,
        outcome: entry.outcome,
        summary: summarizeAction(entry),
      }));
  } catch (err) {
    console.error('[AUDIT] Query failed:', err.message);
    return [];
  }
}

export default {
  log,
  ACTIONS,
  logSlotDetected,
  logSlotAssigned,
  logProviderVeto,
  logPHIScrubbed,
  logReIdentification,
  logCalendarAccess,
  logProviderConnected,
  logError,
  queryProviderAudit,
};
