const { initDb } = require("../db/init.cjs");
const { query } = require("../db/pool.cjs");

async function upsertSlot(slot) {
  await initDb();

  const values = [
    slot.slotId,
    slot.providerId,
    slot.startTime || null,
    slot.endTime || null,
    slot.status || "OPEN",
    slot.specialty || null,
    slot.insurance || null,
    slot.language || null,
    slot.location || null,
    !!slot.heldByCareX,
  ];

  const { rows } = await query(`
    INSERT INTO schedule_slots (
      slot_id, provider_id, start_time, end_time, status,
      specialty, insurance, language, location, held_by_carex, updated_at
    )
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,NOW())
    ON CONFLICT (slot_id) DO UPDATE SET
      provider_id = EXCLUDED.provider_id,
      start_time = EXCLUDED.start_time,
      end_time = EXCLUDED.end_time,
      status = EXCLUDED.status,
      specialty = EXCLUDED.specialty,
      insurance = EXCLUDED.insurance,
      language = EXCLUDED.language,
      location = EXCLUDED.location,
      held_by_carex = EXCLUDED.held_by_carex,
      updated_at = NOW()
    RETURNING
      slot_id AS "slotId",
      provider_id AS "providerId",
      start_time AS "startTime",
      end_time AS "endTime",
      status,
      specialty,
      insurance,
      language,
      location,
      held_by_carex AS "heldByCareX",
      updated_at AS "updatedAt"
  `, values);

  return rows[0];
}

async function getSlot(slotId) {
  await initDb();
  const { rows } = await query(`
    SELECT
      slot_id AS "slotId",
      provider_id AS "providerId",
      start_time AS "startTime",
      end_time AS "endTime",
      status,
      specialty,
      insurance,
      language,
      location,
      held_by_carex AS "heldByCareX",
      updated_at AS "updatedAt"
    FROM schedule_slots
    WHERE slot_id = $1
  `, [slotId]);
  return rows[0] || null;
}

async function getProviderSlots(providerId) {
  await initDb();
  const { rows } = await query(`
    SELECT
      slot_id AS "slotId",
      provider_id AS "providerId",
      start_time AS "startTime",
      end_time AS "endTime",
      status,
      specialty,
      insurance,
      language,
      location,
      held_by_carex AS "heldByCareX",
      updated_at AS "updatedAt"
    FROM schedule_slots
    WHERE provider_id = $1
    ORDER BY start_time NULLS LAST, slot_id
  `, [providerId]);
  return rows;
}

module.exports = { upsertSlot, getSlot, getProviderSlots };
