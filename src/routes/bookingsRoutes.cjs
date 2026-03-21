const express = require("express");
const router = express.Router();
const { getProviderOpportunities } = require("../data/opportunities.cjs");
const { getSlot, upsertSlot } = require("../data/scheduleSlots.cjs");
const { createBooking, getBooking, updateBookingVeto, listBookings } = require("../data/bookings.cjs");
const { requeueRequest } = require("../data/requests.cjs");

function id(prefix) {
  return prefix + "_" + Math.random().toString(36).slice(2,9);
}

router.post("/opportunities/:id/hold", async (req, res) => {
  try {
    const providerId = req.body.providerId || req.query.providerId || "prov1";
    const opp = (await getProviderOpportunities(providerId)).find(o => o.opportunityId === req.params.id);

    if (!opp) return res.status(404).json({ ok:false, error:"Opportunity not found" });

    const slot = await getSlot(opp.slotId);
    if (!slot) return res.status(404).json({ ok:false, error:"Slot not found" });

    const booking = await createBooking({
      bookingId: id("bk"),
      providerId: opp.providerId,
      slotId: opp.slotId,
      opportunityId: opp.opportunityId,
      patientRequestId: req.body.patientRequestId || null,
      status: "HELD_BY_CAREX",
      createdAt: new Date().toISOString(),
      autoMatched: false,
    });

    await upsertSlot({ ...slot, status: "HELD_BY_CAREX", heldByCareX: true });
    res.json({ ok:true, booking });
  } catch (e) {
    res.status(500).json({ ok:false, error:e.message });
  }
});

// Patient-facing booking submission
router.post("/bookings", async (req, res) => {
  try {
    const body = req.body || {};
    const patient = body.patient || {};

    if (!body.slotId) {
      return res.status(400).json({ ok:false, error:"Missing slotId" });
    }

    const required = ["firstName", "lastName", "dob", "phone", "email", "address", "memberId", "reason"];
    for (const key of required) {
      if (!patient[key]) {
        return res.status(400).json({ ok:false, error:`Missing patient field: ${key}` });
      }
    }

    if (!patient.consent) {
      return res.status(400).json({ ok:false, error:"Consent is required" });
    }

    const booking = await createBooking({
      bookingId: id("bk"),
      providerId: body.providerId || null,
      slotId: body.slotId,
      opportunityId: body.opportunityId || `opp_`,
      patientRequestId: body.patientRequestId || ('req_' + Date.now()),
      providerName: body.providerName || "",
      clinicName: body.clinicName || "",
      specialty: body.specialty || "",
      startTime: body.startTime || null,
      insurance: body.insurance || "",
      patientName: `${patient.firstName} ${patient.lastName}`,
      patientDob: patient.dob,
      patientPhone: patient.phone,
      patientEmail: patient.email,
      patientAddress: patient.address,
      insuranceMemberId: patient.memberId,
      reason: patient.reason,
      consent: patient.consent,
      status: "REQUEST_SUBMITTED",
      createdAt: new Date().toISOString(),
      autoMatched: false,
    });

    res.json({
      ok: true,
      booking: {
        id: booking.bookingId || booking.id,
        providerName: body.providerName || "",
        clinicName: body.clinicName || "",
        startTime: body.startTime || null,
        patientName: `${patient.firstName} ${patient.lastName}`,
        status: booking.status || "REQUEST_SUBMITTED"
      }
    });
  } catch (e) {
    res.status(500).json({ ok:false, error:e.message });
  }
});

router.post("/bookings/:id/veto", async (req, res) => {
  try {
    const booking = await getBooking(req.params.id);
    if (!booking) return res.status(404).json({ ok:false, error:"Booking not found" });

    const updated = await updateBookingVeto(req.params.id, req.body.reason || "Provider veto");

    const slot = await getSlot(booking.slotId);
    if (slot) {
      await upsertSlot({
        ...slot,
        status: "OVERRIDDEN_BY_PROVIDER",
        heldByCareX: false
      });
    }

    if (updated.patientRequestId) {
      await requeueRequest(updated.patientRequestId);
    }

    res.json({ ok:true, booking: updated });
  } catch (e) {
    res.status(500).json({ ok:false, error:e.message });
  }
});

router.get("/bookings", async (req, res) => {
  try {
    const bookings = await listBookings();
    res.json({ ok:true, bookings });
  } catch (e) {
    res.status(500).json({ ok:false, error:e.message });
  }
});

// Optional debug alias
router.get("/bookings/debug", async (req, res) => {
  try {
    const bookings = await listBookings();
    res.json({ ok:true, count: bookings.length, bookings });
  } catch (e) {
    res.status(500).json({ ok:false, error:e.message });
  }
});

module.exports = router;
