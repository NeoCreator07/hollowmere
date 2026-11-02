/**
 * HOLLOWMERE — the game AND the co-op relay, in one deployment.
 *
 * Routes
 *   GET  /                → the game (hollowmere.html, bundled as a text module)
 *   GET  /favicon.ico     → the splat logo
 *   GET  /health          → {"ok":true,…} status ping for curl / uptime checks
 *   ANY  /ws/<ROOMCODE>   → WebSocket relay. Codes are 3–16 chars, case-insensitive.
 *
 * Open your worker URL in any browser and you are on the island. The game
 * auto-detects its own origin, so the WORKER RELAY co-op transport needs no
 * server URL pasted anywhere when you play from this URL.
 *
 * Rooms (Durable Object "Room")
 *   · First socket = HOST, second = GUEST; a third is refused with {t:'full'}.
 *   · welcome / join / peer / left handshake, then every other message is
 *     relayed VERBATIM between the two sockets — the worker never inspects
 *     the gameplay protocol.
 *   · Uses the WebSocket Hibernation API: rooms survive isolate evictions
 *     and idle rooms cost nothing.
 *
 * Deploy: keep worker.js, hollowmere.html and wrangler.toml in one folder,
 *         then  npx wrangler deploy
 */

import GAME_HTML from "./hollowmere.html";

const ROOM_LIMIT = 2;
const CODE_RE = /^\/ws\/([A-Za-z0-9-]{3,16})\/?$/;
const json = o => JSON.stringify(o);

const FAVICON = `<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 64 64'><rect width='64' height='64' rx='14' fill='#0d1214'/><g fill='#c4452d'><circle cx='32' cy='36' r='13'/><circle cx='21' cy='30' r='7'/><circle cx='43' cy='30' r='8'/><circle cx='44' cy='44' r='7'/><circle cx='22' cy='43' r='6.5'/><circle cx='32' cy='22' r='6'/><circle cx='33' cy='50' r='5.5'/><circle cx='14' cy='49' r='3.4'/><circle cx='52' cy='38' r='2.6'/><circle cx='26' cy='55' r='2.2'/></g><circle cx='27' cy='31' r='3.6' fill='#e0654a' opacity='.85'/><circle cx='50' cy='18' r='4.6' fill='#e4dfd0'/><circle cx='56' cy='12' r='2' fill='#e4dfd0' opacity='.65'/><circle cx='60' cy='7' r='1.3' fill='#e4dfd0' opacity='.4'/></svg>`;

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

    /* The game itself — this is what greets you when you open the worker. */
    if (url.pathname === '/' || url.pathname === '/index.html')
      return new Response(GAME_HTML, {
        headers: {
          'content-type': 'text/html;charset=utf-8',
          'cache-control': 'no-cache',
          'referrer-policy': 'no-referrer',
        },
      });

    if (url.pathname === '/favicon.ico')
      return new Response(FAVICON, {
        headers: {
          'content-type': 'image/svg+xml',
          'cache-control': 'public,max-age=86400',
        },
      });

    /* Status ping — moved here so / could become the game. */
    if (url.pathname === '/health')
      return new Response(
        json({ ok: true, service: 'hollowmere-relay', game: '/', ws: '/ws/<ROOMCODE>' }),
        { headers: { 'content-type': 'application/json' } });

    const m = url.pathname.match(CODE_RE);
    if (!m)
      return new Response('Not found. Open / to play, or connect with wss://<host>/ws/<ROOMCODE>.', { status: 404 });

    const room = m[1].toUpperCase();
    const stub = env.ROOM.get(env.ROOM.idFromName(room));
    return stub.fetch(request);
  },
};
