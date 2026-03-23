const express = require("express");
const router = express.Router();
const { Pool } = require("pg");
const { getProviderOpportunities } = require("../data/opportunities.cjs");

const pool =
  global.__carexPool ||
  new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: process.env.DATABASE_URL ? { rejectUnauthorized: false } : false,
  });

global.__carexPool = pool;

function toRad(v) {
  return (Number(v) * Math.PI) / 180;
}

function haversineMiles(lat1, lng1, lat2, lng2) {
  if ([lat1, lng1, lat2, lng2].some((v) => v === null || v === undefined || v === "" || Number.isNaN(Number(v)))) {
    return null;
  }
  const R = 3958.8;
  const dLat = toRad(Number(lat2) - Number(lat1));
  const dLng = toRad(Number(lng2) - Number(lng1));
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return Math.round(R * c * 10) / 10;
}

function buildAddress(r) {
  return (
    r.location ||
    [r.address_line1, r.city, r.state, r.zip].filter(Boolean).join(", ") ||
    "Address unavailable"
  );
}

function getEstimatedOutOfPocket(payerRules, insurance, specialty) {
  const payer = String(insurance || "").trim();
  const spec = String(specialty || "").trim();
  if (!payerRules || typeof payerRules !== "object") return null;
  const payerRule = payerRules[payer];
  if (!payerRule || typeof payerRule !== "object") return null;
  const specRule = payerRule[spec];
  if (!specRule || typeof specRule !== "object") return null;
  if (specRule.copay === undefined || specRule.copay === null) return null;
  return `$${specRule.copay}`;
}

router.get("/providers/:id/opportunities", async (req, res) => {
  try {
    const opportunities = await getProviderOpportunities(req.params.id);
    res.json({ ok: true, opportunities });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

router.get("/marketplace/slots", async (req, res) => {
  try {
    const { specialty, insurance, lat, lng } = req.query;

    const result = await pool.query(
      `
      SELECT
        s.id,
        s.provider_id,
        s.start_time,
        s.end_time,
        s.status,
        p.name,
        p.clinic_name,
        p.specialty,
        p.insurance,
        p.location,
        p.address_line1,
        p.city,
        p.state,
        p.zip,
        p.lat,
        p.lng,
        p.visit_type,
        p.payer_rules
      FROM slots s
      LEFT JOIN providers p
        ON p.id = s.provider_id
      WHERE s.status = 'available'
        AND s.start_time > NOW()
        AND COALESCE(p.online, true) = true
      ORDER BY s.start_time ASC
      LIMIT 100
      `
    );

    let slots = result.rows.map((r) => {
      const address = buildAddress(r);
      const distanceMiles = haversineMiles(lat, lng, r.lat, r.lng);
      const insuranceAccepted = Array.isArray(r.insurance)
        ? r.insurance.join(", ")
        : r.insurance || "Unknown";
      const estimatedOutOfPocket = getEstimatedOutOfPocket(
        r.payer_rules,
        insurance || r.insurance,
        r.specialty
      );

      return {
        slotId: r.id,
        providerId: r.provider_id,
        providerName: r.name || r.provider_id,
        clinicName: r.clinic_name || "CareX Clinic",
        specialty: r.specialty || "general",
        visitType: r.visit_type || "in_person",
        address,
        lat: r.lat,
        lng: r.lng,
        distanceMiles,
        startTime: r.start_time,
        endTime: r.end_time,
        insuranceAccepted,
        estimatedOutOfPocket
      };
    });

    if (specialty) {
      slots = slots.filter((s) => String(s.specialty) === String(specialty));
    }

    if (insurance) {
      slots = slots.filter((s) =>
        String(s.insuranceAccepted || "").toLowerCase().includes(String(insurance).toLowerCase())
      );
    }

    if (lat && lng) {
      slots = slots.sort((a, b) => (a.distanceMiles ?? 9999) - (b.distanceMiles ?? 9999));
    }

    res.json({ ok: true, slots });
  } catch (e) {
    console.error("marketplace slots error:", e);
    res.status(500).json({ ok: false, error: e.message });
  }
});

router.post("/marketplace/book", async (req, res) => {
  const client = await pool.connect();
  try {
    const { slotId, patientName } = req.body || {};
    if (!slotId) {
      return res.status(400).json({ ok: false, error: "slotId is required" });
    }

    await client.query("BEGIN");

    const slotResult = await client.query(
      `
      SELECT id, provider_id, start_time, end_time, status
      FROM slots
      WHERE id = $1
      FOR UPDATE
      `,
      [slotId]
    );

    if (!slotResult.rows.length) {
      await client.query("ROLLBACK");
      return res.status(404).json({ ok: false, error: "Slot not found" });
    }

    const slot = slotResult.rows[0];

    if (slot.status !== "available") {
      await client.query("ROLLBACK");
      return res.status(409).json({ ok: false, error: "Slot is no longer available" });
    }

    await client.query(
      `
      UPDATE slots
      SET status = 'booked'
      WHERE id = $1
      `,
      [slotId]
    );

    const bookingId = `bk_${Date.now()}`;

    await client.query(
      `
      INSERT INTO bookings (id, provider_id, patient_name, start_time, status)
      VALUES ($1, $2, $3, $4, 'confirmed')
      `,
      [bookingId, slot.provider_id, patientName || "Guest Patient", slot.start_time]
    );

    await client.query("COMMIT");

    return res.json({
      ok: true,
      booking: {
        bookingId,
        slotId: slot.id,
        providerId: slot.provider_id,
        patientName: patientName || "Guest Patient",
        status: "confirmed",
        startTime: slot.start_time,
        endTime: slot.end_time
      }
    });
  } catch (e) {
    await client.query("ROLLBACK");
    console.error("marketplace booking error:", e);
    return res.status(500).json({ ok: false, error: e.message });
  } finally {
    client.release();
  }
});

module.exports = router;
