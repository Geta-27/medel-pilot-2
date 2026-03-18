/**
 * CareX — Standing Rules Engine
 * Engine 3, Module 2
 *
 * Provider sets their preferences ONCE during onboarding.
 * System acts on unused capacity automatically, forever.
 *
 * Rules govern:
 *   - When to auto-open slots to marketplace
 *   - How many slots per day to expose
 *   - Which patient types to accept
 *   - Lead time requirements
 *   - Insurance/payment filters
 *
 * This is the "set it and forget it" layer that eliminates
 * the daily front-desk decision burden entirely.
 */

import { log, ACTIONS } from '../hipaa/auditLogger.js';
import { analyzeCapacity } from './capacityGapDetector.js';
import { slotEvents } from '../engine1/slotDetector.js';

// ─── Rules Store ──────────────────────────────────────────────
const rulesStore = new Map();    // providerId → StandingRules
const dailyCounters = new Map(); // `${providerId}:${date}` → slotsOpenedToday

// ─── Default Rules ────────────────────────────────────────────
const DEFAULT_RULES = {
  // Automation level
  automationLevel: 'suggest',  // 'off' | 'suggest' | 'auto_with_veto' | 'full_auto'

  // Slot opening rules
  autoOpenUnusedSlots: false,
  openSlotsAfterHours: 2,
  maxMarketplaceSlotsDay: 3,
  minLeadTimeHours: 1,

  // Patient acceptance rules
  acceptNewPatients: true,
  acceptFollowUps: true,
  acceptUrgentSameDay: true,
  insuranceFilter: 'all', // 'all' | 'in_network' | 'cash_only' | string[]

  // Notification preferences
  notifyOnGap: true,
  notifyThresholdPct: 30,
  notifyViaPush: true,
  notifyViaSMS: false,

  // Revenue optimization
  enableYieldOptimization: false,
  prioritizeHighValue: false,
};

// ─── Rules Management ─────────────────────────────────────────
function setStandingRules(providerId, rules) {
  const current = rulesStore.get(providerId) || { ...DEFAULT_RULES };
  const updated = { ...current, ...rules, providerId, updatedAt: new Date().toISOString() };
  rulesStore.set(providerId, updated);

  log(ACTIONS.PROVIDER_RULE_SET, {
    actorId: providerId,
    actorType: 'provider',
    details: { rulesUpdated: Object.keys(rules), automationLevel: updated.automationLevel },
  });

  return updated;
}

function getStandingRules(providerId) {
  return rulesStore.get(providerId) || { ...DEFAULT_RULES, providerId };
}

// ─── Core Rules Evaluation ────────────────────────────────────
function evaluateRules(providerId, capacityReport) {
  const rules = getStandingRules(providerId);
  const todayKey = `${providerId}:${capacityReport.date}`;
  const usedToday = dailyCounters.get(todayKey) || 0;

  if (rules.automationLevel === 'off') {
    return decision('no_action', 'Automation disabled by provider', [], rules);
  }

  if (!capacityReport.isActionable || capacityReport.futureGapCount === 0) {
    return decision('no_action', 'No future unused slots detected', [], rules);
  }

  if (usedToday >= rules.maxMarketplaceSlotsDay) {
    return decision(
      'limit_reached',
      `Daily marketplace limit reached (${rules.maxMarketplaceSlotsDay} slots)`,
      [],
      rules
    );
  }

  const remainingCapacity = rules.maxMarketplaceSlotsDay - usedToday;
  const eligibleSlots = filterEligibleSlots(
    capacityReport.unusedSlotTimes,
    rules,
    remainingCapacity
  );

  if (eligibleSlots.length === 0) {
    return decision('no_eligible_slots', 'No slots pass lead time filter', [], rules);
  }

  switch (rules.automationLevel) {
    case 'suggest':
      return decision(
        'suggest_open',
        `${eligibleSlots.length} slot(s) available — awaiting provider approval`,
        eligibleSlots,
        rules
      );

    case 'auto_with_veto':
      return decision(
        'auto_open_with_veto',
        `Auto-opening ${eligibleSlots.length} slot(s) — veto window active`,
        eligibleSlots,
        rules
      );

    case 'full_auto':
      return decision(
        'auto_open',
        `Auto-opening ${eligibleSlots.length} slot(s) per standing rules`,
        eligibleSlots,
        rules
      );

    default:
      return decision('no_action', 'Unknown automation level', [], rules);
  }
}

function decision(action, message, slots, rules) {
  return { action, message, eligibleSlots: slots, automationLevel: rules.automationLevel };
}

// ─── Slot Eligibility Filter ──────────────────────────────────
function filterEligibleSlots(unusedSlots, rules, maxCount) {
  const now = new Date();
  const minLeadTimeMs = rules.minLeadTimeHours * 60 * 60 * 1000;

  return unusedSlots
    .filter((slot) => {
      const slotTime = new Date(slot.start);
      const msUntilSlot = slotTime - now;

      if (msUntilSlot < minLeadTimeMs) return false;

      const hoursUntil = msUntilSlot / (1000 * 60 * 60);
      if (hoursUntil > 8) return false;

      return true;
    })
    .slice(0, maxCount);
}

// ─── Execute Rules Decision ───────────────────────────────────
async function executeDecision(providerId, rulesDecision, capacityReport) {
  const { action, eligibleSlots } = rulesDecision;
  const todayKey = `${providerId}:${capacityReport.date}`;

  switch (action) {
    case 'suggest_open':
      await notifyProviderOfGap(providerId, eligibleSlots, capacityReport, 'suggestion');
      break;

    case 'auto_open_with_veto': {
      const opened = await openSlotsToMarketplace(providerId, eligibleSlots, true);
      updateDailyCounter(todayKey, opened);
      await notifyProviderOfGap(providerId, eligibleSlots, capacityReport, 'auto_with_veto');
      break;
    }

    case 'auto_open': {
      const opened = await openSlotsToMarketplace(providerId, eligibleSlots, false);
      updateDailyCounter(todayKey, opened);
      break;
    }

    case 'limit_reached':
    case 'no_eligible_slots':
    case 'no_action':
    default:
      break;
  }

  return rulesDecision;
}

async function openSlotsToMarketplace(providerId, slots, withVetoWindow) {
  for (const slot of slots) {
    slotEvents.emit('slot:marketplace_open', {
      providerId,
      slotStart: slot.start,
      slotEnd: slot.end,
      withVetoWindow,
      source: 'standing_rules',
      openedAt: new Date().toISOString(),
    });

    log(ACTIONS.AGENT_SLOT_RELEASED, {
      actorType: 'agent',
      resourceId: providerId,
      details: {
        slotStart: slot.start,
        withVetoWindow,
        source: 'standing_rules',
      },
    });
  }

  return slots.length;
}

async function notifyProviderOfGap(providerId, slots, report, notifyType) {
  const message = notifyType === 'suggestion'
    ? `You have ${slots.length} unused slot(s) today. Open to marketplace?`
    : `Auto-opening ${slots.length} slot(s) per your standing rules. Tap to veto.`;

  slotEvents.emit('provider:notification', {
    providerId,
    notification: {
      type: 'CAPACITY_GAP',
      message,
      slots: slots.map((s) => s.start),
      report: {
        utilizationPct: report.utilizationPct,
        unusedCount: report.unusedCount,
      },
    },
  });
}

function updateDailyCounter(key, count) {
  dailyCounters.set(key, (dailyCounters.get(key) || 0) + count);
}

// ─── Full Pipeline ────────────────────────────────────────────
async function runCapacityPipeline(providerId, bookedSlots = []) {
  try {
    const report = analyzeCapacity(providerId, bookedSlots);
    const rulesDecision = evaluateRules(providerId, report);
    await executeDecision(providerId, rulesDecision, report);
    return { report, rulesDecision };
  } catch (err) {
    log(ACTIONS.SYSTEM_ERROR, {
      actorType: 'agent',
      details: { action: 'CAPACITY_PIPELINE_ERROR', error: err.message, providerId },
      outcome: 'failure',
    });
    throw err;
  }
}

// ─── Exports ─────────────────────────────────────────────────
export {
  setStandingRules,
  getStandingRules,
  evaluateRules,
  executeDecision,
  runCapacityPipeline,
  filterEligibleSlots,
  DEFAULT_RULES,
};

export default {
  setStandingRules,
  getStandingRules,
  evaluateRules,
  executeDecision,
  runCapacityPipeline,
  filterEligibleSlots,
  DEFAULT_RULES,
};
