const { initDb } = require("../db/init.cjs");
const { query } = require("../db/pool.cjs");

async function resetRequests() {
  await initDb();
  await query(`DELETE FROM requests`);
  return [];
}

async function addRequest(body = {}) {
  await initDb();
  const requestId = body.requestId || ("req_" + Math.random().toString(36).slice(2,9));

  const { rows } = await query(`
    INSERT INTO requests (
      request_id, specialty, insurance, language, location, status
    )
    VALUES ($1,$2,$3,$4,$5,$6)
    ON CONFLICT (request_id) DO UPDATE SET
      specialty = EXCLUDED.specialty,
      insurance = EXCLUDED.insurance,
      language = EXCLUDED.language,
      location = EXCLUDED.location,
      status = EXCLUDED.status
    RETURNING
      request_id AS "requestId",
      specialty,
      insurance,
      language,
      location,
      status,
      booking_id AS "bookingId",
      assigned_provider_id AS "assignedProviderId",
      created_at AS "createdAt"
  `, [
    requestId,
    body.specialty || "urgent_care",
    body.insurance || "Aetna",
    body.language || "English",
    body.location || null,
    body.status || "PENDING",
  ]);

  return rows[0];
}

async function listRequests() {
  await initDb();
  const { rows } = await query(`
    SELECT
      request_id AS "requestId",
      specialty,
      insurance,
      language,
      location,
      status,
      booking_id AS "bookingId",
      assigned_provider_id AS "assignedProviderId",
      created_at AS "createdAt"
    FROM requests
    ORDER BY created_at ASC
  `);
  return rows;
}

async function matchRequest(requestId, bookingId, providerId) {
  await initDb();
  const { rows } = await query(`
    UPDATE requests
    SET status = 'MATCHED',
        booking_id = $2,
        assigned_provider_id = $3
    WHERE request_id = $1
    RETURNING
      request_id AS "requestId",
      specialty,
      insurance,
      language,
      location,
      status,
      booking_id AS "bookingId",
      assigned_provider_id AS "assignedProviderId",
      created_at AS "createdAt"
  `, [requestId, bookingId, providerId]);
  return rows[0] || null;
}

async function requeueRequest(requestId) {
  await initDb();
  const { rows } = await query(`
    UPDATE requests
    SET status = 'PENDING',
        booking_id = NULL,
        assigned_provider_id = NULL
    WHERE request_id = $1
    RETURNING
      request_id AS "requestId",
      specialty,
      insurance,
      language,
      location,
      status,
      booking_id AS "bookingId",
      assigned_provider_id AS "assignedProviderId",
      created_at AS "createdAt"
  `, [requestId]);
  return rows[0] || null;
}

module.exports = { resetRequests, addRequest, listRequests, matchRequest, requeueRequest };
