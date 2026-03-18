/**
 * CareX — Real-Time Slot Change Detector
 * Engine 1, Module 1
 *
 * Listens for calendar webhook events from Google and Microsoft.
 * When a slot changes (cancellation, no-show, reschedule),
 * it fires a SlotEvent into the CareX pipeline.
 *
 * Flow:
 *   Calendar Webhook → Detector → Classifier → Veto Engine → Dispatch
 */

import crypto from 'node:crypto';
import { EventEmitter } from 'node:events';
import { logCalendarAccess, logError, ACTIONS, log } from '../hipaa/auditLogger.js';
import { getValidToken } from '../hipaa/calendarOAuth.js';
import { scrubAppointment } from '../hipaa/phiScrubber.js';

// ─── Event Emitter (lightweight pub/sub) ─────────────────────
const slotEvents = new EventEmitter();
slotEvents.setMaxListeners(50);

// ─── Webhook Registration ────────────────────────────────────
// Stores active webhook channels per provider
// Production: store in Supabase
const activeChannels = new Map(); // providerId → { channelId, resourceId, expiry, type }

/**
 * Register a Google Calendar push notification channel.
 * Google will POST to your webhook URL when calendar changes.
 *
 * Call this during provider onboarding and renew every 7 days.
 */
async function registerGoogleWebhook(providerId, webhookBaseUrl) {
  const accessToken = await getValidToken(providerId);

  const channelId = crypto.randomUUID();
  const webhookUrl = `${webhookBaseUrl}/webhooks/google/${providerId}`;

  const response = await fetch(
    'https://www.googleapis.com/calendar/v3/calendars/primary/events/watch',
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        id: channelId,
        type: 'web_hook',
        address: webhookUrl,
        // 7 day expiry (Google max is ~30 days)
        expiration: String(Date.now() + 7 * 24 * 60 * 60 * 1000),
      }),
    }
  );

  if (!response.ok) {
    const err = await response.text();
    throw new Error(`Google webhook registration failed: ${err}`);
  }

  const channel = await response.json();

  activeChannels.set(providerId, {
    channelId: channel.id,
    resourceId: channel.resourceId,
    expiry: channel.expiration,
    type: 'google',
    webhookUrl,
  });

  log(ACTIONS.PROVIDER_CONNECTED, {
    actorId: providerId,
    actorType: 'provider',
    details: { webhookType: 'google', channelId, webhookUrl },
  });

  return { channelId, expiry: channel.expiration };
}

/**
 * Register a Microsoft Graph subscription for calendar changes.
 * Microsoft will POST to your webhook URL when calendar changes.
 */
async function registerMicrosoftWebhook(providerId, webhookBaseUrl) {
  const accessToken = await getValidToken(providerId);

  const webhookUrl = `${webhookBaseUrl}/webhooks/microsoft/${providerId}`;

  // Microsoft subscriptions expire after max 3 days for calendar
  const expiryDate = new Date(Date.now() + 3 * 24 * 60 * 60 * 1000).toISOString();

  const response = await fetch(
    'https://graph.microsoft.com/v1.0/subscriptions',
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        changeType: 'created,updated,deleted',
        notificationUrl: webhookUrl,
        resource: 'me/events',
        expirationDateTime: expiryDate,
        clientState: crypto.randomBytes(16).toString('hex'), // validates incoming requests
      }),
    }
  );

  if (!response.ok) {
    const err = await response.text();
    throw new Error(`Microsoft webhook registration failed: ${err}`);
  }

  const subscription = await response.json();

  activeChannels.set(providerId, {
    channelId: subscription.id,
    resourceId: subscription.resource,
    expiry: subscription.expirationDateTime,
    type: 'microsoft',
    webhookUrl,
  });

  return { subscriptionId: subscription.id, expiry: subscription.expirationDateTime };
}

// ─── Webhook Handlers ────────────────────────────────────────

/**
 * Handle incoming Google Calendar webhook POST.
 * Google sends a header-only ping — we then fetch what changed.
 *
 * Express route: POST /webhooks/google/:providerId
 */
async function handleGoogleWebhook(req, res, providerId) {
  // Google sends change notification as headers only
  const channelId = req.headers['x-goog-channel-id'];
  const resourceState = req.headers['x-goog-resource-state'];

  // Respond immediately (Google requires fast ack)
  res.status(200).send('OK');

  // 'sync' is just the initial handshake — ignore it
  if (resourceState === 'sync') return;

  // Validate this is from our registered channel
  const channel = activeChannels.get(providerId);
  if (!channel || channel.channelId !== channelId) {
    logError({ action: 'WEBHOOK_INVALID_CHANNEL', error: new Error('Channel mismatch'), context: { providerId } });
    return;
  }

  try {
    // Fetch the actual changed events
    const changedEvents = await fetchRecentChanges(providerId, 'google');
    await processChangedEvents(providerId, changedEvents, 'google_webhook');
  } catch (err) {
    logError({ action: 'WEBHOOK_PROCESS_ERROR', error: err, context: { providerId } });
  }
}

/**
 * Handle incoming Microsoft Graph webhook POST.
 * Microsoft sends full event data in the body.
 *
 * Express route: POST /webhooks/microsoft/:providerId
 */
async function handleMicrosoftWebhook(req, res, providerId) {
  // Microsoft validation handshake
  if (req.query?.validationToken) {
    res.status(200).send(req.query.validationToken);
    return;
  }

  res.status(202).send('Accepted');

  const notifications = req.body?.value || [];

  for (const notification of notifications) {
    try {
      // Microsoft sends the changed resource ID
      const changedEvents = await fetchMicrosoftEvent(providerId, notification.resourceData?.id);
      await processChangedEvents(providerId, changedEvents, 'microsoft_webhook');
    } catch (err) {
      logError({ action: 'WEBHOOK_PROCESS_ERROR', error: err, context: { providerId } });
    }
  }
}

// ─── Fetch Changed Events ────────────────────────────────────

async function fetchRecentChanges(providerId, calendarType) {
  const accessToken = await getValidToken(providerId);

  // Look back 30 minutes to catch any changes
  const since = new Date(Date.now() - 30 * 60 * 1000).toISOString();

  if (calendarType === 'google') {
    const params = new URLSearchParams({
      updatedMin: since,
      singleEvents: 'true',
      orderBy: 'updated',
      showDeleted: 'true', // Critical — catch cancellations
    });

    const response = await fetch(
      `https://www.googleapis.com/calendar/v3/calendars/primary/events?${params.toString()}`,
      { headers: { Authorization: `Bearer ${accessToken}` } }
    );

    if (!response.ok) throw new Error(`Google API error: ${response.status}`);
    const data = await response.json();

    return (data.items || []).map(normalizeGoogleEvent);
  }

  return [];
}

async function fetchMicrosoftEvent(providerId, eventId) {
  if (!eventId) return [];
  const accessToken = await getValidToken(providerId);

  const response = await fetch(
    `https://graph.microsoft.com/v1.0/me/events/${eventId}`,
    { headers: { Authorization: `Bearer ${accessToken}` } }
  );

  if (!response.ok) return [];
  const event = await response.json();
  return [normalizeMicrosoftEvent(event)];
}

// ─── Normalize Events ────────────────────────────────────────

function normalizeGoogleEvent(event) {
  return {
    eventId: event.id,
    title: event.summary || '',
    start: event.start?.dateTime || event.start?.date,
    end: event.end?.dateTime || event.end?.date,
    status: event.status, // 'confirmed' | 'tentative' | 'cancelled'
    attendees: (event.attendees || []).map(a => a.email),
    notes: event.description || '',
    updated: event.updated,
    source: 'google',
    rawStatus: event.status,
  };
}

function normalizeMicrosoftEvent(event) {
  return {
    eventId: event.id,
    title: event.subject || '',
    start: event.start?.dateTime,
    end: event.end?.dateTime,
    status: event.isCancelled ? 'cancelled' : 'confirmed',
    attendees: (event.attendees || []).map(a => a.emailAddress?.address),
    notes: event.body?.content || '',
    updated: event.lastModifiedDateTime,
    source: 'microsoft',
    rawStatus: event.showAs,
  };
}

// ─── Process Changed Events ──────────────────────────────────

/**
 * Core processing pipeline for changed events.
 * Scrubs PHI, then emits SlotEvents for downstream processing.
 */
async function processChangedEvents(providerId, events, signalSource) {
  if (!events || events.length === 0) return;

  logCalendarAccess({
    providerId,
    calendarType: signalSource,
    slotCount: events.length,
    webhookEvent: true,
  });

  for (const event of events) {
    // 1. Scrub PHI before any processing
    const { scrubbedAppointment } = scrubAppointment({
      patientName: event.title,
      patientEmail: event.attendees?.[0] || '',
      notes: event.notes,
      eventId: event.eventId,
      start: event.start,
      end: event.end,
      status: event.status,
      source: event.source,
    });

    // 2. Build a SlotEvent (PHI-free)
    const slotEvent = {
      eventId: event.eventId,
      providerId,
      patientToken: scrubbedAppointment.patientToken,
      slotStart: event.start,
      slotEnd: event.end,
      status: event.status,
      source: signalSource,
      detectedAt: new Date().toISOString(),
      // Raw data for classifier (PHI already scrubbed)
      scrubbedTitle: scrubbedAppointment.patientName,
      scrubbedNotes: scrubbedAppointment.notes,
    };

    // 3. Emit for the classifier to process
    slotEvents.emit('slot:changed', slotEvent);
  }
}

// ─── Polling Fallback ────────────────────────────────────────
// For providers where webhooks aren't available yet

const pollIntervals = new Map(); // providerId → intervalId

/**
 * Start polling a provider's calendar every N seconds.
 * Fallback for providers without webhook access.
 */
function startPolling(providerId, intervalSeconds = 60) {
  if (pollIntervals.has(providerId)) return; // Already polling

  const lastSeenStates = new Map(); // eventId → status

  const intervalId = setInterval(async () => {
    try {
      const accessToken = await getValidToken(providerId);

      // Fetch next 24h of events
      const now = new Date().toISOString();
      const tomorrow = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();

      const params = new URLSearchParams({
        timeMin: now,
        timeMax: tomorrow,
        singleEvents: 'true',
        showDeleted: 'true',
      });

      const response = await fetch(
        `https://www.googleapis.com/calendar/v3/calendars/primary/events?${params.toString()}`,
        { headers: { Authorization: `Bearer ${accessToken}` } }
      );

      if (!response.ok) return;

      const data = await response.json();
      const events = (data.items || []).map(normalizeGoogleEvent);

      // Detect state changes since last poll
      const changedEvents = events.filter(event => {
        const lastStatus = lastSeenStates.get(event.eventId);
        const changed = lastStatus !== undefined && lastStatus !== event.status;
        lastSeenStates.set(event.eventId, event.status);
        return changed;
      });

      // First poll — just record states, don't fire events
      if (lastSeenStates.size > 0 && changedEvents.length > 0) {
        await processChangedEvents(providerId, changedEvents, 'polling');
      }

    } catch (err) {
      logError({ action: 'POLLING_ERROR', error: err, context: { providerId } });
    }
  }, intervalSeconds * 1000);

  pollIntervals.set(providerId, intervalId);

  log(ACTIONS.PROVIDER_CONNECTED, {
    actorId: providerId,
    actorType: 'provider',
    details: { monitorType: 'polling', intervalSeconds },
  });
}

function stopPolling(providerId) {
  if (pollIntervals.has(providerId)) {
    clearInterval(pollIntervals.get(providerId));
    pollIntervals.delete(providerId);
  }
}

// ─── Exports ─────────────────────────────────────────────────
export {
  slotEvents,           // Subscribe to slot change events
  registerGoogleWebhook,
  registerMicrosoftWebhook,
  handleGoogleWebhook,
  handleMicrosoftWebhook,
  startPolling,
  stopPolling,
  processChangedEvents, // For testing / native portal events
};

export default {
  slotEvents,
  registerGoogleWebhook,
  registerMicrosoftWebhook,
  handleGoogleWebhook,
  handleMicrosoftWebhook,
  startPolling,
  stopPolling,
  processChangedEvents,
};
