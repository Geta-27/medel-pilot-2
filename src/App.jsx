import React, { useEffect, useMemo, useState } from "react";

const apiBase = () =>
  import.meta.env.VITE_API_BASE || `http://${window.location.hostname}:3001`;
const wsUrl = () =>
  import.meta.env.VITE_WS_URL ||
  `${window.location.protocol === "https:" ? "wss" : "ws"}://${window.location.hostname}:3001`;

function Pill({ s }) {
  const bg = s === "PENDING" ? "#fde68a" : s === "ACCEPTED" ? "#bfdbfe" : "#bbf7d0";
  return <span style={{ background: bg, padding: "3px 8px", borderRadius: 999, fontSize: 12 }}>{s}</span>;
}

function roleFromPath() {
  const p = window.location.pathname.toLowerCase();
  if (p.startsWith("/patient")) return "PATIENT";
  if (p.startsWith("/provider")) return "PROVIDER";
  return null;
}

export default function App() {
  const [role, setRole] = useState(() => roleFromPath());
  const [wsOk, setWsOk] = useState(false);
  const [requests, setRequests] = useState([]);

  const [patientName, setPatientName] = useState("Patient");
  const [reason, setReason] = useState("");
  const [locationText, setLocationText] = useState("");
  const [myId, setMyId] = useState(null);

  const [providerName, setProviderName] = useState("Dr. MedEl");
  const [online, setOnline] = useState(false);

  const myReq = useMemo(() => (myId ? requests.find((r) => r.id === myId) : null), [requests, myId]);

  useEffect(() => {
    const onPop = () => setRole(roleFromPath());
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  }, []);

  useEffect(() => {
    const ws = new WebSocket(wsUrl());
    ws.onopen = () => setWsOk(true);
    ws.onclose = () => setWsOk(false);
    ws.onmessage = (ev) => {
      try {
        const msg = JSON.parse(ev.data);
        if (msg.type === "SYNC" && Array.isArray(msg.requests)) setRequests(msg.requests);
      } catch {}
    };
    return () => ws.close();
  }, []);

  const card = { border: "1px solid #e5e7eb", borderRadius: 14, padding: 14, background: "white" };
  const inp = { width: "100%", padding: 10, borderRadius: 10, border: "1px solid #e5e7eb", marginTop: 10 };
  const btn = (bg = "#111827") => ({ marginTop: 12, padding: "10px 12px", borderRadius: 10, border: "none", background: bg, color: "white", fontWeight: 700, cursor: "pointer" });

  async function createRequest() {
    const res = await fetch(`${apiBase()}/api/requests`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ patientName, reason, locationText }),
    });
    const data = await res.json();
    setMyId(data?.request?.id || null);
  }

  async function acceptRequest(id) {
    await fetch(`${apiBase()}/api/requests/${id}/accept`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ providerName }),
    });
  }

  async function completeRequest(id) {
    await fetch(`${apiBase()}/api/requests/${id}/complete`, { method: "POST" });
  }

  return (
    <div style={{ fontFamily: "system-ui", padding: 16, maxWidth: 760, margin: "0 auto" }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
        <h2 style={{ margin: 0 }}>MedEl</h2>
        <div style={{ fontSize: 12 }}>
          <span style={{ display: "inline-block", width: 8, height: 8, borderRadius: 99, marginRight: 8, background: wsOk ? "green" : "red" }} />
          Live {wsOk ? "ON" : "OFF"}
        </div>
      </div>

      {!role ? (
        <div style={{ marginTop: 16, display: "grid", gap: 12 }}>
          <button style={{ ...card, textAlign: "left", cursor: "pointer" }} onClick={() => { window.history.pushState({}, "", "/patient"); setRole("PATIENT"); }}>
            <div style={{ fontWeight: 700 }}>Patient</div>
            <div style={{ fontSize: 13, opacity: 0.7 }}>/patient</div>
          </button>
          <button style={{ ...card, textAlign: "left", cursor: "pointer" }} onClick={() => { window.history.pushState({}, "", "/provider"); setRole("PROVIDER"); }}>
            <div style={{ fontWeight: 700 }}>Provider</div>
            <div style={{ fontSize: 13, opacity: 0.7 }}>/provider</div>
          </button>
        </div>
      ) : role === "PATIENT" ? (
        <div style={{ marginTop: 16, ...card }}>
          <div style={{ display: "flex", justifyContent: "space-between" }}>
            <div style={{ fontWeight: 700 }}>Patient</div>
            <button style={{ border: "none", background: "transparent", textDecoration: "underline", cursor: "pointer" }} onClick={() => { window.history.pushState({}, "", "/"); setRole(null); }}>
              Switch
            </button>
          </div>

          <input style={inp} value={patientName} onChange={(e) => setPatientName(e.target.value)} placeholder="Name" />
          <input style={inp} value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Reason" />
          <input style={inp} value={locationText} onChange={(e) => setLocationText(e.target.value)} placeholder="Location (optional)" />

          <button style={{ ...btn(), opacity: myId ? 0.6 : 1 }} disabled={!!myId} onClick={createRequest}>
            {myId ? "Request Sent" : "Request Care"}
          </button>

          {myReq && (
            <div style={{ ...card, marginTop: 12, background: "#fafafa" }}>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                <div style={{ fontWeight: 700 }}>Your request</div>
                <Pill s={myReq.status} />
              </div>
              <div style={{ marginTop: 8, fontSize: 14 }}>
                <div><b>Provider:</b> {myReq.providerName || "Searching…"}</div>
                <div><b>Reason:</b> {myReq.reason || "—"}</div>
                <div><b>Location:</b> {myReq.locationText || "—"}</div>
              </div>
            </div>
          )}
        </div>
      ) : (
        <div style={{ marginTop: 16, ...card }}>
          <div style={{ display: "flex", justifyContent: "space-between" }}>
            <div style={{ fontWeight: 700 }}>Provider</div>
            <button style={{ border: "none", background: "transparent", textDecoration: "underline", cursor: "pointer" }} onClick={() => { window.history.pushState({}, "", "/"); setRole(null); }}>
              Switch
            </button>
          </div>

          <input style={inp} value={providerName} onChange={(e) => setProviderName(e.target.value)} placeholder="Provider name" />

          <button style={btn(online ? "#16a34a" : "#111827")} onClick={() => setOnline((v) => !v)}>
            {online ? "Online ✅" : "Go Online"}
          </button>

          {!online ? (
            <div style={{ marginTop: 10, opacity: 0.7 }}>Go online to accept requests.</div>
          ) : (
            <div style={{ marginTop: 12, display: "grid", gap: 10 }}>
              {requests.length === 0 && <div style={{ opacity: 0.7 }}>No requests yet.</div>}
              {requests.map((r) => (
                <div key={r.id} style={{ ...card, background: "#fafafa" }}>
                  <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                    <div style={{ fontWeight: 700 }}>{r.patientName}</div>
                    <Pill s={r.status} />
                  </div>
                  <div style={{ marginTop: 6, fontSize: 14 }}>
                    <div><b>Reason:</b> {r.reason || "—"}</div>
                    <div><b>Location:</b> {r.locationText || "—"}</div>
                  </div>
                  <div style={{ marginTop: 10, display: "flex", gap: 8 }}>
                    {r.status === "PENDING" && <button style={btn("#2563eb")} onClick={() => acceptRequest(r.id)}>Accept</button>}
                    {r.status === "ACCEPTED" && <button style={btn("#16a34a")} onClick={() => completeRequest(r.id)}>Complete</button>}
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
