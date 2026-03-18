const express = require("express");
const router = express.Router();
const { ingestSnapshot, ingestEvent } = require("../services/scheduleEngine.cjs");
const { getProviderSlots } = require("../data/scheduleSlots.cjs");

router.post("/schedule/snapshot", async (req, res) => {
  try {
    const { providerId, slots } = req.body || {};
    const saved = await ingestSnapshot(providerId, slots || []);
    res.json({ ok: true, slots: saved });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

router.post("/schedule/events", async (req, res) => {
  try {
    const result = await ingestEvent(req.body || {});
    res.json({ ok: true, result });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

router.get("/providers/:id/schedule", async (req, res) => {
  try {
    const slots = await getProviderSlots(req.params.id);
    res.json({ ok: true, slots });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

module.exports = router;
