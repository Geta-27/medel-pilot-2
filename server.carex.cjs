const express = require("express");
const cors = require("cors");
const http = require("http");
const { WebSocketServer } = require("ws");
const crypto = require("crypto");

// Optional Stripe (server-side only; UI uses simulate-paid for now)
let stripe = null;
try {
  const Stripe = require("stripe");
  if (process.env.STRIPE_SECRET_KEY) {
    stripe = Stripe(process.env.STRIPE_SECRET_KEY);
    console.log("Stripe: enabled (STRIPE_SECRET_KEY found)");
  } else {
    console.log("Stripe: not enabled (no STRIPE_SECRET_KEY) — using simulate-paid only");
  }
} catch {
  console.log("Stripe package not available — using simulate-paid only");
}

const app = express();
app.use(cors());
app.use(express.json());

// In-memory MVP store
let requests = [];
let providers = [];
let offers = [];
let events = [];

// Settings
const HEARTBEAT_TTL_MS = 25_000;
const OFFER_TIMEOUT_MS = 20_000;
const PATIENT_CONFIRM_MS = 30_000;
const REROUTE_COOLDOWN_MS = 12_000;
const DEFAULT_CASH_AMOUNT_CENTS = 7500;

function now() { return Date.now(); }
function uid() { return crypto.randomUUID(); }

function logEvent(type, payload = {}) {
  events.unshift({ id: uid(), ts: now(), type, payload });
  if (events.length > 400) events = events.slice(0, 400);
}

function cleanProviders() {
  const cutoff = now() - HEARTBEAT_TTL_MS;
  providers = providers.filter(p => p.online && p.lastSeenAt >= cutoff);
}

function broadcast(wss, payload) {
  const msg = JSON.stringify(payload);
  wss.clients.forEach((c) => {
    if (c.readyState === 1) c.send(msg);
  });
}

function reqLabel(r) {
  if (!r) return "—";
  if (r.serviceType === "Imaging") return `Imaging · ${r.diagnosticType || "—"}`;
  if (r.serviceType === "Specialist") return `Specialist · ${r.specialtyReq || "—"}`;
  return `${r.serviceType || "Care"}${r.specialtyReq ? ` · ${r.specialtyReq}` : ""}`;
}

function providerLoad(providerId) {
  return requests.filter(r =>
    r.providerId === providerId &&
    (r.status === "ACCEPTED" || r.status === "AWAITING_CONFIRM")
  ).length;
}

function matchesProvider(r, p) {
  if (!p.online) return false;

  // payment compatibility
  if (r.paymentMode === "Insurance") {
    if (!r.insuranceCarrier) return false;
    if ((p.insurance || "").toLowerCase() === "cash") return false; // provider says cash-only
    const pi = (p.insurance || "").toLowerCase();
    const ri = (r.insuranceCarrier || "").toLowerCase();
    if (!(pi === ri || pi === "other")) return false;
  }

  // service compatibility
  const ps = (p.specialty || "").toLowerCase();
  const st = (r.serviceType || "").toLowerCase();

  if (st === "specialist") {
    const sr = (r.specialtyReq || "").toLowerCase();
    if (!sr) return false;
    return ps === sr || ps === "other";
  }

  if (st === "imaging") {
    return ps === "imaging" || ps === "other";
  }

  // PCP/Urgent/Rehab: allow exact or other; treat Primary Care as acceptable for PCP
  if (st === "primary care") return ps === "primary care" || ps === "other";
  return ps === st || ps === "other";
}

function pickBestProvider(r) {
  cleanProviders();
  const candidates = providers
    .filter(p => matchesProvider(r, p))
    .filter(p => providerLoad(p.providerId) < (Number(p.maxLoad) || 1));

  candidates.sort((a, b) => {
    const la = providerLoad(a.providerId);
    const lb = providerLoad(b.providerId);
    if (la !== lb) return la - lb;
    return b.lastSeenAt - a.lastSeenAt;
  });

  return candidates[0] || null;
}

function existingOpenOffer(requestId) {
  return offers.find(o => o.requestId === requestId && o.status === "OFFERED");
}

function createOfferForRequest(r) {
  if (r.paymentMode === "Cash" && r.cashPaid !== true) {
    r.status = "AWAITING_PAYMENT";
    logEvent("REQUEST_AWAITING_PAYMENT", { requestId: r.id });
    return null;
  }

  if (r.status !== "PENDING" && r.status !== "REROUTING") return null;

  const already = existingOpenOffer(r.id);
  if (already) return already;

  const best = pickBestProvider(r);
  if (!best) {
    r.status = "NO_MATCH";
    logEvent("NO_MATCH", { requestId: r.id, label: reqLabel(r) });
    return null;
  }

  const offer = {
    offerId: uid(),
    createdAt: now(),
    expiresAt: now() + OFFER_TIMEOUT_MS,
    requestId: r.id,
    providerId: best.providerId,
    providerName: best.providerName,
    status: "OFFERED",
  };
  offers.push(offer);

  r.status = "OFFERED";
  r.offeredProviderId = best.providerId;

  logEvent("OFFER_CREATED", { offerId: offer.offerId, requestId: r.id, providerId: best.providerId, label: reqLabel(r) });
  return offer;
}

function rerouteRequest(r, reason) {
  offers = offers.filter(o => !(o.requestId === r.id && o.status === "OFFERED"));
  r.status = "REROUTING";
  r.providerId = null;
  r.providerName = null;
  r.offeredProviderId = null;
  r.confirmBy = null;

  logEvent("REROUTE", { requestId: r.id, reason });

  setTimeout(() => {
    const rr = requests.find(x => x.id === r.id);
    if (!rr) return;
    if (rr.status !== "REROUTING") return;
    rr.status = "PENDING";
    createOfferForRequest(rr);
  }, REROUTE_COOLDOWN_MS);
}

// ---- Routes ----
app.get("/health", (_req, res) => res.json({ ok: true }));

app.get("/api/state", (_req, res) => {
  cleanProviders();
  res.json({
    requests: requests.sort((a, b) => b.createdAt - a.createdAt),
    providers,
    offers,
    events: events.slice(0, 80),
  });
});

app.get("/api/events", (_req, res) => res.json({ events: events.slice(0, 200) }));

// Provider heartbeat
app.post("/api/providers/heartbeat", (req, res) => {
  const {
    providerId,
    providerName = "Provider",
    online = false,
    specialty = "Other",
    insurance = "Other",
    language = "English",
    locationText = "",
    maxLoad = 1,
  } = req.body || {};

  const id = providerId || uid();

  const existing = providers.find(p => p.providerId === id);
  const payload = {
    providerId: id,
    providerName,
    online: !!online,
    specialty,
    insurance,
    language,
    locationText,
    maxLoad: Number(maxLoad) || 1,
    lastSeenAt: now(),
  };

  if (existing) Object.assign(existing, payload);
  else providers.push(payload);

  logEvent("PROVIDER_HEARTBEAT", { providerId: id, online: !!online, specialty, insurance });
  res.json({ ok: true, providerId: id });
});

// Create request (patient)
app.post("/api/requests", async (req, res) => {
  const {
    patientName = "Patient",
    reason = "",
    locationText = "",

    // CareX fields
    serviceType = "Specialist",  // Primary Care / Urgent Care / Specialist / Imaging / Rehab
    specialtyReq = "",
    diagnosticType = "",
    referralPresent = false,
    orderPresent = false,

    paymentMode = "Insurance",   // Insurance / Cash
    insuranceCarrier = "",
    cashAmountCents = DEFAULT_CASH_AMOUNT_CENTS,
  } = req.body || {};

  const id = uid();

  const item = {
    id,
    createdAt: now(),
    patientName,
    reason,
    locationText,

    serviceType,
    specialtyReq,
    diagnosticType,
    referralPresent: !!referralPresent,
    orderPresent: !!orderPresent,

    paymentMode,
    insuranceCarrier,

    cashAmountCents: Number(cashAmountCents) || DEFAULT_CASH_AMOUNT_CENTS,
    cashPaid: paymentMode === "Cash" ? false : null,

    status: "PENDING",
    providerId: null,
    providerName: null,
    offeredProviderId: null,
    confirmBy: null,
  };

  // server validation (MVP)
  if (item.paymentMode === "Insurance" && !item.insuranceCarrier) {
    return res.status(400).json({ error: "Insurance carrier is required for Insurance requests." });
  }
  if (item.serviceType === "Specialist" && !item.specialtyReq) {
    return res.status(400).json({ error: "Specialty is required for Specialist requests." });
  }
  if (item.serviceType === "Imaging" && !item.diagnosticType) {
    return res.status(400).json({ error: "Imaging type (CT/MRI/etc) is required." });
  }

  requests.push(item);
  logEvent("REQUEST_CREATED", { requestId: id, label: reqLabel(item), paymentMode: item.paymentMode });

  // Cash: gate by payment
  if (item.paymentMode === "Cash") {
    item.status = "AWAITING_PAYMENT";

    // Optional server-side PaymentIntent (Stripe.js UI can be added later)
    if (stripe) {
      try {
        const pi = await stripe.paymentIntents.create({
          amount: item.cashAmountCents,
          currency: "usd",
          description: `CareX ${reqLabel(item)} for ${item.patientName}`,
          metadata: { requestId: item.id },
          automatic_payment_methods: { enabled: true },
        });
        item.stripePaymentIntentId = pi.id;
        return res.json({ request: item, stripeClientSecret: pi.client_secret });
      } catch (e) {
        logEvent("STRIPE_PI_ERROR", { requestId: item.id, msg: String(e?.message || e) });
      }
    }

    return res.json({ request: item, stripeClientSecret: null });
  }

  // Insurance: dispatch immediately
  createOfferForRequest(item);
  return res.json({ request: item });
});

// Simulate cash payment (MVP)
app.post("/api/requests/:id/simulate_paid", (req, res) => {
  const r = requests.find(x => x.id === req.params.id);
  if (!r) return res.status(404).json({ error: "Not found" });
  if (r.paymentMode !== "Cash") return res.status(400).json({ error: "Not a cash request" });

  r.cashPaid = true;
  r.status = "PENDING";
  logEvent("CASH_SIMULATED_PAID", { requestId: r.id, amountCents: r.cashAmountCents });

  createOfferForRequest(r);
  return res.json({ request: r });
});

// Provider accepts offer
app.post("/api/offers/:offerId/accept", (req, res) => {
  const { providerName = "Provider" } = req.body || {};
  const o = offers.find(x => x.offerId === req.params.offerId);
  if (!o) return res.status(404).json({ error: "Offer not found" });
  if (o.status !== "OFFERED") return res.status(400).json({ error: "Offer not active" });

  const r = requests.find(x => x.id === o.requestId);
  if (!r) return res.status(404).json({ error: "Request not found" });

  o.status = "ACCEPTED";

  r.providerId = o.providerId;
  r.providerName = providerName || o.providerName;

  // Uber-style confirm step
  r.status = "AWAITING_CONFIRM";
  r.confirmBy = now() + PATIENT_CONFIRM_MS;

  logEvent("OFFER_ACCEPTED", { offerId: o.offerId, requestId: r.id, providerId: o.providerId });
  return res.json({ offer: o, request: r });
});

// Provider declines offer
app.post("/api/offers/:offerId/decline", (req, res) => {
  const o = offers.find(x => x.offerId === req.params.offerId);
  if (!o) return res.status(404).json({ error: "Offer not found" });
  if (o.status !== "OFFERED") return res.status(400).json({ error: "Offer not active" });

  o.status = "DECLINED";
  logEvent("OFFER_DECLINED", { offerId: o.offerId, requestId: o.requestId, providerId: o.providerId });

  const r = requests.find(x => x.id === o.requestId);
  if (r) rerouteRequest(r, "provider_declined");

  return res.json({ ok: true });
});

// Patient confirms
app.post("/api/requests/:id/confirm", (req, res) => {
  const r = requests.find(x => x.id === req.params.id);
  if (!r) return res.status(404).json({ error: "Not found" });
  if (r.status !== "AWAITING_CONFIRM") return res.status(400).json({ error: "Not awaiting confirm" });

  if (r.confirmBy && now() > r.confirmBy) {
    rerouteRequest(r, "patient_confirm_timeout");
    return res.status(400).json({ error: "Confirm window expired — rerouting." });
  }

  r.status = "ACCEPTED";
  r.confirmBy = null;
  logEvent("PATIENT_CONFIRMED", { requestId: r.id, providerId: r.providerId });

  return res.json({ request: r });
});

// Provider completes
app.post("/api/requests/:id/complete", (req, res) => {
  const r = requests.find(x => x.id === req.params.id);
  if (!r) return res.status(404).json({ error: "Not found" });

  r.status = "COMPLETED";
  r.confirmBy = null;

  logEvent("REQUEST_COMPLETED", { requestId: r.id, providerId: r.providerId });
  return res.json({ request: r });
});


// ---- WebSocket sync ----
const server = http.createServer(app);
const wss = new WebSocketServer({ server });

wss.on("connection", (ws) => {
  cleanProviders();
  ws.send(JSON.stringify({
    type: "SYNC",
    requests,
    providers,
    offers,
    events: events.slice(0, 60),
  }));
});

// Timers: cleanup providers, expire offers, enforce confirm window, broadcast snapshots
setInterval(() => {
  cleanProviders();
  const t = now();

  // expire offers
  for (const o of offers) {
    if (o.status === "OFFERED" && o.expiresAt <= t) {
      o.status = "EXPIRED";
      logEvent("OFFER_EXPIRED", { offerId: o.offerId, requestId: o.requestId, providerId: o.providerId });
      const r = requests.find(x => x.id === o.requestId);
      if (r && (r.status === "OFFERED" || r.status === "PENDING")) {
        rerouteRequest(r, "offer_timeout");
      }
    }
  }

  // confirm window timeout
  for (const r of requests) {
    if (r.status === "AWAITING_CONFIRM" && r.confirmBy && t > r.confirmBy) {
      rerouteRequest(r, "patient_confirm_timeout");
    }
  }

  // Keep pushing offers for PENDING requests (if none exist)
  for (const r of requests) {
    if (r.status === "PENDING") createOfferForRequest(r);
    if (r.status === "REROUTING") {/* handled by timer in rerouteRequest */}
  }

  broadcast(wss, { type: "SYNC", requests, providers, offers, events: events.slice(0, 60) });
}, 800);

const PORT = process.env.PORT || 3001;
server.listen(PORT, "0.0.0.0", () => {
  console.log(`Backend running on http://0.0.0.0:${PORT}`);
});

