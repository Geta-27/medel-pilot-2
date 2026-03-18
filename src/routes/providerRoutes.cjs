const express = require("express");
const router = express.Router();
const { getRules, setRules } = require("../data/providerRules.cjs");

router.get("/providers/:id/rules", async (req, res) => {
  try {
    const rules = await getRules(req.params.id);
    res.json({ ok: true, rules });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

router.put("/providers/:id/rules", async (req, res) => {
  try {
    const rules = await setRules(req.params.id, req.body || {});
    res.json({ ok: true, rules });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

module.exports = router;
