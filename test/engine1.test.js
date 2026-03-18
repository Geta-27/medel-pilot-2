/**
 * CareX Engine 1 — Slot Intelligence Tests
 *
 * Run: node test/engine1.test.js
 */

import {
  ruleBasedClassify,
  SLOT_EVENT_TYPES,
  AUTO_ACT_THRESHOLD,
} from '../src/engine1/slotClassifier.js';

import {
  processChangedEvents,
  slotEvents,
} from '../src/engine1/slotDetector.js';

import {
  providerVeto,
  providerManualAssign,
  setProviderPreferences,
  getProviderPreferences,
  getPendingVetos,
} from '../src/engine1/vetoEngine.js';

// ─── Test Helpers ────────────────────────────────────────────
let passed = 0;
let failed = 0;

function test(name, fn) {
  try {
    const result = fn();
    if (result && typeof result.then === 'function') {
      return result.then(() => {
        console.log(`  ✓ ${name}`);
        passed++;
      }).catch(err => {
        console.log(`  ✗ ${name}`);
        console.log(`    Error: ${err.message}`);
        failed++;
      });
    }
    console.log(`  ✓ ${name}`);
    passed++;
  } catch (err) {
    console.log(`  ✗ ${name}`);
    console.log(`    Error: ${err.message}`);
    failed++;
  }
  return Promise.resolve();
}

function assert(condition, message) {
  if (!condition) throw new Error(message || 'Assertion failed');
}

function makeFutureSlot(hoursFromNow = 2) {
  return new Date(Date.now() + hoursFromNow * 60 * 60 * 1000).toISOString();
}

function makePastSlot(minutesAgo = 15) {
  return new Date(Date.now() - minutesAgo * 60 * 1000).toISOString();
}

// ─── Classifier Tests ────────────────────────────────────────
console.log('\n📋 Slot Classifier Tests');

async function runClassifierTests() {
  await test('classifies explicit Google cancellation status', () => {
    const result = ruleBasedClassify({
      status: 'cancelled',
      slotStart: makeFutureSlot(3),
      scrubbedTitle: '',
      scrubbedNotes: '',
    });
    assert(result !== null, 'Should classify');
    assert(result.type === SLOT_EVENT_TYPES.CANCELLATION, `Expected cancellation, got ${result.type}`);
    assert(result.confidence >= AUTO_ACT_THRESHOLD, 'Future cancellation should be high confidence');
    assert(result.autoAct === true, 'Should auto-act');
  });

  await test('classifies no-show when slot time just passed', () => {
    const result = ruleBasedClassify({
      status: 'cancelled',
      slotStart: makePastSlot(10),
      scrubbedTitle: '',
      scrubbedNotes: '',
    });
    assert(result !== null, 'Should classify');
    assert(result.type === SLOT_EVENT_TYPES.NO_SHOW, `Expected no_show, got ${result.type}`);
    assert(result.autoAct === false, 'No-show should require provider confirm');
  });

  await test('classifies cancellation from text signals', () => {
    const result = ruleBasedClassify({
      status: 'confirmed',
      slotStart: makeFutureSlot(4),
      scrubbedTitle: 'Patient cancelled appointment',
      scrubbedNotes: '',
    });
    assert(result !== null, 'Should classify');
    assert(result.type === SLOT_EVENT_TYPES.CANCELLATION);
  });

  await test('classifies reschedule from text signals', () => {
    const result = ruleBasedClassify({
      status: 'confirmed',
      slotStart: makeFutureSlot(2),
      scrubbedTitle: 'Need to reschedule appointment',
      scrubbedNotes: '',
    });
    assert(result !== null);
    assert(result.type === SLOT_EVENT_TYPES.RESCHEDULE);
  });

  await test('returns null for ambiguous events (sends to AI)', () => {
    const result = ruleBasedClassify({
      status: 'confirmed',
      slotStart: makeFutureSlot(2),
      scrubbedTitle: 'Appointment update',
      scrubbedNotes: '',
    });
    assert(result === null, 'Ambiguous event should return null for AI fallback');
  });

  await test('confidence is between 0 and 1', () => {
    const result = ruleBasedClassify({
      status: 'cancelled',
      slotStart: makeFutureSlot(5),
      scrubbedTitle: '',
      scrubbedNotes: '',
    });
    assert(result.confidence >= 0 && result.confidence <= 1,
      `Confidence ${result.confidence} out of range`);
  });

  await test('autoAct is true only above threshold', () => {
    const highConf = ruleBasedClassify({
      status: 'cancelled',
      slotStart: makeFutureSlot(3),
      scrubbedTitle: '',
      scrubbedNotes: '',
    });
    assert(highConf.autoAct === (highConf.confidence >= AUTO_ACT_THRESHOLD),
      'autoAct should match confidence threshold');
  });
}

// ─── Veto Engine Tests ───────────────────────────────────────
console.log('\n📋 Veto Engine Tests');

async function runVetoTests() {
  await test('sets provider preferences correctly', () => {
    const prefs = setProviderPreferences('prov_test_001', {
      vetoWindowMs: 60000,
      autoActOnCancellation: true,
      maxMarketplaceSlots: 5,
    });
    assert(prefs.vetoWindowMs === 60000);
    assert(prefs.maxMarketplaceSlots === 5);
  });

  await test('returns default prefs for unknown provider', () => {
    const prefs = getProviderPreferences('unknown_prov_999');
    assert(typeof prefs.vetoWindowMs === 'number');
    assert(typeof prefs.autoActOnCancellation === 'boolean');
    assert(prefs.maxMarketplaceSlots >= 1);
  });

  await test('caps veto window at maximum', () => {
    const prefs = setProviderPreferences('prov_cap_test', {
      vetoWindowMs: 999999999,
    });
    assert(prefs.vetoWindowMs <= 5 * 60 * 1000, 'Should cap at 5 minutes');
  });

  await test('veto returns error for unknown eventId', async () => {
    const result = await providerVeto('nonexistent_event_999', 'prov_001');
    assert(result.success === false);
    assert(result.message.includes('expired') || result.message.includes('window'));
  });

  await test('manual assign emits confirmed event', async () => {
    let confirmed = false;
    slotEvents.once('slot:confirmed', (event) => {
      confirmed = true;
      assert(event.autoAssigned === false, 'Manual assign should not be auto');
    });

    const result = await providerManualAssign(
      'test_event_manual_001',
      'prov_test_001',
      'PATIENT_TOKEN_ABC'
    );

    assert(result.success === true);
    await new Promise(r => setTimeout(r, 10));
    assert(confirmed, 'slot:confirmed event should have been emitted');
  });

  await test('getPendingVetos returns empty for provider with none', () => {
    const pending = getPendingVetos('prov_with_no_vetos_999');
    assert(Array.isArray(pending));
    assert(pending.length === 0);
  });
}

// ─── Slot Detector Tests ─────────────────────────────────────
console.log('\n📋 Slot Detector Tests');

async function runDetectorTests() {
  await test('processChangedEvents emits slot:changed for cancelled event', async () => {
    let eventReceived = false;

    slotEvents.once('slot:changed', (event) => {
      eventReceived = true;
      assert(event.providerId === 'prov_detector_test');
      assert(event.status === 'cancelled');
      assert(event.patientToken, 'Should have patient token (PHI scrubbed)');
      assert(!event.patientId, 'Raw patient ID should not be present');
    });

    await processChangedEvents('prov_detector_test', [
      {
        eventId: 'evt_test_cancel_001',
        title: 'John Smith - Follow Up',
        start: makeFutureSlot(2),
        end: makeFutureSlot(2.5),
        status: 'cancelled',
        attendees: ['patient@test.com'],
        notes: 'Patient John Smith cancelled via phone',
        source: 'google',
      }
    ], 'test_signal');

    await new Promise(r => setTimeout(r, 50));
    assert(eventReceived, 'slot:changed event should have been emitted');
  });

  await test('PHI is scrubbed before slot:changed event is emitted', async () => {
    let slotEvent = null;

    slotEvents.once('slot:changed', (event) => {
      slotEvent = event;
    });

    await processChangedEvents('prov_phi_test', [
      {
        eventId: 'evt_phi_test_001',
        title: 'Sarah Connor - New Patient',
        start: makeFutureSlot(3),
        end: makeFutureSlot(3.5),
        status: 'cancelled',
        attendees: ['sarah.connor@skynet.com'],
        notes: 'Patient DOB 1984-10-15',
        source: 'google',
      }
    ], 'test_signal');

    await new Promise(r => setTimeout(r, 50));
    assert(slotEvent !== null, 'Event should have been emitted');

    const title = slotEvent.scrubbedTitle || '';
    const notes = slotEvent.scrubbedNotes || '';
    assert(!title.includes('Sarah Connor'), 'Name should be scrubbed from title');
    assert(!notes.includes('1984'), 'DOB should be scrubbed from notes');
    assert(!notes.includes('sarah.connor@skynet.com'), 'Email should be scrubbed');
  });

  await test('multiple events are all processed', async () => {
    let eventCount = 0;
    const handler = () => eventCount++;
    slotEvents.on('slot:changed', handler);

    await processChangedEvents('prov_multi_test', [
      { eventId: 'evt_multi_1', title: 'A B', start: makeFutureSlot(1), end: makeFutureSlot(1.5), status: 'cancelled', attendees: [], notes: '', source: 'google' },
      { eventId: 'evt_multi_2', title: 'C D', start: makeFutureSlot(2), end: makeFutureSlot(2.5), status: 'cancelled', attendees: [], notes: '', source: 'google' },
    ], 'test_signal');

    await new Promise(r => setTimeout(r, 100));
    slotEvents.removeListener('slot:changed', handler);
    assert(eventCount >= 2, `Expected at least 2 events, got ${eventCount}`);
  });
}

// ─── Run All Tests ───────────────────────────────────────────
async function runAll() {
  await runClassifierTests();
  await runVetoTests();
  await runDetectorTests();

  await new Promise(r => setTimeout(r, 200));

  console.log('\n' + '─'.repeat(40));
  console.log(`Results: ${passed} passed, ${failed} failed`);

  if (failed === 0) {
    console.log('\n✅ Engine 1 — Slot Intelligence is solid. Ready for Engine 2.\n');
  } else {
    console.log('\n⚠️  Fix failing tests before moving to Engine 2.\n');
    process.exit(1);
  }
}

runAll().catch(err => {
  console.error('Test runner failed:', err);
  process.exit(1);
});
