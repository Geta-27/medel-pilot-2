const express = require("express");
const cors = require("cors");
const http = require("http");
const { WebSocketServer } = require("ws");
const crypto = require("crypto");

const app = express();
app.use(cors());
app.use(express.json());

let requests = [];

function broadcast(wss, payload) {
  const msg = JSON.stringify(payload);
  wss.clients.forEach((c) => {
    if (c.readyState === 1) c.send(msg);
  });
}

app.get("/health", (_req, res) => res.json({ ok: true }));

app.get("/api/requests", (_req, res) => {
  res.json({ requests: requests.sort((a, b) => b.createdAt - a.createdAt) });
});

app.post("/api/requests", (req, res) => {
  const { patientName = "Patient", reason = "", locationText = "" } = req.body || {};
  const id = crypto.randomUUID();
  const item = {
    id,
    createdAt: Date.now(),
    patientName,
    reason,
    locationText,
    status: "PENDING",
    providerName: null,
  };
  requests.push(item);
  res.json({ request: item });
});

app.post("/api/requests/:id/accept", (req, res) => {
  const { providerName = "Provider" } = req.body || {};
  const r = requests.find((x) => x.id === req.params.id);
  if (!r) return res.status(404).json({ error: "Not found" });
  if (r.status !== "PENDING") return res.status(400).json({ error: "Not pending" });
  r.status = "ACCEPTED";
  r.providerName = providerName;
  res.json({ request: r });
});

app.post("/api/requests/:id/complete", (req, res) => {
  const r = requests.find((x) => x.id === req.params.id);
  if (!r) return res.status(404).json({ error: "Not found" });
  r.status = "COMPLETED";
  res.json({ request: r });
});

const server = http.createServer(app);
const wss = new WebSocketServer({ server });

wss.on("connection", (ws) => {
  ws.send(JSON.stringify({ type: "SYNC", requests }));
});

setInterval(() => broadcast(wss, { type: "SYNC", requests }), 500);

const PORT = process.env.PORT || 3001;
server.listen(PORT, "0.0.0.0", () => {
  console.log(`Backend running on http://0.0.0.0:${PORT}`);
});
