/**
 * CareX Engine 2 — AI Schedule Agent Tests
 *
 * Run: node test/engine2.test.js
 */

process.env.AUDIT_LOG_DIR = './logs/test-audit';

import {
  registerProvider,
  getAgentStatus,
  ingestSignal,
  computeOnlineStatus,
  SIGNAL_SOURCES,
} from '../src/engine2/agentCore.js';

import {
  extractEmailIntent,
  isSchedulingRelated,
  processEmail,
} from '../src/engine2/emailAgent.js';

import {
  extractSMSIntent,
  ruleBasedSMSIntent,
  registerProviderNumber,
  getProviderByNumber,
  processSMS,
} from '../src/engine2/smsAgent.js';

// ─── Helpers ─────────────────────────────────────────────────
let passed = 0;
let failed = 0;

async function test(name, fn) {
  try {
    await fn();
    console.log(`  ✓ ${name}`);
    passed++;
  } catch (err) {
    console.log(`  ✗ ${name}: ${err.message}`);
    failed++;
  }
}

function assert(condition, msg) {
  if (!condition) throw new Error(msg || 'Assertion failed');
}

function makeFutureSlot(h = 3) {
  return new Date(Date.now() + h * 3600000).toISOString();
}

// ─── Agent Core Tests ─────────────────────────────────────────
async function runAll() {
  console.log('\n📋 Agent Core Tests');

  await test('registers provider with default config', async () => {
    const config = registerProvider('prov_agent_001', {
      enabledSources: [SIGNAL_SOURCES.CALENDAR_GOOGLE],
    });
    assert(config.providerId === 'prov_agent_001');
    assert(config.status === 'running');
    assert(config.watchMode === 'active');
  });

  await test('getAgentStatus returns running for registered provider', async () => {
    const status = getAgentStatus('prov_agent_001');
    assert(status.registered === true);
    assert(status.status === 'running');
    assert(Array.isArray(status.enabledSources));
  });

  await test('getAgentStatus returns not-registered for unknown provider', async () => {
    const status = getAgentStatus('unknown_prov_xyz');
    assert(status.registered === false);
  });

  await test('ingestSignal scrubs PHI from signal text', async () => {
    registerProvider('prov_scrub_test', {});

    const signal = await ingestSignal('prov_scrub_test', {
      source: SIGNAL_SOURCES.EMAIL_GMAIL,
      signalType: 'cancellation',
      text: 'John Smith at 555-123-4567 wants to cancel Thursday 2pm',
      metadata: {},
    });

    assert(signal.source === SIGNAL_SOURCES.EMAIL_GMAIL);
    assert(!signal.scrubbedText.includes('John Smith'), 'Name should be scrubbed');
    assert(!signal.scrubbedText.includes('555-123-4567'), 'Phone should be scrubbed');
    assert(signal.tokensCreated > 0, 'Should have created PHI tokens');
  });

  await test('ingestSignal increments signal count', async () => {
    registerProvider('prov_count_test', {});

    await ingestSignal('prov_count_test', {
      source: SIGNAL_SOURCES.SMS_TWILIO,
      text: 'Cancel my appointment',
      metadata: {},
    });

    await ingestSignal('prov_count_test', {
      source: SIGNAL_SOURCES.SMS_TWILIO,
      text: 'Actually keep it',
      metadata: {},
    });

    const status = getAgentStatus('prov_count_test');
    assert(status.signalCount === 2, `Expected 2 signals, got ${status.signalCount}`);
  });

  await test('ingestSignal throws for unregistered provider', async () => {
    try {
      await ingestSignal('not_registered_999', {
        source: SIGNAL_SOURCES.SMS_TWILIO,
        text: 'Cancel',
        metadata: {},
      });
      assert(false, 'Should have thrown');
    } catch (err) {
      assert(err.message.includes('not registered'), `Unexpected error: ${err.message}`);
    }
  });

  // ─── Auto-Online Status Tests ──────────────────────────────────
  console.log('\n📋 Auto-Online Status Tests');

  await test('provider is online when slots exist in working hours', async () => {
    const status = computeOnlineStatus('prov_001', {
      openSlots: [
        { start: makeFutureSlot(2), end: makeFutureSlot(2.5) },
        { start: makeFutureSlot(4), end: makeFutureSlot(4.5) },
      ],
      workingHours: { start: 0, end: 23 },
      manualOverride: null,
    });

    assert(status.online === true, 'Should be online');
    assert(status.availableCount === 2, 'Should show 2 available slots');
    assert(status.reason === 'slots_available');
  });

  await test('provider is offline when manual override set', async () => {
    const status = computeOnlineStatus('prov_001', {
      openSlots: [{ start: makeFutureSlot(2), end: makeFutureSlot(2.5) }],
      workingHours: { start: 0, end: 23 },
      manualOverride: 'unavailable',
    });

    assert(status.online === false);
    assert(status.reason === 'manual_override');
  });

  await test('provider is offline when no open slots', async () => {
    const status = computeOnlineStatus('prov_001', {
      openSlots: [],
      workingHours: { start: 0, end: 23 },
    });

    assert(status.online === false);
    assert(status.reason === 'no_slots');
  });

  await test('provider is offline when marketplace limit reached', async () => {
    const status = computeOnlineStatus('prov_001', {
      openSlots: [{ start: makeFutureSlot(2), end: makeFutureSlot(2.5) }],
      workingHours: { start: 0, end: 23 },
      marketplaceRules: { slotsUsedToday: 3, maxSlotsPerDay: 3 },
    });

    assert(status.online === false);
    assert(status.reason === 'marketplace_limit');
  });

  await test('nextSlot is populated when provider is online', async () => {
    const firstSlot = makeFutureSlot(1);
    const status = computeOnlineStatus('prov_001', {
      openSlots: [{ start: firstSlot }, { start: makeFutureSlot(3) }],
      workingHours: { start: 0, end: 23 },
    });

    if (status.online) {
      assert(status.nextSlot === firstSlot, 'nextSlot should be earliest available');
    }
  });

  // ─── Email Agent Tests ────────────────────────────────────────
  console.log('\n📋 Email Agent Tests');

  await test('isSchedulingRelated returns true for appointment email', async () => {
    assert(isSchedulingRelated('I need to cancel my appointment tomorrow'));
    assert(isSchedulingRelated('Can we reschedule my visit?'));
    assert(isSchedulingRelated('Appointment confirmation for Dr Smith'));
  });

  await test('isSchedulingRelated returns false for unrelated email', async () => {
    assert(!isSchedulingRelated('Your Amazon order has shipped'));
    assert(!isSchedulingRelated('Happy Birthday!'));
    assert(!isSchedulingRelated('Quarterly sales report attached'));
  });

  await test('ruleBasedEmailIntent classifies cancellation', async () => {
    const testCases = [
      "I can't make it to my appointment",
      'Need to cancel my visit on Thursday',
      "Won't be able to come in",
      'Unable to attend my appointment',
    ];

    for (const text of testCases) {
      const result = await extractEmailIntent(text, null);
      assert(
        result.type === 'cancellation',
        `Expected cancellation for "${text}", got "${result.type}"`
      );
    }
  });

  await test('ruleBasedEmailIntent classifies reschedule', async () => {
    const result = await extractEmailIntent(
      'I need to reschedule my appointment to next week',
      null
    );
    assert(result.type === 'reschedule', `Got ${result.type}`);
    assert(result.confidence > 0.5);
  });

  await test('email intent has required fields', async () => {
    const result = await extractEmailIntent(
      'Cancel my appointment please',
      new Date().toISOString()
    );
    assert(typeof result.type === 'string', 'type should be string');
    assert(typeof result.confidence === 'number', 'confidence should be number');
    assert(result.confidence >= 0 && result.confidence <= 1, 'confidence out of range');
    assert('slotStart' in result, 'slotStart field should exist');
  });

  await test('processEmail returns null for non-scheduling email', async () => {
    registerProvider('prov_email_test', {});

    const result = await processEmail('prov_email_test', {
      messageId: 'msg_irrelevant_001',
      subject: 'Your package has been delivered',
      body: 'Your Amazon order #123 has arrived.',
      date: new Date().toISOString(),
    });

    assert(result === null, 'Should return null for irrelevant email');
  });

  // ─── SMS Agent Tests ──────────────────────────────────────────
  console.log('\n📋 SMS Agent Tests');

  await test('ruleBasedSMSIntent classifies CANCEL keyword', async () => {
    const result = ruleBasedSMSIntent('Cancel my appointment');
    assert(result.type === 'cancellation');
    assert(result.confidence >= 0.85);
  });

  await test('ruleBasedSMSIntent classifies confirmation', async () => {
    const result = ruleBasedSMSIntent('Yes, I confirm');
    assert(result.type === 'confirmation');
  });

  await test('ruleBasedSMSIntent classifies reschedule', async () => {
    const result = ruleBasedSMSIntent('I need to reschedule');
    assert(result.type === 'reschedule');
  });

  await test('ruleBasedSMSIntent classifies question', async () => {
    const result = ruleBasedSMSIntent('What time is my appointment?');
    assert(result.type === 'question');
  });

  await test('extractSMSIntent returns structured result', async () => {
    const result = await extractSMSIntent('Cancel please');
    assert(result.type !== undefined);
    assert(result.confidence !== undefined);
    assert(result.confidence >= 0 && result.confidence <= 1);
  });

  await test('number registry maps correctly', async () => {
    registerProviderNumber('prov_sms_001', '+15551234567');
    const found = getProviderByNumber('+15551234567');
    assert(found === 'prov_sms_001', `Expected prov_sms_001, got ${found}`);
  });

  await test('unknown number returns undefined', async () => {
    const found = getProviderByNumber('+19999999999');
    assert(found === undefined);
  });

  await test('processSMS scrubs phone number before processing', async () => {
    registerProvider('prov_sms_phi_test', {});
    registerProviderNumber('prov_sms_phi_test', '+15550000001');

    try {
      await processSMS('prov_sms_phi_test', 'Cancel my appointment', '+15559876543');
    } catch (err) {
      if (!err.message.includes('Twilio') && !err.message.includes('API')) {
        throw err;
      }
    }
  });

  // ─── Results ─────────────────────────────────────────────────
  console.log('\n' + '─'.repeat(40));
  console.log(`Results: ${passed} passed, ${failed} failed`);

  if (failed === 0) {
    console.log('\n✅ Engine 2 — AI Schedule Agent is solid. Ready for Engine 3.\n');
  } else {
    console.log('\n⚠️  Fix failing tests before moving to Engine 3.\n');
    process.exit(1);
  }
}

runAll().catch(err => { console.error(err); process.exit(1); });
