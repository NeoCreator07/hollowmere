/**
 * HOLLOWMERE — online co-op relay
 * Cloudflare Worker + Durable Object ("Room")
 *
 * Endpoints
 *   GET  /               → service status (JSON)
 *   GET  /health         → service status (JSON)
 *   ANY  /ws/<ROOMCODE>  → WebSocket upgrade. Room codes are 3–16 chars,
 *                          case-insensitive (normalised to upper-case).
 *
 * Room behaviour
 *   · First socket to open a room becomes HOST, the second GUEST.
 *   · A third connection is accepted, told {t:'full'}, and closed.
 *   · On connect the server sends  {t:'welcome', id, role}.
 *   · Clients send {t:'join', name} once connected; when both players have
 *     joined, both receive {t:'peer', name:<other player's name>}.
 *   · Every other message is relayed VERBATIM to the other socket — the game
 *     protocol (positions, shots, state snapshots) is peer-to-peer over this
 *     pipe; the worker never inspects it.
 *   · {t:'ping'} → {t:'pong'} keep-alive (not relayed).
 *   · On disconnect the survivor receives {t:'left', name}.
 *
 * Uses the WebSocket Hibernation API, so rooms survive isolate evictions and
 * you do not pay for idle wall-clock time. Socket attachments carry each
 * player's {id, role, name} across hibernation.
 *
 * Deploy:  npx wrangler deploy        (wrangler.toml included)
 * Local:   npx wrangler dev  →  ws://127.0.0.1:8787/ws/<CODE>
 */

const ROOM_LIMIT = 2;
const CODE_RE = /^\/ws\/([A-Za-z0-9-]{3,16})\/?$/;
const json = o => JSON.stringify(o);

export class Room {
  constructor(state, env) {
    this.state = state;
    this.env = env;
  }

  /** A new client wants in. Assign role by occupancy and say hello. */
  async fetch(request) {
    if (request.headers.get('Upgrade') !== 'websocket')
      return new Response('This endpoint expects a WebSocket upgrade.', { status: 426 });

    const existing = this.state.getWebSockets();
    const pair = new WebSocketPair();

    if (existing.length >= ROOM_LIMIT) {
      this.state.acceptWebSocket(pair[1]);
      pair[1].send(json({ t: 'full' }));
      pair[1].close(4000, 'room full');
      return new Response(null, { status: 101, webSocket: pair[0] });
    }

    const role = existing.length === 0 ? 'host' : 'guest';
    const id = crypto.randomUUID();
    this.state.acceptWebSocket(pair[1]);
    this.state.serializeAttachment(pair[1], { id, role, name: '' });
    pair[1].send(json({ t: 'welcome', id, role }));
    return new Response(null, { status: 101, webSocket: pair[0] });
  }

  meta(ws) {
    return this.state.deserializeAttachment(ws) || { id: '', role: 'guest', name: '' };
  }

  /** Once both sockets have names, introduce them to each other. */
  greetIfPaired() {
    const players = this.state.getWebSockets();
    if (players.length !== ROOM_LIMIT) return;
    const a = this.meta(players[0]);
    const b = this.meta(players[1]);
    if (!a.name || !b.name) return;
    players[0].send(json({ t: 'peer', name: b.name }));
    players[1].send(json({ t: 'peer', name: a.name }));
  }

  async webSocketMessage(ws, message) {
    if (typeof message !== 'string' || message.length === 0) return;
    let m;
    try { m = JSON.parse(message); } catch { return; }

    if (m.t === 'join') {
      const meta = this.meta(ws);
      meta.name = String(m.name || 'PLAYER').slice(0, 12).toUpperCase();
      this.state.serializeAttachment(ws, meta);
      this.greetIfPaired();
      return;
    }
    if (m.t === 'ping') { ws.send(json({ t: 'pong' })); return; }

    /* Relay everything else, untouched, to the other player. */
    for (const other of this.state.getWebSockets()) {
      if (other === ws) continue;
      try { other.send(message); } catch (e) { /* peer vanished; close will fire */ }
    }
  }

  async webSocketClose(ws) { this.notifyExit(ws); }
  async webSocketError(ws) { try { ws.close(1011, 'socket error'); } catch (e) {} }

  notifyExit(ws) {
    const meta = this.meta(ws);
    for (const other of this.state.getWebSockets()) {
      if (other === ws) continue;
      try { other.send(json({ t: 'left', name: meta.name })); } catch (e) {}
    }
  }
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname === '/' || url.pathname === '/health')
      return new Response(
        json({ ok: true, service: 'hollowmere-relay', ws: '/ws/<ROOMCODE>' }),
        { headers: { 'content-type': 'application/json' } });

    const m = url.pathname.match(CODE_RE);
    if (!m)
      return new Response('Not found. Connect with  wss://<host>/ws/<ROOMCODE>', { status: 404 });

    const room = m[1].toUpperCase();
    const stub = env.ROOM.get(env.ROOM.idFromName(room));
    return stub.fetch(request);
  },
};
