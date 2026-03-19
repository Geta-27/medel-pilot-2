/**
 * CareX — Supabase Database Client
 *
 * Replaces all in-memory Maps from the three engines
 * with real persistent Supabase storage.
 *
 * Setup:
 *   1. Create project at supabase.com
 *   2. Run database/schema.sql in SQL Editor
 *   3. Add env vars to .env
 *   4. npm install @supabase/supabase-js
 */

const { createClient } = require('@supabase/supabase-js');

// ─── Client ──────────────────────────────────────────────────
if (!process.env.SUPABASE_URL) {
  console.error('FATAL: SUPABASE_URL environment variable is not set');
  process.exit(1);
}
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

// ─── PROVIDERS ───────────────────────────────────────────────

async function getProvider(providerId) {
  const { data, error } = await supabase
    .from('providers')
    .select('*')
    .eq('id', providerId)
    .single();

  if (error) throw new Error(`getProvider failed: ${error.message}`);
  return data;
}

async function upsertProvider(providerId, fields) {
  const { data, error } = await supabase
    .from('providers')
    .upsert({ id: providerId, ...fields }, { onConflict: 'id' })
    .select()
    .single();

  if (error) throw new Error(`upsertProvider failed: ${error.message}`);
  return data;
}

async function updateProviderAgentStatus(providerId, status, fields = {}) {
  const { error } = await supabase
    .from('providers')
    .update({ agent_status: status, updated_at: new Date().toISOString(), ...fields })
    .eq('id', providerId);

  if (error) throw new Error(`updateProviderAgentStatus failed: ${error.message}`);
}

async function updateProviderCalendarToken(providerId, encryptedToken, calendarType, scopes) {
  const { error } = await supabase
    .from('providers')
    .update({
      calendar_token_enc:    encryptedToken,
      calendar_type:         calendarType,
      calendar_scopes:       scopes,
      calendar_connected_at: new Date().toISOString(),
    })
    .eq('id', providerId);

  if (error) throw new Error(`updateProviderCalendarToken failed: ${error.message}`);
}

async function incrementSignalCount(providerId) {
  const { error } = await supabase.rpc('increment_signal_count', { provider_id: providerId });
  // Fallback if RPC not set up
  if (error) {
    const provider = await getProvider(providerId);
    await supabase
      .from('providers')
      .update({
        signal_count:    (provider.signal_count || 0) + 1,
        last_signal_at:  new Date().toISOString(),
      })
      .eq('id', providerId);
  }
}

// ─── STANDING RULES ──────────────────────────────────────────

async function getStandingRules(providerId) {
  const { data, error } = await supabase
    .from('provider_standing_rules')
    .select('*')
    .eq('provider_id', providerId)
    .single();

  if (error && error.code !== 'PGRST116') { // PGRST116 = not found
    throw new Error(`getStandingRules failed: ${error.message}`);
  }
  return data;
}

async function upsertStandingRules(providerId, rules) {
  const { data, error } = await supabase
    .from('provider_standing_rules')
    .upsert(
      { provider_id: providerId, ...rules, updated_at: new Date().toISOString() },
      { onConflict: 'provider_id' }
    )
    .select()
    .single();

  if (error) throw new Error(`upsertStandingRules failed: ${error.message}`);
  return data;
}

// ─── SLOTS ───────────────────────────────────────────────────

async function createSlot(slotData) {
  const { data, error } = await supabase
    .from('slots')
    .insert(slotData)
    .select()
    .single();

  if (error) throw new Error(`createSlot failed: ${error.message}`);
  return data;
}

async function updateSlot(slotId, fields) {
  const { data, error } = await supabase
    .from('slots')
    .update({ ...fields, updated_at: new Date().toISOString() })
    .eq('id', slotId)
    .select()
    .single();

  if (error) throw new Error(`updateSlot failed: ${error.message}`);
  return data;
}

async function getSlot(slotId) {
  const { data, error } = await supabase
    .from('slots')
    .select('*')
    .eq('id', slotId)
    .single();

  if (error) throw new Error(`getSlot failed: ${error.message}`);
  return data;
}

async function getProviderSlotsToday(providerId) {
  const today      = new Date(); today.setUTCHours(0,0,0,0);
  const tomorrow   = new Date(today); tomorrow.setUTCDate(tomorrow.getUTCDate() + 1);

  const { data, error } = await supabase
    .from('slots')
    .select('*')
    .eq('provider_id', providerId)
    .gte('slot_start', today.toISOString())
    .lt('slot_start',  tomorrow.toISOString())
    .order('slot_start');

  if (error) throw new Error(`getProviderSlotsToday failed: ${error.message}`);
  return data || [];
}

async function getMarketplaceSlots(filters = {}) {
  let query = supabase
    .from('slots')
    .select('*')
    .eq('status', 'marketplace')
    .gte('slot_start', new Date().toISOString())
    .order('slot_start');

  if (filters.specialtyType) query = query.eq('providers.specialty_type', filters.specialtyType);
  if (filters.limit)         query = query.limit(filters.limit);

  const { data, error } = await query;
  if (error) throw new Error(`getMarketplaceSlots failed: ${error.message}`);
  return data || [];
}

async function releaseExpiredReservations() {
  // Release soft-reserved slots older than 5 minutes
  const cutoff = new Date(Date.now() - 5 * 60 * 1000).toISOString();
  const { error } = await supabase
    .from('slots')
    .update({ status: 'marketplace', patient_token: null, updated_at: new Date().toISOString() })
    .eq('status', 'reserved')
    .lt('updated_at', cutoff);

  if (error) throw new Error(`releaseExpiredReservations failed: ${error.message}`);
}

// ─── WAITLIST ────────────────────────────────────────────────

async function addToWaitlist(entry) {
  const { data, error } = await supabase
    .from('waitlist')
    .insert(entry)
    .select()
    .single();

  if (error) throw new Error(`addToWaitlist failed: ${error.message}`);
  return data;
}

async function getWaitlistForSlot(slot, maxResults = 10) {
  let query = supabase
    .from('waitlist')
    .select('*')
    .eq('status', 'waiting')
    .order('urgency_score', { ascending: false })
    .order('created_at',    { ascending: true })
    .limit(maxResults);

  // Filter by specialty if specified
  if (slot.specialty_type) {
    query = query.or(`specialty_needed.eq.${slot.specialty_type},specialty_needed.is.null`);
  }

  const { data, error } = await query;
  if (error) throw new Error(`getWaitlistForSlot failed: ${error.message}`);
  return data || [];
}

async function updateWaitlistEntry(entryId, fields) {
  const { error } = await supabase
    .from('waitlist')
    .update({ ...fields, updated_at: new Date().toISOString() })
    .eq('id', entryId);

  if (error) throw new Error(`updateWaitlistEntry failed: ${error.message}`);
}

// ─── BOOKINGS ────────────────────────────────────────────────

async function createBooking(bookingData) {
  const { data, error } = await supabase
    .from('bookings')
    .insert(bookingData)
    .select()
    .single();

  if (error) throw new Error(`createBooking failed: ${error.message}`);
  return data;
}

async function updateBooking(bookingId, fields) {
  const { data, error } = await supabase
    .from('bookings')
    .update({ ...fields, updated_at: new Date().toISOString() })
    .eq('id', bookingId)
    .select()
    .single();

  if (error) throw new Error(`updateBooking failed: ${error.message}`);
  return data;
}

async function getProviderBookingsToday(providerId) {
  const today    = new Date(); today.setUTCHours(0,0,0,0);
  const tomorrow = new Date(today); tomorrow.setUTCDate(tomorrow.getUTCDate() + 1);

  const { data, error } = await supabase
    .from('bookings')
    .select('*, slots(slot_start, slot_end)')
    .eq('provider_id', providerId)
    .gte('slots.slot_start', today.toISOString())
    .lt('slots.slot_start',  tomorrow.toISOString())
    .order('created_at', { ascending: false });

  if (error) throw new Error(`getProviderBookingsToday failed: ${error.message}`);
  return data || [];
}

// ─── CAPACITY REPORTS ────────────────────────────────────────

async function upsertCapacityReport(report) {
  const { data, error } = await supabase
    .from('capacity_reports')
    .upsert(
      { ...report, created_at: new Date().toISOString() },
      { onConflict: 'provider_id,report_date' }
    )
    .select()
    .single();

  if (error) throw new Error(`upsertCapacityReport failed: ${error.message}`);
  return data;
}

async function getCapacityHistory(providerId, days = 30) {
  const since = new Date();
  since.setUTCDate(since.getUTCDate() - days);

  const { data, error } = await supabase
    .from('capacity_reports')
    .select('report_date, utilization_pct, unused_count, gap_type, booked_count')
    .eq('provider_id', providerId)
    .gte('report_date', since.toISOString().slice(0,10))
    .order('report_date', { ascending: false });

  if (error) throw new Error(`getCapacityHistory failed: ${error.message}`);
  return data || [];
}

// ─── AUDIT LOG ───────────────────────────────────────────────

async function writeAuditLog(entry) {
  const { error } = await supabase
    .from('audit_log')
    .insert({
      entry_id:      entry.entryId,
      created_at:    entry.timestamp,
      action:        entry.action,
      actor_id:      entry.actorId,
      actor_type:    entry.actorType,
      resource_id:   entry.resourceId,
      resource_type: entry.resourceType,
      details:       entry.details,
      outcome:       entry.outcome,
      reason:        entry.reason,
      hash:          entry.hash,
      env:           entry.env,
    });

  if (error) {
    // Never let audit log failure break the app — but always alert
    console.error('[AUDIT_DB_CRITICAL] Failed to write to Supabase:', error.message);
  }
}

async function queryProviderAuditLog(providerId, limit = 100) {
  const { data, error } = await supabase
    .from('audit_log')
    .select('entry_id, created_at, action, outcome, details')
    .eq('actor_id', providerId)
    .order('created_at', { ascending: false })
    .limit(limit);

  if (error) throw new Error(`queryProviderAuditLog failed: ${error.message}`);
  return data || [];
}

// ─── NOTIFICATIONS ────────────────────────────────────────────

async function createNotification(providerId, notification) {
  const { data, error } = await supabase
    .from('provider_notifications')
    .insert({
      provider_id: providerId,
      type:        notification.type,
      message:     notification.message,
      payload:     notification.payload || {},
      sent_via:    notification.sentVia || [],
    })
    .select()
    .single();

  if (error) throw new Error(`createNotification failed: ${error.message}`);
  return data;
}

async function markNotificationRead(notificationId) {
  const { error } = await supabase
    .from('provider_notifications')
    .update({ read_at: new Date().toISOString() })
    .eq('id', notificationId);

  if (error) throw new Error(`markNotificationRead failed: ${error.message}`);
}

async function getUnreadNotifications(providerId) {
  const { data, error } = await supabase
    .from('provider_notifications')
    .select('*')
    .eq('provider_id', providerId)
    .is('read_at', null)
    .order('created_at', { ascending: false })
    .limit(20);

  if (error) throw new Error(`getUnreadNotifications failed: ${error.message}`);
  return data || [];
}

// ─── REALTIME SUBSCRIPTIONS ───────────────────────────────────

/**
 * Subscribe to real-time slot changes for a provider.
 * Used by provider dashboard to show live updates.
 */
function subscribeToProviderSlots(providerId, callback) {
  return supabase
    .channel(`slots:${providerId}`)
    .on('postgres_changes', {
      event:  '*',
      schema: 'public',
      table:  'slots',
      filter: `provider_id=eq.${providerId}`,
    }, callback)
    .subscribe();
}

function subscribeToProviderNotifications(providerId, callback) {
  return supabase
    .channel(`notifications:${providerId}`)
    .on('postgres_changes', {
      event:  'INSERT',
      schema: 'public',
      table:  'provider_notifications',
      filter: `provider_id=eq.${providerId}`,
    }, callback)
    .subscribe();
}

// ─── EXPORTS ─────────────────────────────────────────────────
module.exports = {
  supabase,

  // Providers
  getProvider,
  upsertProvider,
  updateProviderAgentStatus,
  updateProviderCalendarToken,
  incrementSignalCount,

  // Standing rules
  getStandingRules,
  upsertStandingRules,

  // Slots
  createSlot,
  updateSlot,
  getSlot,
  getProviderSlotsToday,
  getMarketplaceSlots,
  releaseExpiredReservations,

  // Waitlist
  addToWaitlist,
  getWaitlistForSlot,
  updateWaitlistEntry,

  // Bookings
  createBooking,
  updateBooking,
  getProviderBookingsToday,

  // Capacity
  upsertCapacityReport,
  getCapacityHistory,

  // Audit
  writeAuditLog,
  queryProviderAuditLog,

  // Notifications
  createNotification,
  markNotificationRead,
  getUnreadNotifications,

  // Realtime
  subscribeToProviderSlots,
  subscribeToProviderNotifications,
};
