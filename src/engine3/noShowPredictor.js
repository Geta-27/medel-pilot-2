/**
 * CareX — No-Show Predictor
 * Engine 3, Module 3
 *
 * Predicts the probability that a specific appointment will be a no-show.
 * High-risk appointments trigger proactive capacity management:
 *   - Pre-market the slot to waitlisted patients
 *   - Double-book with patient disclosure
 *   - Alert provider with suggested action
 *
 * Feature set (ALL non-PHI — no patient identifiers):
 *   - Lead time (days booked in advance)
 *   - Day of week
 *   - Time of day
 *   - Appointment type
 *   - Historical no-show rate for this provider + slot time
 *   - Weather proxy (not yet implemented)
 *   - Insurance type
 *
 * HIPAA: Model operates on behavioral signals only.
 *        No patient names, DOBs, or identifiers used.
 *        Patient token used as lookup key — never as a feature.
 */

import { log, logError, ACTIONS } from '../hipaa/auditLogger.js';
import { slotEvents } from '../engine1/slotDetector.js';

// ─── Historical No-Show Data ──────────────────────────────────
const noShowHistory = new Map(); // `${providerId}:${slotKey}` → rate

// ─── Feature Extraction ───────────────────────────────────────
function extractFeatures(appointment) {
  const slotTime = new Date(appointment.slotStart);
  const bookedTime = appointment.bookedAt ? new Date(appointment.bookedAt) : new Date();

  const leadTimeDays = Math.max(0, (slotTime - bookedTime) / (1000 * 60 * 60 * 24));
  const dayOfWeek = slotTime.getDay();
  const hourOfDay = slotTime.getHours();
  const monthOfYear = slotTime.getMonth();
  const isMonday = dayOfWeek === 1;
  const isFriday = dayOfWeek === 5;
  const isMorning = hourOfDay < 12;
  const isEndOfDay = hourOfDay >= 16;
  const isLunchTime = hourOfDay >= 11 && hourOfDay <= 13;
  const isLongLeadTime = leadTimeDays > 14;
  const isVeryLongLead = leadTimeDays > 30;
  const isSameDay = leadTimeDays < 1;

  return {
    leadTimeDays: Math.round(leadTimeDays * 10) / 10,
    dayOfWeek,
    hourOfDay,
    monthOfYear,
    isMonday,
    isFriday,
    isMorning,
    isEndOfDay,
    isLunchTime,
    isLongLeadTime,
    isVeryLongLead,
    isSameDay,
    appointmentType: appointment.appointmentType || 'unknown',
    isNewPatient: appointment.isNewPatient || false,
    isFollowUp: appointment.isFollowUp || false,
    isUrgent: appointment.isUrgent || false,
    insuranceType: appointment.insuranceType || 'unknown',
    providerId: appointment.providerId,
    specialtyType: appointment.specialtyType || 'primary_care',
  };
}

// ─── Statistical Prediction Model ────────────────────────────
const BASE_RATE = 0.18;

const RISK_FACTORS = {
  isVeryLongLead: +0.14,
  isLongLeadTime: +0.08,
  isSameDay: -0.06,
  isMonday: +0.04,
  isFriday: +0.03,
  isEndOfDay: +0.05,
  isMorning: -0.03,
  isLunchTime: +0.02,
  isNewPatient: +0.06,
  isFollowUp: -0.04,
  isUrgent: -0.08,
  'insuranceType:medicaid': +0.09,
  'insuranceType:self_pay': +0.07,
  'insuranceType:commercial': -0.02,
  'insuranceType:medicare': -0.03,
};

function predictNoShow(appointment) {
  const features = extractFeatures(appointment);

  let probability = BASE_RATE;

  for (const [factor, delta] of Object.entries(RISK_FACTORS)) {
    if (factor.includes(':')) {
      const [key, val] = factor.split(':');
      if (features[key] === val) probability += delta;
    } else {
      if (features[factor]) probability += delta;
    }
  }

  const historicalRate = getProviderHistoricalRate(
    appointment.providerId,
    features.dayOfWeek,
    features.hourOfDay
  );

  if (historicalRate !== null) {
    probability = probability * 0.70 + historicalRate * 0.30;
  }

  probability = Math.max(0.02, Math.min(0.95, probability));
  probability = Math.round(probability * 100) / 100;

  const riskTier = getRiskTier(probability);
  const actions = getRecommendedActions(probability, riskTier, features);

  const prediction = {
    probability,
    riskTier,
    riskPct: Math.round(probability * 100),
    features,
    actions,
    predictedAt: new Date().toISOString(),
    modelVersion: '1.0.0-statistical',
  };

  log(ACTIONS.AGENT_SLOT_DETECTED, {
    actorType: 'agent',
    resourceId: appointment.providerId,
    details: {
      predictionType: 'no_show',
      riskTier,
      probability,
      slotStart: appointment.slotStart,
    },
  });

  return prediction;
}

// ─── Risk Tiers ───────────────────────────────────────────────
function getRiskTier(probability) {
  if (probability >= 0.60) return 'critical';
  if (probability >= 0.40) return 'high';
  if (probability >= 0.25) return 'medium';
  return 'low';
}

// ─── Recommended Actions ──────────────────────────────────────
function getRecommendedActions(probability, riskTier, features) {
  const actions = [];

  if (riskTier === 'critical') {
    actions.push({
      type: 'pre_market_slot',
      priority: 'high',
      message: 'Pre-market this slot to waitlisted patients now',
      autoAct: true,
    });
    actions.push({
      type: 'double_book_offer',
      priority: 'medium',
      message: 'Offer waitlist patient disclosed standby booking',
      autoAct: false,
    });
  }

  if (riskTier === 'high') {
    actions.push({
      type: 'pre_market_slot',
      priority: 'medium',
      message: 'Add to standby list — high no-show risk',
      autoAct: true,
    });
  }

  if (riskTier === 'medium') {
    actions.push({
      type: 'send_reminder',
      priority: 'low',
      message: 'Send appointment reminder 24h before',
      autoAct: true,
    });
  }

  if (features.isVeryLongLead) {
    actions.push({
      type: 'confirmation_request',
      priority: 'medium',
      message: 'Request confirmation — booked far in advance',
      autoAct: true,
    });
  }

  return actions;
}

// ─── Batch Scoring ────────────────────────────────────────────
function scoreSchedule(providerId, appointments) {
  if (!appointments || appointments.length === 0) {
    return { providerId, predictions: [], summary: buildSummary([]) };
  }

  const predictions = appointments.map((appt) =>
    predictNoShow({ ...appt, providerId })
  );

  const summary = buildSummary(predictions);

  for (const pred of predictions) {
    if (pred.riskTier === 'critical' || pred.riskTier === 'high') {
      slotEvents.emit('slot:high_risk', {
        providerId,
        slotStart: pred.features.leadTimeDays,
        prediction: pred,
      });
    }
  }

  return { providerId, predictions, summary };
}

function buildSummary(predictions) {
  const counts = { critical: 0, high: 0, medium: 0, low: 0 };
  let totalRisk = 0;

  for (const p of predictions) {
    counts[p.riskTier]++;
    totalRisk += p.probability;
  }

  const avgRisk = predictions.length > 0
    ? Math.round((totalRisk / predictions.length) * 100)
    : 0;

  const expectedNoShows = Math.round(
    predictions.reduce((sum, p) => sum + p.probability, 0)
  );

  return {
    total: predictions.length,
    byRiskTier: counts,
    avgRiskPct: avgRisk,
    expectedNoShows,
    highRiskCount: counts.critical + counts.high,
    slotsToPreMarket: counts.critical + counts.high,
  };
}

// ─── Provider Historical Rate ─────────────────────────────────
function recordOutcome(providerId, dayOfWeek, hourOfDay, wasNoShow) {
  const key = `${providerId}:${dayOfWeek}:${hourOfDay}`;

  if (!noShowHistory.has(key)) {
    noShowHistory.set(key, { shows: 0, noShows: 0 });
  }

  const stats = noShowHistory.get(key);
  if (wasNoShow) stats.noShows++;
  else stats.shows++;

  noShowHistory.set(key, stats);
}

function getProviderHistoricalRate(providerId, dayOfWeek, hourOfDay) {
  const key = `${providerId}:${dayOfWeek}:${hourOfDay}`;
  const stats = noShowHistory.get(key);
  if (!stats) return null;

  const total = stats.shows + stats.noShows;
  if (total < 5) return null;

  return stats.noShows / total;
}

// ─── Exports ─────────────────────────────────────────────────
export {
  predictNoShow,
  scoreSchedule,
  extractFeatures,
  getRiskTier,
  getRecommendedActions,
  recordOutcome,
  BASE_RATE,
  RISK_FACTORS,
};

export default {
  predictNoShow,
  scoreSchedule,
  extractFeatures,
  getRiskTier,
  getRecommendedActions,
  recordOutcome,
  BASE_RATE,
  RISK_FACTORS,
};
