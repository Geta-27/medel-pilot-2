const { initDb } = require("../db/init.cjs");
const { query } = require("../db/pool.cjs");

async function getRules(providerId) {
  await initDb();

  await query(`
    INSERT INTO provider_rules (provider_id)
    VALUES ($1)
    ON CONFLICT (provider_id) DO NOTHING
  `, [providerId]);

  const { rows } = await query(`
    SELECT
      provider_id AS "providerId",
      auto_fill_enabled AS "autoFillEnabled",
      automation_level AS "automationLevel",
      release_cancelled_slots_immediately AS "releaseCancelledSlotsImmediately",
      release_no_show_after_minutes AS "releaseNoShowAfterMinutes",
      max_carex_add_ons_per_day AS "maxCareXAddOnsPerDay",
      veto_window_minutes AS "vetoWindowMinutes",
      updated_at AS "updatedAt"
    FROM provider_rules
    WHERE provider_id = $1
  `, [providerId]);

  return rows[0];
}

async function setRules(providerId, update = {}) {
  await initDb();
  const current = await getRules(providerId);

  const next = {
    ...current,
    ...update,
    providerId,
  };

  await query(`
    INSERT INTO provider_rules (
      provider_id,
      auto_fill_enabled,
      automation_level,
      release_cancelled_slots_immediately,
      release_no_show_after_minutes,
      max_carex_add_ons_per_day,
      veto_window_minutes,
      updated_at
    )
    VALUES ($1,$2,$3,$4,$5,$6,$7,NOW())
    ON CONFLICT (provider_id) DO UPDATE SET
      auto_fill_enabled = EXCLUDED.auto_fill_enabled,
      automation_level = EXCLUDED.automation_level,
      release_cancelled_slots_immediately = EXCLUDED.release_cancelled_slots_immediately,
      release_no_show_after_minutes = EXCLUDED.release_no_show_after_minutes,
      max_carex_add_ons_per_day = EXCLUDED.max_carex_add_ons_per_day,
      veto_window_minutes = EXCLUDED.veto_window_minutes,
      updated_at = NOW()
  `, [
    providerId,
    next.autoFillEnabled ?? true,
    next.automationLevel ?? "LEVEL_2_HOLD_WITH_VETO",
    next.releaseCancelledSlotsImmediately ?? true,
    next.releaseNoShowAfterMinutes ?? 15,
    next.maxCareXAddOnsPerDay ?? 4,
    next.vetoWindowMinutes ?? 5,
  ]);

  return getRules(providerId);
}

module.exports = { getRules, setRules };
