const express = require("express");
const router = express.Router();

const { getProviderOpportunities } = require("../data/opportunities.cjs");
const { getSlot, upsertSlot } = require("../data/scheduleSlots.cjs");
const { createBooking } = require("../data/bookings.cjs");
const { listRequests, resetRequests, addRequest, matchRequest } = require("../data/requests.cjs");
const { pickBestRequest } = require("../services/requestMatcher.cjs");

function id(prefix){
  return prefix + "_" + Math.random().toString(36).slice(2,9);
}

router.post("/providers/:id/opportunities/:opportunityId/auto-hold", async (req, res) => {
  try {
    const providerId = req.params.id;
    const opportunityId = req.params.opportunityId;

    const opp = (await getProviderOpportunities(providerId)).find(o => o.opportunityId === opportunityId);
    if (!opp) return res.status(404).json({ ok:false, error:"Opportunity not found" });

    const slot = await getSlot(opp.slotId);
    if (!slot) return res.status(404).json({ ok:false, error:"Slot not found" });

    const requests = await listRequests();
    const picked = pickBestRequest(requests, providerId, slot, opp);

    if (!picked) return res.status(404).json({ ok:false, error:"No eligible pending request found" });

    const booking = await createBooking({
      bookingId: id("bk"),
      providerId,
      slotId: opp.slotId,
      opportunityId: opp.opportunityId,
      patientRequestId: picked.requestId,
      status: "HELD_BY_CAREX",
      createdAt: new Date().toISOString(),
      autoMatched: true
    });

    await upsertSlot({
      ...slot,
      status: "HELD_BY_CAREX",
      heldByCareX: true
    });

    const matchedRequest = await matchRequest(picked.requestId, booking.bookingId, providerId);

    res.json({ ok:true, matchedRequest, booking });
  } catch (e) {
    res.status(500).json({ ok:false, error:e.message });
  }
});

router.get("/requests/debug", async (req, res) => {
  try {
    res.json({ ok:true, requests: await listRequests() });
  } catch (e) {
    res.status(500).json({ ok:false, error:e.message });
  }
});

router.post("/requests/debug/reset", async (req, res) => {
  try {
    await resetRequests();
    res.json({ ok:true, requests: [] });
  } catch (e) {
    res.status(500).json({ ok:false, error:e.message });
  }
});

router.post("/requests/debug/add", async (req, res) => {
  try {
    const request = await addRequest(req.body || {});
    const requests = await listRequests();
    res.json({ ok:true, request, count: requests.length });
  } catch (e) {
    res.status(500).json({ ok:false, error:e.message });
  }
});

module.exports = router;
