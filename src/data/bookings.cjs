const { initDb } = require("../db/init.cjs");
const { query } = require("../db/pool.cjs");

async function createBooking(b) {
  await initDb();
  const { rows } = await query(`
    INSERT INTO bookings (
      booking_id, provider_id, slot_id, opportunity_id,
      patient_request_id, status, created_at, auto_matched
    )
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
    RETURNING
      booking_id AS "bookingId",
      provider_id AS "providerId",
      slot_id AS "slotId",
      opportunity_id AS "opportunityId",
      patient_request_id AS "patientRequestId",
      status,
      created_at AS "createdAt",
      auto_matched AS "autoMatched",
      veto_reason AS "vetoReason",
      vetoed_at AS "vetoedAt"
  `, [
    b.bookingId,
    b.providerId,
    b.slotId,
    b.opportunityId,
    b.patientRequestId,
    b.status,
    b.createdAt || new Date().toISOString(),
    !!b.autoMatched,
  ]);
  return rows[0];
}

async function getBooking(bookingId) {
  await initDb();
  const { rows } = await query(`
    SELECT
      booking_id AS "bookingId",
      provider_id AS "providerId",
      slot_id AS "slotId",
      opportunity_id AS "opportunityId",
      patient_request_id AS "patientRequestId",
      status,
      created_at AS "createdAt",
      auto_matched AS "autoMatched",
      veto_reason AS "vetoReason",
      vetoed_at AS "vetoedAt"
    FROM bookings
    WHERE booking_id = $1
  `, [bookingId]);
  return rows[0] || null;
}

async function updateBookingVeto(bookingId, reason) {
  await initDb();
  const { rows } = await query(`
    UPDATE bookings
    SET status = 'VETOED_BY_PROVIDER',
        veto_reason = $2,
        vetoed_at = NOW()
    WHERE booking_id = $1
    RETURNING
      booking_id AS "bookingId",
      provider_id AS "providerId",
      slot_id AS "slotId",
      opportunity_id AS "opportunityId",
      patient_request_id AS "patientRequestId",
      status,
      created_at AS "createdAt",
      auto_matched AS "autoMatched",
      veto_reason AS "vetoReason",
      vetoed_at AS "vetoedAt"
  `, [bookingId, reason]);
  return rows[0] || null;
}

async function listBookings() {
  await initDb();
  const { rows } = await query(`
    SELECT
      booking_id AS "bookingId",
      provider_id AS "providerId",
      slot_id AS "slotId",
      opportunity_id AS "opportunityId",
      patient_request_id AS "patientRequestId",
      status,
      created_at AS "createdAt",
      auto_matched AS "autoMatched",
      veto_reason AS "vetoReason",
      vetoed_at AS "vetoedAt"
    FROM bookings
    ORDER BY created_at DESC
  `);
  return rows;
}

module.exports = { createBooking, getBooking, updateBookingVeto, listBookings };
