const http = require("http");
const crypto = require("crypto");
const express = require("express");
const cors = require("cors");
const { WebSocketServer } = require("ws");

const app = express();
app.use(cors());
app.use(express.json());

const now = () => Date.now();

// -------- Tunables ----------
const ASSIGN_TTL_MS = 20000;      // offer expires in 20s → reroute
const STALE_PROVIDER_MS = 20000;  // provider must heartbeat within 20s

// -------- State (in-memory) ----------
const providers = []; // {id,name,online,maxLoad,insurance,language,specialty,locationText,lastSeen,busyUntil,load}
const requests = [];  // {id,createdAt,patientName,reason,locationText,insurance,language,specialty,status,assignedProviderId,providerName,assignedAt,assignExpiresAt,reroutes,triedProviderIds}

function norm(x) { return (x ?? "").toString().trim(); }

function isProviderOnline(p) {
  if (!p.online) return false;
  if (!p.lastSeen || (now() - p.lastSeen) > STALE_PROVIDER_MS) return false;
  if (p.busyUntil && now() < p.busyUntil) return false;
  return true;
}

function providerLoad(id) {
  // count assigned/accepted as active; keep also p.load for quick UI
  return requests.filter(r =>
    r.assignedProviderId === id &&
    (r.status === "ASSIGNED" || r.status === "ACCEPTED")
  ).length;
}

function matchesFilters(r, p) {
  // If request specifies a filter, provider must match it (exact match, case-insensitive).
  const ri = norm(r.insurance).toLowerCase();
  const rl = norm(r.language).toLowerCase();
  const rs = norm(r.specialty).toLowerCase();

  const pi = norm(p.insurance).toLowerCase();
  const pl = norm(p.language).toLowerCase();
  const ps = norm(p.specialty).toLowerCase();

  if (ri && ri !== pi) return false;
  if (rl && rl !== pl) return false;
  if (rs && rs !== ps) return false;

  return true;
}



