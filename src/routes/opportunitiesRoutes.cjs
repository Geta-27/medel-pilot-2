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

function estimateDistanceMiles(userLocation, providerAddress) {
  if (!userLocation || !providerAddress) return null;
  const u = String(userLocation).toLowerCase();
  const p = String(providerAddress).toLowerCase();

  if (u.includes("hoboken") && p.includes("hoboken")) return 1.8;
  if (u.includes("jersey city") && p.includes("hoboken")) return 3.4;
  if (u.includes("union city") && p.includes("hoboken")) return 2.1;
  if (u.includes("manhattan") && p.includes("hoboken")) return 5.2;

  return 7.5;
}

function estimateCopay(insurance, specialty) {
  const ins = String(insurance || "").toLowerCase();
  const spec = String(specialty || "").toLowerCase();

  if (ins.includes("aetna") && spec === "primary_care") return "$35";
  if (ins.includes("aetna") && spec === "urgent_care") return "$45";
  if (ins.includes("united") && spec === "primary_care") return "$40";
  if (ins.includes("united") && spec === "urgent_care") return "$55";

  return "$50";
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
        p.clinic_name,
        p.specialty,
        p.insurance,
        p.location
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
      clinicName: r.clinic_name || "CareX Clinic",
      specialty: r.specialty || "general",
      address: r.location || "Address unavailable",
      distanceMiles: estimateDistanceMiles(location, r.location),
      startTime: r.start_time,
      endTime: r.end_time,
      insuranceAccepted: Array.isArray(r.insurance)
        ? r.insurance.join(", ")
        : r.insurance || "Unknown",
      copayEstimate: estimateCopay(insurance || r.insurance, r.specialty),
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
      slots = slots.sort((a, b) => (a.distanceMiles ?? 999) - (b.distanceMiles ?? 999));
    }

    res.json({ ok: true, slots });
  } catch (e) {
    console.error("marketplace slots error:", e);
    res.status(500).json({ ok: false, error: e.message });
  }
});

module.exports = router;
