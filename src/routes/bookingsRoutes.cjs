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

module.exports = router;
