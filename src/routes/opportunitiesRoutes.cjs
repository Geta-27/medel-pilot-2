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

module.exports = router;
