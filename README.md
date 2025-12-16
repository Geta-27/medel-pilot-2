# MedEl Pilot — Patient + Provider (Web)

This is a minimal web pilot (Vite + React + Tailwind) that supports:

- Patient: create request, see pending/accepted/completed, matched provider card
- Provider: go online, accept pending requests, mark completed
- Live sync across devices via WebSockets (works on same Wi‑Fi)

## Run

Terminal 1:
```bash
npm install
npm run server
```

Terminal 2:
```bash
npm run dev
```

Open on Mac: http://localhost:5173

Open on iPhone (same Wi‑Fi): http://<YOUR_MAC_IP>:5173
