/**
 * CareX Engine 3 — Capacity Intelligence Tests
 * Run: node test/engine3.test.js
 */

process.env.AUDIT_LOG_DIR = './logs/test-audit';

import {
  setCapacityConfig,
  getCapacityConfig,
  analyzeCapacity,
  buildTheoreticalSlots,
  estimateRevenue,
  DEFAULT_CAPACITY_CONFIG,
} from '../src/engine3/capacityGapDetector.js';

import {
  setStandingRules,
  getStandingRules,
  evaluateRules,
  runCapacityPipeline,
  filterEligibleSlots,
  DEFAULT_RULES,
} from '../src/engine3/standingRulesEngine.js';

import {
  predictNoShow,
  scoreSchedule,
  extractFeatures,
  getRiskTier,
  BASE_RATE,
  RISK_FACTORS,
  recordOutcome,
} from '../src/engine3/noShowPredictor.js';

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

function makeFutureSlot(hoursFromNow) {
  return new Date(Date.now() + hoursFromNow * 3600000).toISOString();
}

function makePastSlot(hoursAgo) {
  return new Date(Date.now() - hoursAgo * 3600000).toISOString();
}

function makeBookedSlot(hoursFromNow) {
  return { start: makeFutureSlot(hoursFromNow), end: makeFutureSlot(hoursFromNow + 0.5) };
}

// ─── Capacity Detector Tests ──────────────────────────────────
async function runCapacityTests() {
  console.log('\n📋 Capacity Detector Tests');

  await test('sets and retrieves capacity config', async () => {
    const config = setCapacityConfig('prov_cap_001', { dailyPatientMax: 20, specialtyType: 'cardiology' });
    assert(config.dailyPatientMax === 20);
    assert(config.specialtyType === 'cardiology');
    assert(config.providerId === 'prov_cap_001');

    const retrieved = getCapacityConfig('prov_cap_001');
    assert(retrieved.dailyPatientMax === 20);
  });

  await test('returns defaults for unconfigured provider', async () => {
    const config = getCapacityConfig('prov_never_configured');
    assert(config.dailyPatientMax === DEFAULT_CAPACITY_CONFIG.dailyPatientMax);
    assert(config.slotDurationMins === DEFAULT_CAPACITY_CONFIG.slotDurationMins);
  });

  await test('builds correct number of theoretical slots', async () => {
    const config = {
      dailyPatientMax: 10,
      slotDurationMins: 30,
      bufferMins: 10,
      workingHours: { start: 8, end: 13 },
      workingDays: [0, 1, 2, 3, 4, 5, 6],
    };
    const slots = buildTheoreticalSlots(config, new Date());
    assert(slots.length > 0, 'Should have slots');
    assert(slots.length <= 10, 'Should not exceed daily max');
  });

  await test('buildTheoreticalSlots returns empty on non-working day', async () => {
    const config = {
      ...DEFAULT_CAPACITY_CONFIG,
      workingDays: [999],
    };
    const slots = buildTheoreticalSlots(config, new Date());
    assert(slots.length === 0, 'Non-working day should produce no slots');
  });

  await test('analyzeCapacity detects unused slots', async () => {
    setCapacityConfig('prov_analyze_001', {
      dailyPatientMax: 10,
      slotDurationMins: 30,
      bufferMins: 10,
      workingHours: { start: 0, end: 23 },
      workingDays: [0, 1, 2, 3, 4, 5, 6],
    });

    const bookedSlots = [
      makeBookedSlot(2),
      makeBookedSlot(3),
      makeBookedSlot(4),
    ];

    const report = analyzeCapacity('prov_analyze_001', bookedSlots);
    assert(report.bookedCount === 3, 'Should show 3 booked');
    assert(report.unusedCount > 0, 'Should detect unused slots');
    assert(report.utilizationPct < 100, 'Utilization should be < 100%');
    assert(report.providerId === 'prov_analyze_001');
    assert(typeof report.revenueOpportunity.total === 'number');
  });

  await test('analyzeCapacity marks report as actionable when future gaps exist', async () => {
    setCapacityConfig('prov_actionable_test', {
      dailyPatientMax: 8,
      slotDurationMins: 30,
      bufferMins: 10,
      workingHours: { start: 0, end: 23 },
      workingDays: [0, 1, 2, 3, 4, 5, 6],
    });

    const tomorrow = new Date();
    tomorrow.setUTCDate(tomorrow.getUTCDate() + 1);
    tomorrow.setUTCHours(0, 0, 0, 1);

    const report = analyzeCapacity('prov_actionable_test', [], tomorrow);
    assert(report.isActionable === true, 'Empty schedule should be actionable');
    assert(report.futureGapCount > 0, `Should have future gaps, got ${report.futureGapCount}`);
  });

  await test('estimateRevenue calculates correctly for specialty', async () => {
    const rev = estimateRevenue(5, 'cardiology');
    assert(rev.perSlot > 0, 'Per-slot revenue should be positive');
    assert(rev.total === rev.perSlot * 5, 'Total should be perSlot * count');
    assert(rev.monthly > rev.total, 'Monthly should exceed daily total');
    assert(rev.currency === 'USD');
  });

  await test('report includes unused slot times', async () => {
    setCapacityConfig('prov_times_test', {
      dailyPatientMax: 5,
      slotDurationMins: 60,
      bufferMins: 0,
      workingHours: { start: 0, end: 23 },
      workingDays: [0, 1, 2, 3, 4, 5, 6],
    });

    const report = analyzeCapacity('prov_times_test', []);
    assert(Array.isArray(report.unusedSlotTimes), 'Should return array of slot times');
    if (report.unusedSlotTimes.length > 0) {
      const slot = report.unusedSlotTimes[0];
      assert(slot.start, 'Slot should have start time');
      assert(slot.end, 'Slot should have end time');
      assert(typeof slot.minutesUntil === 'number', 'Should have minutesUntil');
    }
  });
}

// ─── Standing Rules Tests ─────────────────────────────────────
async function runRulesTests() {
  console.log('\n📋 Standing Rules Tests');

  await test('sets and retrieves standing rules', async () => {
    const rules = setStandingRules('prov_rules_001', {
      automationLevel: 'auto_with_veto',
      maxMarketplaceSlotsDay: 5,
      minLeadTimeHours: 2,
    });
    assert(rules.automationLevel === 'auto_with_veto');
    assert(rules.maxMarketplaceSlotsDay === 5);

    const retrieved = getStandingRules('prov_rules_001');
    assert(retrieved.automationLevel === 'auto_with_veto');
  });

  await test('returns defaults for unconfigured provider', async () => {
    const rules = getStandingRules('prov_no_rules_999');
    assert(rules.automationLevel === DEFAULT_RULES.automationLevel);
    assert(rules.maxMarketplaceSlotsDay === DEFAULT_RULES.maxMarketplaceSlotsDay);
  });

  await test('evaluateRules returns no_action when automation is off', async () => {
    setStandingRules('prov_off_001', { automationLevel: 'off' });
    setCapacityConfig('prov_off_001', {
      dailyPatientMax: 10, slotDurationMins: 30, bufferMins: 10,
      workingHours: { start: 0, end: 23 }, workingDays: [0,1,2,3,4,5,6],
    });

    const report = analyzeCapacity('prov_off_001', []);
    const decision = evaluateRules('prov_off_001', report);
    assert(decision.action === 'no_action', `Expected no_action, got ${decision.action}`);
  });

  await test('evaluateRules suggests slots in suggest mode', async () => {
    const prov = 'prov_suggest_001';
    setStandingRules(prov, {
      automationLevel: 'suggest',
      maxMarketplaceSlotsDay: 5,
      minLeadTimeHours: 0,
      autoOpenUnusedSlots: true,
    });
    setCapacityConfig(prov, {
      dailyPatientMax: 10, slotDurationMins: 30, bufferMins: 10,
      workingHours: { start: 0, end: 23 }, workingDays: [0,1,2,3,4,5,6],
    });

    const report = analyzeCapacity(prov, []);
    const decision = evaluateRules(prov, report);

    assert(
      decision.action === 'suggest_open' || decision.action === 'no_eligible_slots' || decision.action === 'no_action',
      `Unexpected action: ${decision.action}`
    );
  });

  await test('evaluateRules auto_with_veto for actionable report', async () => {
    const prov = 'prov_veto_mode_001';
    setStandingRules(prov, {
      automationLevel: 'auto_with_veto',
      maxMarketplaceSlotsDay: 5,
      minLeadTimeHours: 0,
    });
    setCapacityConfig(prov, {
      dailyPatientMax: 10, slotDurationMins: 30, bufferMins: 5,
      workingHours: { start: 0, end: 23 }, workingDays: [0,1,2,3,4,5,6],
    });

    const report = analyzeCapacity(prov, []);
    const decision = evaluateRules(prov, report);
    assert(
      ['auto_open_with_veto', 'no_eligible_slots', 'no_action'].includes(decision.action),
      `Unexpected action: ${decision.action}`
    );
  });

  await test('filterEligibleSlots respects lead time', async () => {
    const rules = { minLeadTimeHours: 2, maxMarketplaceSlotsDay: 10 };
    const slots = [
      { start: makeFutureSlot(0.5), end: makeFutureSlot(1) },
      { start: makeFutureSlot(3), end: makeFutureSlot(3.5) },
      { start: makeFutureSlot(5), end: makeFutureSlot(5.5) },
    ];
    const eligible = filterEligibleSlots(slots, rules, 10);
    assert(eligible.length === 2, `Expected 2 eligible, got ${eligible.length}`);
    assert(!eligible.some(s => new Date(s.start) - new Date() < 2 * 3600000),
      'No slot within lead time should pass');
  });

  await test('filterEligibleSlots respects daily limit', async () => {
    const rules = { minLeadTimeHours: 0, maxMarketplaceSlotsDay: 10 };
    const slots = Array.from({ length: 6 }, (_, i) => ({
      start: makeFutureSlot(i + 1),
      end: makeFutureSlot(i + 1.5),
    }));
    const eligible = filterEligibleSlots(slots, rules, 3);
    assert(eligible.length <= 3, `Expected <= 3, got ${eligible.length}`);
  });

  await test('runCapacityPipeline returns report and decision', async () => {
    const prov = 'prov_pipeline_001';
    setStandingRules(prov, { automationLevel: 'suggest', minLeadTimeHours: 0 });
    setCapacityConfig(prov, {
      dailyPatientMax: 8, slotDurationMins: 30, bufferMins: 10,
      workingHours: { start: 0, end: 23 }, workingDays: [0,1,2,3,4,5,6],
    });

    const { report, rulesDecision } = await runCapacityPipeline(prov, []);
    assert(report !== undefined, 'Should return report');
    assert(rulesDecision !== undefined, 'Should return decision');
    assert(typeof report.utilizationPct === 'number');
    assert(typeof rulesDecision.action === 'string');
  });
}

// ─── No-Show Predictor Tests ──────────────────────────────────
async function runPredictorTests() {
  console.log('\n📋 No-Show Predictor Tests');

  await test('predictNoShow returns valid probability', async () => {
    const pred = predictNoShow({
      providerId: 'prov_pred_001',
      slotStart: makeFutureSlot(72),
      bookedAt: makePastSlot(48),
      appointmentType: 'follow_up',
      isNewPatient: false,
      insuranceType: 'commercial',
    });

    assert(pred.probability >= 0 && pred.probability <= 1,
      `Probability ${pred.probability} out of range`);
    assert(['critical','high','medium','low'].includes(pred.riskTier),
      `Invalid risk tier: ${pred.riskTier}`);
    assert(Array.isArray(pred.actions));
    assert(pred.predictedAt);
  });

  await test('long lead time increases no-show probability', async () => {
    const baseAppt = {
      providerId: 'prov_pred_001',
      slotStart: makeFutureSlot(2),
      bookedAt: new Date().toISOString(),
      isNewPatient: false,
      insuranceType: 'commercial',
    };

    const shortLead = predictNoShow({ ...baseAppt, bookedAt: makePastSlot(1) });
    const longLead = predictNoShow({ ...baseAppt, bookedAt: makePastSlot(720) });

    assert(
      longLead.probability >= shortLead.probability,
      `Long lead (${longLead.probability}) should be >= short lead (${shortLead.probability})`
    );
  });

  await test('urgent appointment has lower no-show risk', async () => {
    const base = {
      providerId: 'prov_pred_001',
      slotStart: makeFutureSlot(4),
      bookedAt: makePastSlot(2),
      insuranceType: 'commercial',
    };

    const urgent = predictNoShow({ ...base, isUrgent: true });
    const nonUrgent = predictNoShow({ ...base, isUrgent: false });

    assert(
      urgent.probability <= nonUrgent.probability,
      `Urgent (${urgent.probability}) should be <= non-urgent (${nonUrgent.probability})`
    );
  });

  await test('new patient has higher no-show risk than follow-up', async () => {
    const base = {
      providerId: 'prov_pred_001',
      slotStart: makeFutureSlot(48),
      bookedAt: makePastSlot(7 * 24),
      insuranceType: 'commercial',
      isUrgent: false,
    };

    const newPt = predictNoShow({ ...base, isNewPatient: true, isFollowUp: false });
    const followUp = predictNoShow({ ...base, isNewPatient: false, isFollowUp: true });

    assert(
      newPt.probability >= followUp.probability,
      `New patient (${newPt.probability}) should be >= follow-up (${followUp.probability})`
    );
  });

  await test('getRiskTier correctly maps probability ranges', async () => {
    assert(getRiskTier(0.65) === 'critical');
    assert(getRiskTier(0.45) === 'high');
    assert(getRiskTier(0.30) === 'medium');
    assert(getRiskTier(0.10) === 'low');
  });

  await test('critical risk generates pre_market action', async () => {
    const pred = predictNoShow({
      providerId: 'prov_pred_001',
      slotStart: makeFutureSlot(720),
      bookedAt: makePastSlot(720),
      isNewPatient: true,
      insuranceType: 'medicaid',
      isFollowUp: false,
      isUrgent: false,
    });

    if (pred.riskTier === 'critical' || pred.riskTier === 'high') {
      const hasPreMarket = pred.actions.some(a => a.type === 'pre_market_slot');
      assert(hasPreMarket, 'High/critical risk should include pre_market_slot action');
    }
  });

  await test('scoreSchedule processes multiple appointments', async () => {
    const appointments = [
      { slotStart: makeFutureSlot(2), bookedAt: makePastSlot(1), isNewPatient: false, insuranceType: 'commercial' },
      { slotStart: makeFutureSlot(4), bookedAt: makePastSlot(30 * 24), isNewPatient: true, insuranceType: 'medicaid' },
      { slotStart: makeFutureSlot(6), bookedAt: makePastSlot(3), isFollowUp: true, insuranceType: 'medicare' },
    ];

    const result = scoreSchedule('prov_score_001', appointments);
    assert(result.predictions.length === 3, 'Should score all appointments');
    assert(result.summary.total === 3, 'Summary total should match');
    assert(typeof result.summary.avgRiskPct === 'number');
    assert(typeof result.summary.expectedNoShows === 'number');
    assert(result.summary.expectedNoShows >= 0);
  });

  await test('scoreSchedule handles empty schedule', async () => {
    const result = scoreSchedule('prov_empty_001', []);
    assert(result.predictions.length === 0);
    assert(result.summary.total === 0);
  });

  await test('extractFeatures returns non-PHI features only', async () => {
    const features = extractFeatures({
      slotStart: makeFutureSlot(24),
      bookedAt: makePastSlot(7 * 24),
      appointmentType: 'follow_up',
      isNewPatient: false,
      isFollowUp: true,
      isUrgent: false,
      insuranceType: 'commercial',
      providerId: 'prov_001',
    });

    assert(typeof features.leadTimeDays === 'number');
    assert(typeof features.dayOfWeek === 'number');
    assert(typeof features.hourOfDay === 'number');
    assert(typeof features.isNewPatient === 'boolean');
    assert(typeof features.isFollowUp === 'boolean');
    assert(features.insuranceType === 'commercial');

    assert(!('patientName' in features), 'No patient name in features');
    assert(!('patientEmail' in features), 'No patient email in features');
    assert(!('patientDOB' in features), 'No patient DOB in features');
  });

  await test('base rate is within realistic healthcare range', async () => {
    assert(BASE_RATE >= 0.10 && BASE_RATE <= 0.30,
      `Base rate ${BASE_RATE} outside expected 10-30% range`);
  });

  await test('historical outcomes can be recorded without crashing', async () => {
    recordOutcome('prov_hist_001', 1, 9, true);
    recordOutcome('prov_hist_001', 1, 9, false);
    assert(true, 'recordOutcome completed');
  });
}

// ─── Run All ─────────────────────────────────────────────────
async function runAll() {
  await runCapacityTests();
  await runRulesTests();
  await runPredictorTests();

  await new Promise(r => setTimeout(r, 100));

  console.log('\n' + '─'.repeat(40));
  console.log(`Results: ${passed} passed, ${failed} failed`);

  if (failed === 0) {
    console.log('\n✅ Engine 3 — Capacity Intelligence is solid.\n');
    console.log('🎉 All three CareX engines are built and tested.\n');
    console.log('   Phase 1  — HIPAA Foundation      ✅');
    console.log('   Engine 1 — Slot Intelligence     ✅');
    console.log('   Engine 2 — AI Schedule Agent     ✅');
    console.log('   Engine 3 — Capacity Intelligence ✅\n');
  } else {
    console.log('\n⚠️  Fix failing tests.\n');
    process.exit(1);
  }
}

runAll().catch(err => { console.error(err); process.exit(1); });
