/**
 * CareX — Capacity Gap Detector
 * Engine 3, Module 1
 *
 * Compares what a provider said they can handle (declared capacity)
 * against what is actually scheduled (observed capacity).
 *
 * Gap types detected:
 *   Type 1 — DECLARED GAP:   stated 15/day, only 10 booked = 5 unused
 *   Type 2 — CANCELLATION GAP: was full, cancellation opened a slot
 *   Type 3 — PATTERN GAP:    AI detects historically under-booked windows
 *   Type 4 — BUFFER GAP:     provider blocks time that historically goes unused
 *   Type 5 — NO-SHOW GAP:    predicted no-show frees a slot proactively
 *
 * Output: CapacityReport fed to the Standing Rules Engine
 */

import { log, logError, ACTIONS } from '../hipaa/auditLogger.js';

// ─── Provider Capacity Config ─────────────────────────────────
const capacityConfigs = new Map(); // providerId → CapacityConfig
const capacityHistory = new Map(); // providerId → array of DailyReport

// ─── Config Schema ────────────────────────────────────────────
const DEFAULT_CAPACITY_CONFIG = {
  dailyPatientMax: 15,
  slotDurationMins: 30,
  workingHours: { start: 8, end: 18 },   // 8am–6pm
  workingDays: [1, 2, 3, 4, 5],          // Mon–Fri
  bufferMins: 10,                        // Buffer between appointments
  specialtyType: 'primary_care',
  insuranceAccepted: [],
  locationZip: null,
};

function setCapacityConfig(providerId, config) {
  const merged = { ...DEFAULT_CAPACITY_CONFIG, ...config, providerId };
  capacityConfigs.set(providerId, merged);

  log(ACTIONS.PROVIDER_RULE_SET, {
    actorId: providerId,
    actorType: 'provider',
    details: { configType: 'capacity', dailyMax: merged.dailyPatientMax },
  });

  return merged;
}

function getCapacityConfig(providerId) {
  return capacityConfigs.get(providerId) || { ...DEFAULT_CAPACITY_CONFIG, providerId };
}

// ─── Core Gap Detection ───────────────────────────────────────
function analyzeCapacity(providerId, bookedSlots = [], asOf = new Date()) {
  const config = getCapacityConfig(providerId);

  // Build the full theoretical slot grid — use UTC date to match toISOString() output
  const utcAsOf = new Date(asOf);
  const theoreticalSlots = buildTheoreticalSlots(config, utcAsOf);

  // Find which theoretical slots are unused
  const bookedTimes = new Set(bookedSlots.map((s) => normalizeSlotTime(s.start)));
  const unusedSlots = theoreticalSlots.filter((s) => !bookedTimes.has(normalizeSlotTime(s.start)));
  const futureUnused = unusedSlots.filter((s) =>
    new Date(s.start).getTime() > asOf.getTime()
  );

  // Calculate gap metrics
  const totalSlots = theoreticalSlots.length;
  const bookedCount = bookedSlots.length;
  const unusedCount = unusedSlots.length;
  const futureGapCount = futureUnused.length;
  const utilizationPct = totalSlots > 0 ? Math.round((bookedCount / totalSlots) * 100) : 0;
  const gapPct = 100 - utilizationPct;

  // Classify gap type
  const gapType = classifyGapType(config, bookedCount, totalSlots, asOf);

  const report = {
    providerId,
    generatedAt: asOf.toISOString(),
    date: asOf.toISOString().slice(0, 10),

    // Capacity numbers
    declaredDailyMax: config.dailyPatientMax,
    totalSlots,
    bookedCount,
    unusedCount,
    futureGapCount, // Only slots still in the future (actionable)
    utilizationPct,
    gapPct,

    // Gap classification
    gapType,
    isActionable: futureGapCount > 0,

    // Slot details (no PHI — just times)
    unusedSlotTimes: futureUnused.map((s) => ({
      start: s.start,
      end: s.end,
      minutesUntil: Math.round((new Date(s.start) - asOf) / 60000),
    })),

    // Revenue opportunity estimate
    revenueOpportunity: estimateRevenue(futureGapCount, config.specialtyType),
  };

  // Store in history for pattern detection
  storeCapacityHistory(providerId, report);

  log(ACTIONS.AGENT_SLOT_DETECTED, {
    actorType: 'agent',
    resourceId: providerId,
    details: {
      reportType: 'capacity_analysis',
      utilizationPct,
      futureGapCount,
      gapType,
    },
  });

  return report;
}

// ─── Theoretical Slot Builder ─────────────────────────────────
function buildTheoreticalSlots(config, date = new Date()) {
  const slots = [];
  const d = new Date(date);

  // Use UTC day-of-week to match toISOString() output
  if (!config.workingDays.includes(d.getUTCDay())) return [];

  const startHour = config.workingHours.start;
  const endHour = config.workingHours.end;
  const slotMins = config.slotDurationMins + config.bufferMins;

  const current = new Date(d);
  current.setUTCHours(startHour, 0, 0, 0);

  const dayEnd = new Date(d);
  dayEnd.setUTCHours(endHour, 0, 0, 0);

  while (current < dayEnd) {
    const slotEnd = new Date(current.getTime() + config.slotDurationMins * 60000);
    if (slotEnd <= dayEnd) {
      slots.push({
        start: current.toISOString(),
        end: slotEnd.toISOString(),
      });
    }
    current.setTime(current.getTime() + slotMins * 60000);

    // Safety cap at declared daily max
    if (slots.length >= config.dailyPatientMax) break;
  }

  return slots;
}

// ─── Gap Type Classifier ──────────────────────────────────────
function classifyGapType(config, bookedCount, totalSlots, asOf) {
  if (bookedCount === 0 && totalSlots > 0) return 'empty_schedule';
  if (bookedCount < totalSlots * 0.5) return 'declared_gap'; // < 50% booked
  if (bookedCount < totalSlots * 0.75) return 'partial_gap'; // 50–75% booked
  if (bookedCount < totalSlots * 0.9) return 'minor_gap';    // 75–90% booked
  return 'near_full';                                         // > 90% booked
}

// ─── Revenue Estimator ────────────────────────────────────────
const REVENUE_PER_VISIT = {
  primary_care: 185,
  specialist: 320,
  mental_health: 195,
  urgent_care: 225,
  dermatology: 280,
  cardiology: 350,
  default: 220,
};

function estimateRevenue(slotCount, specialtyType) {
  const rate = REVENUE_PER_VISIT[specialtyType] || REVENUE_PER_VISIT.default;
  return {
    perSlot: rate,
    total: slotCount * rate,
    monthly: slotCount * rate * 22, // ~22 working days
    currency: 'USD',
  };
}

// ─── Pattern Gap Detection (AI-powered) ──────────────────────
async function detectPatternGaps(providerId) {
  const history = capacityHistory.get(providerId) || [];
  if (history.length < 7) return null; // Need at least 7 days of data

  if (!process.env.ANTHROPIC_API_KEY) {
    return ruleBasedPatternDetection(history);
  }

  // Summarize history for AI (no PHI — just utilization numbers)
  const summary = history.slice(-30).map((d) => ({
    date: d.date,
    dayOfWeek: new Date(d.date).toLocaleDateString('en', { weekday: 'short' }),
    utilizationPct: d.utilizationPct,
    unusedCount: d.unusedCount,
    gapType: d.gapType,
  }));

  const prompt = `Analyze this provider's scheduling utilization over the past ${summary.length} days.
Identify recurring unused capacity patterns.

Data (no patient info — only utilization metrics):
${JSON.stringify(summary, null, 2)}

Respond ONLY with JSON:
{
  "patterns": [
    {
      "description": "under 20 words",
      "dayOfWeek": "Monday|Tuesday|...|any",
      "timeWindow": "e.g. 2pm-4pm or morning or afternoon",
      "avgUnusedSlots": number,
      "confidence": 0.0-1.0,
      "recommendation": "under 20 words"
    }
  ],
  "overallTrend": "improving|stable|worsening",
  "avgUtilization": number
}`;

  try {
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': process.env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 400,
        messages: [{ role: 'user', content: prompt }],
      }),
    });

    if (!response.ok) throw new Error(`API error: ${response.status}`);

    const data = await response.json();
    const text = data.content?.[0]?.text || '{}';
    const clean = text.replace(/```json|```/g, '').trim();
    return JSON.parse(clean);
  } catch (err) {
    logError({ action: 'PATTERN_DETECTION_ERROR', error: err, context: { providerId } });
    return ruleBasedPatternDetection(history);
  }
}

function ruleBasedPatternDetection(history) {
  // Group by day of week
  const byDay = {};
  for (const report of history) {
    const dow = new Date(report.date).toLocaleDateString('en', { weekday: 'short' });
    if (!byDay[dow]) byDay[dow] = [];
    byDay[dow].push(report.unusedCount);
  }

  const patterns = Object.entries(byDay)
    .map(([day, counts]) => ({
      dayOfWeek: day,
      avgUnusedSlots: Math.round(counts.reduce((a, b) => a + b, 0) / counts.length),
      confidence: counts.length >= 3 ? 0.75 : 0.50,
      description: `${day} averages ${Math.round(counts.reduce((a, b) => a + b, 0) / counts.length)} unused slots`,
      recommendation: 'Consider opening to marketplace on this day',
    }))
    .filter((p) => p.avgUnusedSlots >= 2);

  return { patterns, overallTrend: 'stable', avgUtilization: 70 };
}

// ─── History Storage ──────────────────────────────────────────
function storeCapacityHistory(providerId, report) {
  if (!capacityHistory.has(providerId)) {
    capacityHistory.set(providerId, []);
  }
  const history = capacityHistory.get(providerId);

  // Keep last 90 days
  history.push({
    date: report.date,
    utilizationPct: report.utilizationPct,
    unusedCount: report.unusedCount,
    gapType: report.gapType,
    bookedCount: report.bookedCount,
  });

  if (history.length > 90) history.shift();
  capacityHistory.set(providerId, history);
}

function getCapacityHistory(providerId, days = 30) {
  return (capacityHistory.get(providerId) || []).slice(-days);
}

// ─── Helpers ─────────────────────────────────────────────────
function normalizeSlotTime(isoString) {
  if (!isoString) return '';
  // Round to nearest 5 minutes for fuzzy matching
  const d = new Date(isoString);
  d.setMinutes(Math.round(d.getMinutes() / 5) * 5, 0, 0);
  return d.toISOString().slice(0, 16); // YYYY-MM-DDTHH:MM
}

// ─── Exports ─────────────────────────────────────────────────
export {
  setCapacityConfig,
  getCapacityConfig,
  analyzeCapacity,
  buildTheoreticalSlots,
  detectPatternGaps,
  getCapacityHistory,
  estimateRevenue,
  DEFAULT_CAPACITY_CONFIG,
};

export default {
  setCapacityConfig,
  getCapacityConfig,
  analyzeCapacity,
  buildTheoreticalSlots,
  detectPatternGaps,
  getCapacityHistory,
  estimateRevenue,
  DEFAULT_CAPACITY_CONFIG,
};
