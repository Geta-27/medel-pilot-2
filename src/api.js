const hostname = window.location.hostname
const API_BASE = `http://${hostname}:3001`

export async function apiGet(path) {
  const res = await fetch(`${API_BASE}${path}`)
  if (!res.ok) throw new Error(await res.text())
  return res.json()
}

export async function apiPost(path, body) {
  const res = await fetch(`${API_BASE}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body ?? {}),
  })
  if (!res.ok) throw new Error(await res.text())
  return res.json()
}

export function makeWs(onMessage) {
  const wsUrl = `ws://${hostname}:3001`
  const ws = new WebSocket(wsUrl)
  ws.onmessage = (ev) => {
    try { onMessage(JSON.parse(ev.data)) } catch {}
  }
  return ws
}
