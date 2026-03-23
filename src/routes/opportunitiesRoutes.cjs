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

router.get("/providers/:id/opportunities", async (req, res) => {
  try {
    const opportunities = await getProviderOpportunities(req.params.id);
    res.json({ ok: true, opportunities });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// Patient-facing marketplace slots (REAL DB)
router.get("/marketplace/slots", async (req, res) => {
  try {
    const { specialty, insurance, location } = req.query;

    const result = await pool.query(
      `
      SELECT
        s.id,
        s.provider_id,
        s.start_time,
        s.end_time,
        s.status,
        p.name,
        p.specialty,
        p.location_text,
        p.insurance
      FROM slots s
      LEFT JOIN providers p
        ON p.id = s.provider_id
      WHERE s.status = 'available'
        AND s.start_time > NOW()
      ORDER BY s.start_time ASC
      LIMIT 50
      `
    );

    let slots = result.rows.map((r) => ({
      slotId: r.id,
      providerId: r.provider_id,
      providerName: r.name || r.provider_id,
      clinicName: "CareX Clinic",
      specialty: r.specialty || "general",
      address: r.location_text || "Address unavailable",
      distanceMiles: null,
      startTime: r.start_time,
      endTime: r.end_time,
      insuranceAccepted: Array.isArray(r.insurance)
        ? r.insurance.join(", ")
        : r.insurance || "Unknown",
      copayEstimate: null,
    }));

    if (specialty) {
      slots = slots.filter((s) => s.specialty === specialty);
    }

    if (insurance) {
      slots = slots.filter((s) =>
        String(s.insuranceAccepted || "").toLowerCase().includes(String(insurance).toLowerCase())
      );
    }

    if (location) {
      // placeholder until real geocoding is added
      slots = slots.sort((a, b) => String(a.address).localeCompare(String(b.address)));
    }

    res.json({ ok: true, slots });
  } catch (e) {
    console.error("marketplace slots error:", e);
    res.status(500).json({ ok: false, error: e.message });
  }
});

module.exports = router;
