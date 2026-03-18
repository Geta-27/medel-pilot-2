const { query } = require("./pool.cjs");

let initialized = false;
let initializing = null;

async function initDb() {
  if (initialized) return;
  if (initializing) return initializing;

  initializing = (async () => {
    await query(`
      CREATE TABLE IF NOT EXISTS provider_rules (
        provider_id TEXT PRIMARY KEY,
        auto_fill_enabled BOOLEAN NOT NULL DEFAULT TRUE,
        automation_level TEXT NOT NULL DEFAULT 'LEVEL_2_HOLD_WITH_VETO',
        release_cancelled_slots_immediately BOOLEAN NOT NULL DEFAULT TRUE,
        release_no_show_after_minutes INTEGER NOT NULL DEFAULT 15,
        max_carex_add_ons_per_day INTEGER NOT NULL DEFAULT 4,
        veto_window_minutes INTEGER NOT NULL DEFAULT 5,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
    `);

    await query(`
      CREATE TABLE IF NOT EXISTS schedule_slots (
        slot_id TEXT PRIMARY KEY,
        provider_id TEXT NOT NULL,
        start_time TIMESTAMPTZ NULL,
        end_time TIMESTAMPTZ NULL,
        status TEXT NOT NULL DEFAULT 'OPEN',
        specialty TEXT NULL,
        insurance TEXT NULL,
        language TEXT NULL,
        location TEXT NULL,
        held_by_carex BOOLEAN NOT NULL DEFAULT FALSE,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
    `);

    await query(`
      CREATE TABLE IF NOT EXISTS opportunities (
        opportunity_id TEXT PRIMARY KEY,
        provider_id TEXT NOT NULL,
        slot_id TEXT NOT NULL,
        type TEXT NOT NULL,
        specialty TEXT NULL,
        insurance TEXT NULL,
        language TEXT NULL,
        location TEXT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
    `);

    await query(`
      CREATE TABLE IF NOT EXISTS bookings (
        booking_id TEXT PRIMARY KEY,
        provider_id TEXT NOT NULL,
        slot_id TEXT NOT NULL,
        opportunity_id TEXT NOT NULL,
        patient_request_id TEXT NOT NULL,
        status TEXT NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        auto_matched BOOLEAN NOT NULL DEFAULT FALSE,
        veto_reason TEXT NULL,
        vetoed_at TIMESTAMPTZ NULL
      );
    `);

    await query(`
      CREATE TABLE IF NOT EXISTS requests (
        request_id TEXT PRIMARY KEY,
        specialty TEXT NULL,
        insurance TEXT NULL,
        language TEXT NULL,
        location TEXT NULL,
        status TEXT NOT NULL DEFAULT 'PENDING',
        booking_id TEXT NULL,
        assigned_provider_id TEXT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
    `);

    initialized = true;
    console.log("Postgres schema ready");
  })();

  return initializing;
}

module.exports = { initDb };
