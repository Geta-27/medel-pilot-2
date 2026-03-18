/**
 * CareX — PHI Scrubbing Layer
 *
 * De-identifies Protected Health Information (PHI) before
 * any data reaches the AI agent.
 */

import crypto from 'node:crypto';

// ─── Token Vault ─────────────────────────────────────────────
const tokenVault = new Map();
const reverseVault = new Map();

// ─── PHI Field Patterns ──────────────────────────────────────
const PHI_PATTERNS = {
  name: /\b(Dr\.?\s+)?[A-Z][a-z]+\s+[A-Z][a-z]+\b/g,
  date: /\b(\d{1,2}[\/\-]\d{1,2}[\/\-]\d{2,4}|\d{4}-\d{2}-\d{2}|(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*\.?\s+\d{1,2}(st|nd|rd|th)?(\s*,?\s*\d{4})?|(Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday)(\s+at\s+\d{1,2}(:\d{2})?\s*(am|pm)?)?)\b/gi,
  time: /\b\d{1,2}(:\d{2})?\s*(am|pm)\b/gi,
  phone: /(\+?1?\s?)?(\(?\d{3}\)?[\s.\-]?\d{3}[\s.\-]?\d{4})/g,
  email: /[a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,}/g,
  ssn: /\b\d{3}[- ]?\d{2}[- ]?\d{4}\b/g,
  mrn: /\b(MRN|Patient ID|Chart #?)[:\s]*[A-Z0-9\-]+\b/gi,
  zip: /\b\d{5}(-\d{4})?\b/g,
  age: /\b(age[d]?\s+)?(9[0-9]|1[0-9]{2})\s*(year[s]?\s*old|yo|y\.o\.?)?\b/gi,
};

// ─── Core Functions ──────────────────────────────────────────
export function generateToken(fieldType, realValue) {
  const hash = crypto
    .createHash('sha256')
    .update(`${fieldType}:${realValue}`)
    .digest('hex')
    .slice(0, 12)
    .toUpperCase();

  const token = `[${fieldType.toUpperCase()}_${hash}]`;

  if (!reverseVault.has(hash)) {
    tokenVault.set(token, {
      realValue,
      fieldType,
      createdAt: new Date().toISOString(),
    });
    reverseVault.set(hash, token);
  }

  return reverseVault.get(hash) || token;
}

export function scrubText(rawText, options = {}) {
  if (!rawText || typeof rawText !== 'string') {
    return { scrubbedText: '', tokensUsed: [], fieldCount: 0, wasModified: false };
  }

  let text = rawText;
  const tokensUsed = [];
  let fieldCount = 0;

  for (const [fieldType, pattern] of Object.entries(PHI_PATTERNS)) {
    pattern.lastIndex = 0;

    text = text.replace(pattern, (match) => {
      const cleaned = match.trim();
      const token = generateToken(fieldType, cleaned);
      tokensUsed.push({ token, fieldType, original: cleaned });
      fieldCount += 1;
      return token;
    });
  }

  return {
    scrubbedText: text,
    tokensUsed,
    fieldCount,
    wasModified: fieldCount > 0,
  };
}

export function scrubAppointment(appointment = {}) {
  const PHI_FIELDS = [
    'patientName', 'patientEmail', 'patientPhone',
    'notes', 'reason', 'chiefComplaint',
    'patientDOB', 'address', 'insuranceMemberId',
  ];

  const scrubbed = { ...appointment };
  const auditTrail = [];

  for (const field of PHI_FIELDS) {
    if (typeof scrubbed[field] === 'string' && scrubbed[field]) {
      const result = scrubText(scrubbed[field]);
      if (result.wasModified) {
        auditTrail.push({
          field,
          tokensCreated: result.tokensUsed.length,
        });
        scrubbed[field] = result.scrubbedText;
      }
    }
  }

  if (scrubbed.patientId) {
    scrubbed.patientToken = generateToken('patient_id', String(scrubbed.patientId));
    delete scrubbed.patientId;
  } else if (appointment.patientName) {
    scrubbed.patientToken = generateToken('patient_id', appointment.patientName);
  } else {
    scrubbed.patientToken = generateToken('patient_id', `anon_${Date.now()}`);
  }

  return {
    scrubbedAppointment: scrubbed,
    auditTrail,
    phiRemoved: auditTrail.length > 0,
  };
}

export function reIdentify(token, requestedBy, reason) {
  if (!tokenVault.has(token)) {
    return { success: false, error: 'Token not found in vault' };
  }

  const entry = tokenVault.get(token);

  const auditEntry = {
    action: 'RE_IDENTIFY',
    token,
    fieldType: entry.fieldType,
    requestedBy,
    reason,
    timestamp: new Date().toISOString(),
  };

  console.log('[PHI_AUDIT]', JSON.stringify(auditEntry));

  return {
    success: true,
    realValue: entry.realValue,
    fieldType: entry.fieldType,
    auditEntry,
  };
}

export function scrubSchedule(appointments = []) {
  return appointments.map((appt) => {
    const { scrubbedAppointment } = scrubAppointment(appt);
    return scrubbedAppointment;
  });
}

export function clearVault() {
  const count = tokenVault.size;
  tokenVault.clear();
  reverseVault.clear();
  return { cleared: count };
}

export function getVaultStats() {
  return {
    tokenCount: tokenVault.size,
    fieldTypes: [...tokenVault.values()].reduce((acc, v) => {
      acc[v.fieldType] = (acc[v.fieldType] || 0) + 1;
      return acc;
    }, {}),
  };
}

export default {
  scrubText,
  scrubAppointment,
  scrubSchedule,
  reIdentify,
  clearVault,
  getVaultStats,
  generateToken,
};
