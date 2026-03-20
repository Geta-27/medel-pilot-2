/**
 * CareX — Express API Server
 *
 * Wires all three engines into HTTP routes.
 * Handles webhooks, provider onboarding, dashboard data,
 * and the patient-facing booking flow.
 *
 * Routes:
 *   POST /auth/google/callback          Provider Google OAuth callback
 *   POST /auth/microsoft/callback       Provider Microsoft OAuth callback
 *   GET  /auth/:providerId/status       Calendar connection status
 *   DELETE /auth/:providerId            Disconnect calendar
 *
 *   POST /webhooks/google/:providerId   Google Calendar push notification
 *   POST /webhooks/microsoft/:providerId Microsoft Graph subscription
 *   POST /webhooks/sms                  Twilio SMS webhook
 *   POST /webhooks/email/forwarded      Email forwarding agent
 *
 *   GET  /provider/:id/dashboard        Full dashboard data
 *   GET  /provider/:id/slots            Today's slots
 *   GET  /provider/:id/capacity         Capacity report
 *   GET  /provider/:id/notifications    Unread notifications
 *   GET  /provider/:id/audit            Audit trail
 *   PUT  /provider/:id/rules            Update standing rules
 *   PUT  /provider/:id/capacity-config  Update capacity config
 *   POST /provider/:id/veto/:slotId     Veto an auto-assignment
 *   POST /provider/:id/assign/:slotId   Manual slot assignment
 *   POST /provider/:id/online-status    Check auto-online status
 *
 *   GET  /marketplace/slots             Available slots for patients
 *   POST /marketplace/book              Patient books a slot
 *   POST /marketplace/waitlist          Patient joins waitlist
 */

require('dotenv').config();
const express    = require('express');
const app        = express();

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// ─── Engine Imports ───────────────────────────────────────────
const { getAuthorizationUrl, handleCallback,
        disconnectProvider, getConnectionStatus, fetchTodaySchedule } = require('./hipaa/calendarOAuth');
const { registerGoogleWebhook, registerMicrosoftWebhook,
        handleGoogleWebhook, handleMicrosoftWebhook,
        startPolling }                            = require('./engine1/slotDetector');
const { providerVeto, providerManualAssign,
        setProviderPreferences,
        getProviderPreferences,
        getPendingVetos }                         = require('./engine1/vetoEngine');
const { registerProvider, getAgentStatus,
        computeOnlineStatus, SIGNAL_SOURCES }     = require('./engine2/agentCore');
const { handleIncomingSMS }                       = require('./engine2/smsAgent');
const { processForwardedEmail }                   = require('./engine2/emailAgent');
const { setCapacityConfig, analyzeCapacity,
        detectPatternGaps, getCapacityHistory }   = require('./engine3/capacityDetector');
const { setStandingRules, getStandingRules,
        runCapacityPipeline }                     = require('./engine3/standingRules');
const { scoreSchedule }                           = require('./engine3/noShowPredictor');
const db                                          = require('./database/db');

// ─── Auth Middleware ──────────────────────────────────────────
// Simple API key check — replace with Supabase JWT in production
function requireAuth(req, res, next) {
  if (
    req.path === '/health' ||
    req.path === '/auth/google/callback' ||
    /^\/auth\/[^/]+\/connect\/google$/.test(req.path)
  ) {
    return next();
  }

  const key = req.headers['x-api-key'] || req.query.apiKey;
  if (!key || key !== process.env.API_KEY) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  next();
}

// ─── OAUTH ROUTES ─────────────────────────────────────────────

// Step 1: Get authorization URL (redirect provider here)
app.get('/auth/:providerId/connect/:calendarType', (req, res, next) => {
  if (req.params.calendarType === 'google') return next();
  return requireAuth(req, res, next);
}, (req, res) => {
  try {
    const { providerId, calendarType } = req.params;
    const { url, state } = getAuthorizationUrl(providerId, calendarType);

    if (calendarType === 'google') {
      return res.redirect(url);
    }

    return res.json({ url, state });
  } catch (err) {
    return res.status(400).json({ error: err.message });
  }
});

// Step 2: OAuth callback — Google redirects here after consent
app.get('/auth/:providerId/connect/google', async (req, res) => {
  try {
    const { providerId } = req.params;

    if (!providerId) {
      return res.status(400).json({ error: 'providerId is required' });
    }

    const { url, state } = getAuthorizationUrl(providerId, 'google');

    return res.redirect(url);
  } catch (error) {
    console.error('Google OAuth start failed:', error);
    return res.status(500).json({
      error: 'Google OAuth start failed',
      details: error.message,
    });
  }
});

app.get('/auth/google/callback', async (req, res) => {
  try {
    const { code, state } = req.query;
    const result = await handleCallback(code, state, 'google');

    // Register provider with agent
    registerProvider(result.providerId, {
      enabledSources: [SIGNAL_SOURCES.CALENDAR_GOOGLE],
      watchMode:      'active',
    });

    // Start watching calendar
    if (process.env.WEBHOOK_BASE_URL) {
      await registerGoogleWebhook(result.providerId, process.env.WEBHOOK_BASE_URL);
    } else {
      startPolling(result.providerId, 60);
    }

    res.json({ success: true, message: 'Calendar connected successfully', ...result });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// Step 2: OAuth callback — Microsoft redirects here
app.get('/auth/microsoft/callback', async (req, res) => {
  try {
    const { code, state } = req.query;
    const result = await handleCallback(code, state, 'microsoft');

    registerProvider(result.providerId, {
      enabledSources: [SIGNAL_SOURCES.CALENDAR_MICROSOFT],
      watchMode:      'active',
    });

    if (process.env.WEBHOOK_BASE_URL) {
      await registerMicrosoftWebhook(result.providerId, process.env.WEBHOOK_BASE_URL);
    } else {
      startPolling(result.providerId, 60);
    }

    res.json({ success: true, message: 'Calendar connected successfully', ...result });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.get('/auth/:providerId/status', requireAuth, (req, res) => {
  const status = getConnectionStatus(req.params.providerId);
  const agent  = getAgentStatus(req.params.providerId);
  res.json({ calendar: status, agent });
});

app.delete('/auth/:providerId', requireAuth, (req, res) => {
  const result = disconnectProvider(req.params.providerId, 'provider_requested');
  res.json(result);
});

// ─── WEBHOOK ROUTES ───────────────────────────────────────────

// Google Calendar push notification
app.post('/webhooks/google/:providerId', async (req, res) => {
  await handleGoogleWebhook(req, res, req.params.providerId);
});

// Microsoft Graph subscription notification
app.post('/webhooks/microsoft/:providerId', async (req, res) => {
  await handleMicrosoftWebhook(req, res, req.params.providerId);
});

// Twilio SMS webhook
app.post('/webhooks/sms', async (req, res) => {
  await handleIncomingSMS(req, res);
});

// Email forwarding agent
app.post('/webhooks/email/forwarded', requireAuth, async (req, res) => {
  try {
    const result = await processForwardedEmail(req.body);
    res.json({ success: true, result });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// ─── PROVIDER ROUTES ──────────────────────────────────────────

// Full dashboard data in one call
app.get('/provider/:id/dashboard', requireAuth, async (req, res) => {
  try {
    const providerId = req.params.id;

    const [provider, slots, notifications, auditLog, rules] = await Promise.all([
      db.getProvider(providerId),
      db.getProviderSlotsToday(providerId),
      db.getUnreadNotifications(providerId),
      db.queryProviderAuditLog(providerId, 20),
      db.getStandingRules(providerId),
    ]);

    const calendar = {
      connected: !!provider?.calendar_token_enc,
      type: provider?.calendar_type || null,
      connectedAt: provider?.calendar_connected_at || null,
      scopes: provider?.calendar_scopes || [],
    };


    // Merge Google Calendar events into slots
    let _calSlots = [];
    try {
      const { fetchTodaySchedule, getConnectionStatus } = require('./hipaa/calendarOAuth');
      if (getConnectionStatus(providerId).connected) {
        const _evts = await fetchTodaySchedule(providerId);
        const _existing = new Set(slots.map(s => s.external_event_id).filter(Boolean));
        _calSlots = _evts
          .filter(e => e.status !== 'cancelled' && !_existing.has(e.eventId))
          .map(e => ({
            id: e.eventId, external_event_id: e.eventId,
            slot_start: e.start, slot_end: e.end,
            status: 'booked', source: 'google_calendar',
            provider_id: providerId, title: e.title,
          }));
      }
    } catch(_e) {}
    const _allSlots = [...slots, ..._calSlots];

    // Run capacity analysis
    const bookedSlots = _allSlots.filter(s => s.status === 'booked');

    let capacityInput = bookedSlots.map(s => ({
      start: s.slot_start,
      end: s.slot_end,
      booked_at: s.booked_at || null,
    }));

    if (provider?.calendar_token_enc) {
      try {
        const calendarEvents = await fetchTodaySchedule(providerId);
        if (Array.isArray(calendarEvents) && calendarEvents.length > 0) {
          capacityInput = calendarEvents.map(e => ({
            start: e.start || e.startTime || e.slot_start,
            end: e.end || e.endTime || e.slot_end,
            booked_at: e.created || e.createdAt || null,
          })).filter(e => !!e.start);
        }
      } catch (err) {
        console.error('Calendar capacity fallback to DB slots:', err.message);
      }
    }

    const capacity = analyzeCapacity(providerId, capacityInput);

    // Compute online status
    const openSlots = _allSlots.filter(s => s.status === 'available');
    const onlineStatus = computeOnlineStatus(providerId, {
      openSlots:       openSlots,
      workingHours:    { start: 8, end: 18 },
      manualOverride:  null,
    });

    // Pending veto windows
    const pendingVetos = getPendingVetos(providerId);

    // No-show risk scores for today's bookings
    const riskReport = scoreSchedule(providerId, capacityInput.map(s => ({
      slotStart:    s.slot_start || s.start,
      bookedAt:     s.booked_at || null,
      isNewPatient: true,
      insuranceType: 'commercial',
    })));

    res.json({
      providerId,
      generatedAt:   new Date().toISOString(),
      onlineStatus,
      capacity,
      slots: {
        total:      _allSlots.length,
        booked:     bookedSlots.length,
        available:  openSlots.length,
        marketplace: _allSlots.filter(s => s.status === 'marketplace').length,
        all:        _allSlots,
      },
      pendingVetos,
      riskReport:    riskReport.summary,
      notifications,
      recentAudit:   auditLog,
      rules,
      calendar,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Today's slots
app.get('/provider/:id/slots', requireAuth, async (req, res) => {
  try {
    const slots = await db.getProviderSlotsToday(req.params.id);
    res.json({ slots });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Capacity analysis + history
app.get('/provider/:id/capacity', requireAuth, async (req, res) => {
  try {
    const providerId = req.params.id;
    const slots      = await db.getProviderSlotsToday(providerId);
    const booked     = slots.filter(s => s.status === 'booked');
    const report     = analyzeCapacity(providerId, booked);
    const history    = await db.getCapacityHistory(providerId, 30);
    const patterns   = await detectPatternGaps(providerId);

    res.json({ report, history, patterns });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Notifications
app.get('/provider/:id/notifications', requireAuth, async (req, res) => {
  try {
    const notifications = await db.getUnreadNotifications(req.params.id);
    res.json({ notifications });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/provider/:id/notifications/:notifId/read', requireAuth, async (req, res) => {
  try {
    await db.markNotificationRead(req.params.notifId);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Audit trail
app.get('/provider/:id/audit', requireAuth, async (req, res) => {
  try {
    const logs = await db.queryProviderAuditLog(req.params.id, 50);
    res.json({ logs });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Update standing rules
app.put('/provider/:id/rules', requireAuth, async (req, res) => {
  try {
    const providerId = req.params.id;
    const updated    = setStandingRules(providerId, req.body);
    await db.upsertStandingRules(providerId, req.body);
    res.json({ success: true, rules: updated });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// Update capacity config
app.put('/provider/:id/capacity-config', requireAuth, async (req, res) => {
  try {
    const providerId = req.params.id;
    const config     = setCapacityConfig(providerId, req.body);
    await db.upsertProvider(providerId, {
      daily_patient_max:   config.dailyPatientMax,
      slot_duration_mins:  config.slotDurationMins,
      buffer_mins:         config.bufferMins,
      working_hours_start: config.workingHours.start,
      working_hours_end:   config.workingHours.end,
      working_days:        config.workingDays,
    });
    res.json({ success: true, config });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// Veto an auto-assignment
app.post('/provider/:id/veto/:slotId', requireAuth, async (req, res) => {
  try {
    const result = await providerVeto(
      req.params.slotId,
      req.params.id,
      req.body.reason || ''
    );
    if (result.success) {
      await db.updateSlot(req.params.slotId, { status: 'available', patient_token: null, vetoed_at: new Date().toISOString() });
    }
    res.json(result);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// Manual assignment
app.post('/provider/:id/assign/:slotId', requireAuth, async (req, res) => {
  try {
    const { patientToken } = req.body;
    if (!patientToken) return res.status(400).json({ error: 'patientToken required' });

    const result = await providerManualAssign(req.params.slotId, req.params.id, patientToken);
    if (result.success) {
      await db.updateSlot(req.params.slotId, {
        status:       'booked',
        patient_token: patientToken,
        assigned_at:  new Date().toISOString(),
        auto_assigned: false,
      });
    }
    res.json(result);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// Run full capacity pipeline manually
app.post('/provider/:id/run-capacity', requireAuth, async (req, res) => {
  try {
    const slots    = await db.getProviderSlotsToday(req.params.id);
    const booked   = slots.filter(s => s.status === 'booked');
    const { report, rulesDecision } = await runCapacityPipeline(req.params.id, booked);
    await db.upsertCapacityReport({ provider_id: req.params.id, report_date: report.date, ...flattenReport(report) });
    res.json({ report, rulesDecision });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── MARKETPLACE ROUTES ───────────────────────────────────────

// Get available slots (patient-facing)
app.get('/marketplace/slots', async (req, res) => {
  try {
    const { specialty, insurance, zip, limit = 20 } = req.query;
    const slots = await db.getMarketplaceSlots({ specialtyType: specialty, limit: parseInt(limit) });
    res.json({ slots, count: slots.length });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Patient books a slot
app.post('/marketplace/book', async (req, res) => {
  try {
    const { slotId, patientToken, insuranceType } = req.body;
    if (!slotId || !patientToken) {
      return res.status(400).json({ error: 'slotId and patientToken required' });
    }

    const slot = await db.getSlot(slotId);
    if (!slot || slot.status !== 'marketplace') {
      return res.status(409).json({ error: 'Slot no longer available' });
    }

    // Soft-reserve (5 min TTL)
    await db.updateSlot(slotId, { status: 'reserved', patient_token: patientToken });

    // Create booking record
    const booking = await db.createBooking({
      slot_id:        slotId,
      provider_id:    slot.provider_id,
      patient_token:  patientToken,
      status:         'confirmed',
      booking_source: 'patient_self',
      auto_assigned:  false,
      confirmed_at:   new Date().toISOString(),
      insurance_type: insuranceType,
    });

    // Mark slot as booked
    await db.updateSlot(slotId, {
      status:      'booked',
      booked_at:   new Date().toISOString(),
    });

    res.json({ success: true, booking });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Patient joins waitlist
app.post('/marketplace/waitlist', async (req, res) => {
  try {
    const entry = await db.addToWaitlist({
      patient_token:    req.body.patientToken,
      specialty_needed: req.body.specialtyNeeded,
      insurance_type:   req.body.insuranceType,
      zip_code:         req.body.zipCode,
      urgency_score:    req.body.urgencyScore || 0.50,
      max_distance_miles: req.body.maxDistanceMiles || 25,
      is_new_patient:   req.body.isNewPatient ?? true,
    });
    res.json({ success: true, entry });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── HEALTH CHECK ─────────────────────────────────────────────
app.use(require('express').static('src/dashboard'));
app.get('/', (req, res) => res.redirect('/patient.html'));
app.get('/health', (req, res) => {
  res.json({
    status:  'ok',
    version: '1.0.0',
    engines: ['slot_intelligence', 'ai_schedule_agent', 'capacity_intelligence'],
    time:    new Date().toISOString(),
  });
});

// ─── HELPERS ─────────────────────────────────────────────────
function flattenReport(report) {
  return {
    declared_daily_max: report.declaredDailyMax,
    total_slots:        report.totalSlots,
    booked_count:       report.bookedCount,
    unused_count:       report.unusedCount,
    future_gap_count:   report.futureGapCount,
    utilization_pct:    report.utilizationPct,
    gap_pct:            report.gapPct,
    gap_type:           report.gapType,
    revenue_per_slot:   report.revenueOpportunity?.perSlot,
    revenue_total:      report.revenueOpportunity?.total,
    revenue_monthly:    report.revenueOpportunity?.monthly,
  };
}

// ─── START ────────────────────────────────────────────────────
const { startAutoPoller } = require('./autoPoller');
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`\n🚀 CareX API running on port ${PORT}`);
  console.log(`   Health check: http://localhost:${PORT}/health`);
  console.log(`   Environment:  ${process.env.NODE_ENV || 'development'}\n`);
  startAutoPoller();
});

module.exports = app;
