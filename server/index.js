import express from 'express'
import cors from 'cors'
import { WebSocketServer } from 'ws'
import http from 'http'
import { randomUUID } from 'crypto'

const PORT = process.env.PORT ? Number(process.env.PORT) : 3001

const app = express()
app.use(cors())
app.use(express.json())

const requests = []
const providers = new Map() // name -> { online: boolean, lastSeen: number }

function broadcast(payload) {
  const msg = JSON.stringify(payload)
  for (const client of app.locals.wss.clients) {
    if (client.readyState === 1) client.send(msg)
  }
}

function view(r) {
  return {
    id: r.id,
    createdAt: r.createdAt,
    specialty: r.specialty,
    note: r.note,
    status: r.status,
    providerName: r.providerName ?? null,
    etaMin: r.etaMin ?? null,
  }
}

app.get('/api/health', (_req, res) => res.json({ ok: true }))

app.get('/api/requests', (_req, res) => res.json(requests.map(view)))

app.post('/api/requests', (req, res) => {
  const { specialty, note } = req.body ?? {}
  if (!specialty) return res.status(400).send('specialty is required')
  const r = {
    id: randomUUID(),
    createdAt: Date.now(),
    specialty: String(specialty),
    note: note ? String(note).slice(0, 500) : '',
    status: 'pending',
    providerName: null,
    etaMin: null,
  }
  requests.push(r)
  res.json(view(r))
  broadcast({ type: 'update' })
})

app.post('/api/providers/status', (req, res) => {
  const { name, online } = req.body ?? {}
  if (!name) return res.status(400).send('name is required')
  providers.set(String(name), { online: Boolean(online), lastSeen: Date.now() })
  res.json({ ok: true })
  broadcast({ type: 'update' })
})

app.post('/api/requests/:id/accept', (req, res) => {
  const id = req.params.id
  const { providerName } = req.body ?? {}
  if (!providerName) return res.status(400).send('providerName is required')

  const r = requests.find((x) => x.id === id)
  if (!r) return res.status(404).send('not found')
  if (r.status !== 'pending') return res.status(409).send('request not pending')

  const p = providers.get(String(providerName))
  if (p && !p.online) return res.status(409).send('provider offline')

  r.status = 'accepted'
  r.providerName = String(providerName)
  r.etaMin = 12
  res.json(view(r))
  broadcast({ type: 'update' })
})

app.post('/api/requests/:id/complete', (req, res) => {
  const id = req.params.id
  const r = requests.find((x) => x.id === id)
  if (!r) return res.status(404).send('not found')
  if (r.status !== 'accepted') return res.status(409).send('request not accepted')

  r.status = 'completed'
  res.json(view(r))
  broadcast({ type: 'update' })
})

app.post('/api/requests/:id/cancel', (req, res) => {
  const id = req.params.id
  const r = requests.find((x) => x.id === id)
  if (!r) return res.status(404).send('not found')
  if (r.status !== 'pending') return res.status(409).send('only pending can cancel')

  r.status = 'canceled'
  res.json(view(r))
  broadcast({ type: 'update' })
})

const server = http.createServer(app)
const wss = new WebSocketServer({ server })
app.locals.wss = wss

wss.on('connection', (ws) => {
  ws.send(JSON.stringify({ type: 'hello', ts: Date.now() }))
})

server.listen(PORT, '0.0.0.0', () => {
  console.log(`MedEl demo backend running on http://0.0.0.0:${PORT}`)
})
