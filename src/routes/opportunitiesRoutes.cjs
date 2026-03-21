const express = require("express");
const router = express.Router();
const { getProviderOpportunities } = require("../data/opportunities.cjs");

router.get("/providers/:id/opportunities", async (req, res) => {
  try {
    const opportunities = await getProviderOpportunities(req.params.id);
    res.json({ ok: true, opportunities });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// Patient-facing marketplace slots
router.get("/marketplace/slots", async (req, res) => {
  try {
    const { specialty, insurance, location } = req.query;

    // Demo MVP dataset for patient search flow
    let slots = [
      {
        slotId: "slot_1",
        providerId: "prov_1",
        providerName: "Dr. Jane Smith",
        clinicName: "CareX Primary Care - Hoboken",
        specialty: "primary_care",
        address: "145 Hudson St, Hoboken, NJ 07030",
        distanceMiles: 1.8,
        startTime: new Date(Date.now() + 2 * 60 * 60 * 1000).toISOString(),
        insuranceAccepted: "Aetna",
        copayEstimate: "$35"
      },
      {
        slotId: "slot_2",
        providerId: "prov_2",
        providerName: "Dr. Michael Brown",
        clinicName: "CareX Urgent Care - Jersey City",
        specialty: "urgent_care",
        address: "220 Newark Ave, Jersey City, NJ 07302",
        distanceMiles: 3.4,
        startTime: new Date(Date.now() + 4 * 60 * 60 * 1000).toISOString(),
        insuranceAccepted: "UnitedHealthcare",
        copayEstimate: "$45"
      },
      {
        slotId: "slot_3",
        providerId: "prov_3",
        providerName: "Dr. Sarah Lee",
        clinicName: "CareX Family Medicine - Union City",
        specialty: "primary_care",
        address: "3301 Bergenline Ave, Union City, NJ 07087",
        distanceMiles: 5.2,
        startTime: new Date(Date.now() + 6 * 60 * 60 * 1000).toISOString(),
        insuranceAccepted: "Aetna",
        copayEstimate: "$30"
      }
    ];

    if (specialty) {
      slots = slots.filter(s => s.specialty === specialty);
    }

    if (insurance) {
      slots = slots.filter(
        s => (s.insuranceAccepted || "").toLowerCase() === String(insurance).toLowerCase()
      );
    }

    // MVP placeholder: accept location input now, real geocoding later
    if (location) {
      slots = slots.sort((a, b) => a.distanceMiles - b.distanceMiles);
    }

    slots = slots.sort((a, b) => a.distanceMiles - b.distanceMiles);

    res.json({ ok: true, slots });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

module.exports = router;
