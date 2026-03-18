const { initDb } = require("../db/init.cjs");
const { query } = require("../db/pool.cjs");

async function createOpportunity(o) {
  await initDb();
  const { rows } = await query(`
    INSERT INTO opportunities (
      opportunity_id, provider_id, slot_id, type,
      specialty, insurance, language, location, created_at
    )
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,NOW())
    RETURNING
      opportunity_id AS "opportunityId",
      provider_id AS "providerId",
      slot_id AS "slotId",
      type,
      specialty,
      insurance,
      language,
      location,
      created_at AS "createdAt"
  `, [
    o.opportunityId,
    o.providerId,
    o.slotId,
    o.type,
    o.specialty || null,
    o.insurance || null,
    o.language || null,
    o.location || null,
  ]);
  return rows[0];
}

async function getProviderOpportunities(providerId) {
  await initDb();
  const { rows } = await query(`
    SELECT
      opportunity_id AS "opportunityId",
      provider_id AS "providerId",
      slot_id AS "slotId",
      type,
      specialty,
      insurance,
      language,
      location,
      created_at AS "createdAt"
    FROM opportunities
    WHERE provider_id = $1
    ORDER BY created_at DESC
  `, [providerId]);
  return rows;
}

module.exports = { createOpportunity, getProviderOpportunities };
