/**
 * CareX Phase 1 — Foundation Tests
 *
 * Run: node test/phase1.test.js
 */

import {
  scrubText,
  scrubAppointment,
  reIdentify,
  getVaultStats,
} from '../src/hipaa/phiScrubber.js';

import {
  log,
  ACTIONS,
  queryProviderAudit,
  logSlotDetected,
} from '../src/hipaa/auditLogger.js';

import {
  getAuthorizationUrl,
  getConnectionStatus,
} from '../src/hipaa/calendarOAuth.js';

// ─── Test Helpers ────────────────────────────────────────────
let passed = 0;
let failed = 0;

function test(name, fn) {
  try {
    fn();
    console.log(`  ✓ ${name}`);
    passed++;
  } catch (err) {
    console.log(`  ✗ ${name}`);
    console.log(`    Error: ${err.message}`);
    failed++;
  }
}

function assert(condition, message) {
  if (!condition) throw new Error(message || 'Assertion failed');
}

function assertContains(str, substring) {
  if (!str.includes(substring)) {
    throw new Error(`Expected "${str}" to contain "${substring}"`);
  }
}

function assertNotContains(str, substring) {
  if (str.includes(substring)) {
    throw new Error(`Expected "${str}" NOT to contain "${substring}"`);
  }
}

// ─── PHI Scrubber Tests ──────────────────────────────────────
console.log('\n📋 PHI Scrubber Tests');

test('scrubs patient name from text', () => {
  const result = scrubText('Patient John Smith called to cancel');
  assertNotContains(result.scrubbedText, 'John Smith');
  assert(result.wasModified);
});

test('scrubs date from text', () => {
  const result = scrubText('Appointment on March 15 at 2pm needs to cancel');
  assertNotContains(result.scrubbedText, 'March 15');
  assert(result.wasModified);
});

test('scrubs email from text', () => {
  const result = scrubText('Contact patient at john.smith@email.com');
  assertNotContains(result.scrubbedText, 'john.smith@email.com');
  assert(result.wasModified);
});

test('scrubs phone number from text', () => {
  const result = scrubText('Call back at (555) 123-4567');
  assertNotContains(result.scrubbedText, '555');
  assert(result.wasModified);
});

test('produces consistent tokens for same input', () => {
  const result1 = scrubText('John Smith cancelled');
  const result2 = scrubText('John Smith cancelled');
  assert(result1.scrubbedText === result2.scrubbedText, 'Same input should produce same token');
});

test('leaves non-PHI text mostly unchanged', () => {
  const result = scrubText('Appointment status: cancelled');
  assert(result.scrubbedText.includes('Appointment status'));
});

test('scrubs full appointment object', () => {
  const appointment = {
    id: 'appt_123',
    patientName: 'Sarah Connor',
    patientEmail: 'sarah@test.com',
    patientPhone: '555-999-8888',
    reason: 'Follow-up with Dr. Smith',
    status: 'cancelled',
    slotTime: '14:00',
  };

  const { scrubbedAppointment, phiRemoved } = scrubAppointment(appointment);

  assert(phiRemoved, 'PHI should be detected and removed');
  assert(scrubbedAppointment.id === 'appt_123', 'Non-PHI ID should be preserved');
  assertNotContains(scrubbedAppointment.patientName || '', 'Sarah Connor');
  assertNotContains(scrubbedAppointment.patientEmail || '', 'sarah@test.com');
  assert(scrubbedAppointment.patientToken, 'Patient token should be generated');
});

test('re-identification works for confirmed booking', () => {
  const result = scrubText('Patient Jane Doe confirmed');
  const token = result.tokensUsed.find((t) => t.fieldType === 'name');
  assert(token, 'Should have found a name token');

  const reId = reIdentify(token.token, 'system_booking', 'confirmed_appointment');
  assert(reId.success, 'Re-identification should succeed');
  assert(reId.realValue && reId.realValue.length > 0, 'Should return real value');
});

test('vault tracks token stats', () => {
  const stats = getVaultStats();
  assert(typeof stats.tokenCount === 'number', 'Should return token count');
  assert(typeof stats.fieldTypes === 'object', 'Should return field type breakdown');
});

// ─── Audit Logger Tests ──────────────────────────────────────
console.log('\n📋 Audit Logger Tests');

test('writes log entry with correct structure', () => {
  const entry = log(ACTIONS.AGENT_SLOT_DETECTED, {
    actorType: 'agent',
    resourceId: 'slot_456',
    resourceType: 'slot',
    details: { providerId: 'prov_001', signalSource: 'google_calendar' },
  });

  assert(entry.entryId, 'Entry should have ID');
  assert(entry.timestamp, 'Entry should have timestamp');
  assert(entry.hash, 'Entry should have tamper-evident hash');
  assert(entry.action === ACTIONS.AGENT_SLOT_DETECTED, 'Action should match');
});

test('logSlotDetected writes correct entry', () => {
  const entry = logSlotDetected({
    providerId: 'prov_001',
    slotId: 'slot_789',
    slotTime: '2026-03-15T14:00:00Z',
    signalSource: 'google_webhook',
    confidence: 0.95,
  });
  assert(entry.action === ACTIONS.AGENT_SLOT_DETECTED);
  assert(entry.details.confidence === 0.95);
});

test('each log entry has unique ID', () => {
  const e1 = log(ACTIONS.SYSTEM_START, {});
  const e2 = log(ACTIONS.SYSTEM_START, {});
  assert(e1.entryId !== e2.entryId, 'Entry IDs should be unique');
});

test('query returns provider-specific entries', () => {
  log(ACTIONS.CALENDAR_READ, {
    actorId: 'test_provider_query',
    actorType: 'provider',
    details: { calendarType: 'google', slotCount: 8 },
  });

  const entries = queryProviderAudit('test_provider_query');
  assert(Array.isArray(entries), 'Should return array');
});

// ─── OAuth Tests ─────────────────────────────────────────────
console.log('\n📋 OAuth Tests');

test('generates Google authorization URL', () => {
  const oldId = process.env.GOOGLE_CLIENT_ID;
  const oldSecret = process.env.GOOGLE_CLIENT_SECRET;
  const oldBase = process.env.OAUTH_REDIRECT_BASE_URL;

  process.env.GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID || 'test-google-client';
  process.env.GOOGLE_CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET || 'test-google-secret';
  process.env.OAUTH_REDIRECT_BASE_URL = process.env.OAUTH_REDIRECT_BASE_URL || 'http://localhost:3001';

  const { url, state } = getAuthorizationUrl('prov_test_001', 'google');
  assertContains(url, 'accounts.google.com');
  assertContains(url, 'calendar.readonly');
  assert(state.length === 32, 'State should be 32-char hex');

  process.env.GOOGLE_CLIENT_ID = oldId;
  process.env.GOOGLE_CLIENT_SECRET = oldSecret;
  process.env.OAUTH_REDIRECT_BASE_URL = oldBase;
});

test('generates Microsoft authorization URL', () => {
  const oldId = process.env.MICROSOFT_CLIENT_ID;
  const oldSecret = process.env.MICROSOFT_CLIENT_SECRET;
  const oldBase = process.env.OAUTH_REDIRECT_BASE_URL;

  process.env.MICROSOFT_CLIENT_ID = process.env.MICROSOFT_CLIENT_ID || 'test-ms-client';
  process.env.MICROSOFT_CLIENT_SECRET = process.env.MICROSOFT_CLIENT_SECRET || 'test-ms-secret';
  process.env.OAUTH_REDIRECT_BASE_URL = process.env.OAUTH_REDIRECT_BASE_URL || 'http://localhost:3001';

  const { url, state } = getAuthorizationUrl('prov_test_002', 'microsoft');
  assertContains(url, 'microsoftonline.com');
  assertContains(url, 'Calendars.Read');
  assert(state.length === 32);

  process.env.MICROSOFT_CLIENT_ID = oldId;
  process.env.MICROSOFT_CLIENT_SECRET = oldSecret;
  process.env.OAUTH_REDIRECT_BASE_URL = oldBase;
});

test('connection status returns not-connected for unknown provider', () => {
  const status = getConnectionStatus('unknown_provider_999');
  assert(!status.connected, 'Unknown provider should not be connected');
});

test('rejects invalid calendar type', () => {
  try {
    getAuthorizationUrl('prov_001', 'invalid_calendar');
    assert(false, 'Should have thrown error');
  } catch (err) {
    assertContains(err.message, 'Unsupported calendar type');
  }
});

// ─── Results ─────────────────────────────────────────────────
console.log('\n' + '─'.repeat(40));
console.log(`Results: ${passed} passed, ${failed} failed`);

if (failed === 0) {
  console.log('\n✅ Phase 1 foundation is solid. Ready to build Engine 1.\n');
} else {
  console.log('\n⚠️  Fix failing tests before moving to Engine 1.\n');
  process.exit(1);
}
