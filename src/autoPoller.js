/**
 * CareX — Auto Poller
 *
 * Runs as a background loop inside the server.
 * Every 60 seconds it checks every connected provider's
 * Google Calendar for cancellations, no-shows, and new openings.
 *
 * When a change is detected it fires straight into the
 * Slot Intelligence Engine (Engine 1) pipeline:
 *   detect → classify → veto window → auto-assign
 *
 * No webhooks needed — works with the OAuth tokens already stored.
 */

const { fetchTodaySchedule, getConnectionStatus } = require('./hipaa/calendarOAuth');
const { processChangedEvents }                    = require('./engine1/slotDetector');
const { runCapacityPipeline }                     = require('./engine3/standingRules');
const db                                          = require('./database/db');

// ─── State ───────────────────────────────────────────────────
// Tracks last known event status per provider
// { providerId → { eventId → status } }
const lastKnownStates = new Map();

// ─── Poll One Provider ────────────────────────────────────────

async function pollProvider(providerId) {
  try {
    // Check calendar is still connected
    const status = getConnectionStatus(providerId);
    if (!status.connected) return;

    // Fetch today's events
    const events = await fetchTodaySchedule(providerId);

    const lastStates = lastKnownStates.get(providerId) || new Map();
    const changedEvents = [];

    for (const event of events) {
      const lastStatus = lastStates.get(event.eventId);

      // First poll — just record, don't fire events
      if (lastStatus === undefined) {
        lastStates.set(event.eventId, event.status);
        continue;
      }

      // Status changed since last poll
      if (lastStatus !== event.status) {
        console.log(`[POLLER] ${providerId.slice(0,8)}... event "${event.title?.slice(0,30)}" ${lastStatus} → ${event.status}`);
        changedEvents.push(event);
        lastStates.set(event.eventId, event.status);
      }
    }

    // Also check for newly cancelled events (showDeleted)
    const deletedEvents = await fetchDeletedEvents(providerId);
    for (const event of deletedEvents) {
      const lastStatus = lastStates.get(event.eventId);
      if (lastStatus && lastStatus !== 'cancelled') {
        console.log(`[POLLER] ${providerId.slice(0,8)}... CANCELLED: "${event.title?.slice(0,30)}"`);
        changedEvents.push({ ...event, status: 'cancelled' });
        lastStates.set(event.eventId, 'cancelled');
      } else if (!lastStatus) {
        lastStates.set(event.eventId, event.status);
      }
    }

    lastKnownStates.set(providerId, lastStates);

    // Fire changed events into Engine 1
    if (changedEvents.length > 0) {
      await processChangedEvents(providerId, changedEvents, 'polling');
      console.log(`[POLLER] ${changedEvents.length} change(s) fired into slot intelligence engine`);
    }

    // Run capacity pipeline (detects unused slots)
    const bookedSlots = await db.getProviderSlotsToday(providerId);
    await runCapacityPipeline(providerId, bookedSlots);

  } catch (err) {
    // Never let poller crash the server
    if (!err.message?.includes('not connected')) {
      console.error(`[POLLER] Error for ${providerId.slice(0,8)}:`, err.message);
    }
  }
}

// ─── Fetch Deleted/Cancelled Events ──────────────────────────

async function fetchDeletedEvents(providerId) {
  try {
    const { getValidToken } = require('./hipaa/calendarOAuth');
    const token = await getValidToken(providerId);

    const now   = new Date();
    const start = new Date(now); start.setUTCHours(0,0,0,0);
    const end   = new Date(now); end.setUTCHours(23,59,59,999);

    const params = new URLSearchParams({
      timeMin:      start.toISOString(),
      timeMax:      end.toISOString(),
      singleEvents: 'true',
      showDeleted:  'true',
      orderBy:      'startTime',
    });

    const res = await fetch(
      `https://www.googleapis.com/calendar/v3/calendars/primary/events?${params}`,
      { headers: { Authorization: `Bearer ${token}` } }
    );

    if (!res.ok) return [];
    const data = await res.json();

    return (data.items || [])
      .filter(e => e.status === 'cancelled')
      .map(e => ({
        eventId:   e.id,
        title:     e.summary || '',
        start:     e.start?.dateTime || e.start?.date,
        end:       e.end?.dateTime   || e.end?.date,
        status:    'cancelled',
        attendees: (e.attendees || []).map(a => a.email),
        notes:     e.description || '',
        source:    'google',
      }));
  } catch {
    return [];
  }
}

// ─── Poll All Connected Providers ────────────────────────────

async function pollAllProviders() {
  try {
    // Get all providers with connected calendars from Supabase
    const { data: providers } = await db.supabase
      .from('providers')
      .select('id, name, calendar_type, agent_status')
      .not('calendar_type', 'is', null)
      .eq('agent_status', 'running');

    if (!providers || providers.length === 0) return;

    console.log(`[POLLER] Checking ${providers.length} provider(s)...`);

    await Promise.allSettled(
      providers.map(p => pollProvider(p.id))
    );
  } catch (err) {
    console.error('[POLLER] Failed to fetch providers:', err.message);
  }
}

// ─── Start Auto-Poller ────────────────────────────────────────

const POLL_INTERVAL_MS = 60 * 1000; // 60 seconds


// PERMANENT_FIX: Pre-load all tokens from Supabase on startup
async function preloadTokens() {
  try {
    const db = require('./database/db');
    const { data: providers } = await db.supabase
      .from('providers')
      .select('id, calendar_token_enc, calendar_type')
      .not('calendar_token_enc', 'is', null);

    if (!providers?.length) {
      console.log('[POLLER] No stored tokens found in Supabase');
      return;
    }

    const { tokenStore } = require('./hipaa/calendarOAuth');
    // tokenStore is a private Map — use getValidToken to trigger auto-load instead
    for (const p of providers) {
      try {
        const { getValidToken } = require('./hipaa/calendarOAuth');
        await getValidToken(p.id); // This triggers auto-load from Supabase
        console.log('[POLLER] ✅ Token pre-loaded for provider', p.id.slice(0,8));
      } catch(e) {
        // Expected first time — getValidToken will load from Supabase
        if (!e.message.includes('has not connected')) {
          console.error('[POLLER] Pre-load error:', e.message);
        }
      }
    }
  } catch(e) {
    console.error('[POLLER] Token pre-load failed:', e.message);
  }
}

function startAutoPoller() {
  console.log(`\n⏱  Auto-poller started — checking calendars every ${POLL_INTERVAL_MS / 1000}s\n`);

  // First poll after 5 seconds (let server fully start)
  setTimeout(pollAllProviders, 5000);

  // Then every 60 seconds
  setInterval(pollAllProviders, POLL_INTERVAL_MS);
}

module.exports = { startAutoPoller, pollProvider, pollAllProviders };
