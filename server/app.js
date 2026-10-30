import http from 'node:http';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Server } from 'socket.io';
import { RoomManager, sanitizeName, normalizeCode, MAX_PLAYERS } from './rooms.js';

const PUBLIC_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'public');
const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png',
  '.json': 'application/json', '.ico': 'image/x-icon', '.webmanifest': 'application/manifest+json',
};

export function createApp({ clock = () => Date.now(), tickMs = 200 } = {}) {
  const rooms = new RoomManager();

  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url, 'http://x');
      if (url.pathname === '/healthz') { res.writeHead(200, { 'content-type': 'text/plain' }); return res.end('ok'); }
      // /sala/ABCDE y /?sala=ABCDE sirven la misma página
      let rel = url.pathname.startsWith('/sala/') ? '/index.html' : url.pathname;
      if (rel === '/') rel = '/index.html';
      const file = path.normalize(path.join(PUBLIC_DIR, rel));
      if (!file.startsWith(PUBLIC_DIR)) { res.writeHead(403); return res.end(); }
      const data = await readFile(file);
      res.writeHead(200, {
        'content-type': MIME[path.extname(file)] || 'application/octet-stream',
        'cache-control': 'no-cache',
        'x-content-type-options': 'nosniff',
      });
      res.end(data);
    } catch {
      res.writeHead(404, { 'content-type': 'text/plain' });
      res.end('No encontrado');
    }
  });

  const io = new Server(server, { cors: { origin: false }, pingInterval: 5000, pingTimeout: 8000, maxHttpBufferSize: 1e4 });

  const socketOf = (p) => (p.socketId ? io.sockets.sockets.get(p.socketId) : null);

  function flushFx(room) {
    if (!room.game) return;
    for (const f of room.game.drainFx()) {
      const targets = f.to === 'all' ? [...room.players.keys()] : f.to;
      for (const pid of new Set(targets)) {
        const p = room.players.get(pid);
        const s = p && socketOf(p);
        if (s) s.emit('fx', { type: f.type, data: f.data });
      }
    }
  }

  function push(room) {
    const now = clock();
    flushFx(room);
    for (const p of room.players.values()) {
      const s = p.connected && socketOf(p);
      if (s) s.emit('state', room.viewFor(p.id, now));
    }
  }

  function bucket(rate = 40) {
    let tokens = rate, last = Date.now();
    return () => {
      const t = Date.now();
      tokens = Math.min(rate, tokens + ((t - last) / 1000) * rate);
      last = t;
      if (tokens < 1) return false;
      tokens -= 1;
      return true;
    };
  }

  io.on('connection', (socket) => {
    let ctx = null; // { room, pid }
    const allow = bucket();

    const on = (event, fn) => socket.on(event, (payload, ack) => {
      if (typeof ack !== 'function') ack = () => {};
      if (!allow()) return ack({ ok: false, error: 'Demasiadas acciones, más despacio' });
      try { fn(payload && typeof payload === 'object' ? payload : {}, ack); }
      catch (err) { console.error(err); ack({ ok: false, error: 'Error interno' }); }
    });

    function attach(room, player) {
      const old = player.socketId && player.socketId !== socket.id ? socketOf(player) : null;
      if (old) { old.emit('replaced'); old.data.detached = true; old.disconnect(true); }
      player.socketId = socket.id;
      player.connected = true;
      player.lastSeen = clock();
      ctx = { room, pid: player.id };
      socket.join(room.code);
      room.ensureHost();
    }

    on('room:create', ({ name }, ack) => {
      name = sanitizeName(name);
      if (!name) return ack({ ok: false, error: 'Escribe un nombre' });
      const room = rooms.create(clock());
      const p = room.addPlayer(name, clock());
      attach(room, p);
      ack({ ok: true, code: room.code, token: p.token });
      push(room);
    });

    on('room:join', ({ code, name }, ack) => {
      name = sanitizeName(name);
      if (!name) return ack({ ok: false, error: 'Escribe un nombre' });
      const room = rooms.get(code);
      if (!room) return ack({ ok: false, error: 'Esa sala no existe' });
      if (room.game) return ack({ ok: false, error: 'La partida ya ha empezado' });
      if (room.players.size >= MAX_PLAYERS) return ack({ ok: false, error: 'La sala está llena (máx. 8)' });
      const p = room.addPlayer(name, clock());
      attach(room, p);
      ack({ ok: true, code: room.code, token: p.token });
      push(room);
    });

    on('room:rejoin', ({ code, token }, ack) => {
      const room = rooms.get(code);
      const p = room && room.findByToken(token);
      if (!p) return ack({ ok: false, error: 'La sesión ya no es válida' });
      attach(room, p);
      ack({ ok: true, code: room.code });
      push(room);
    });

    on('room:settings', (s, ack) => {
      if (!ctx || ctx.room.hostId !== ctx.pid || ctx.room.game) return ack({ ok: false });
      ctx.room.setSettings(s);
      ack({ ok: true });
      push(ctx.room);
    });

    on('room:start', (_, ack) => {
      const room = ctx?.room;
      if (!room || room.hostId !== ctx.pid || room.game) return ack({ ok: false, error: 'No puedes iniciar' });
      if (!room.canStart()) return ack({ ok: false, error: 'Hacen falta entre 3 y 8 jugadores conectados' });
      room.start(clock());
      ack({ ok: true });
      push(room);
    });

    on('game:move', ({ dir }, ack) => {
      const g = ctx?.room.game;
      if (!g) return ack({ ok: false });
      const moved = g.move(ctx.pid, dir, clock());
      ack({ ok: moved });
      if (moved) push(ctx.room);
    });

    on('game:ability', ({ type }, ack) => {
      const g = ctx?.room.game;
      if (!g) return ack({ ok: false });
      const done = g.ability(ctx.pid, type, clock());
      ack({ ok: done });
      if (done) push(ctx.room);
    });

    on('game:skip', (_, ack) => {
      const room = ctx?.room;
      if (!room?.game || room.hostId !== ctx.pid) return ack({ ok: false });
      const done = room.game.advance(clock());
      ack({ ok: done });
      if (done) push(room);
    });

    on('room:rematch', (_, ack) => {
      const room = ctx?.room;
      if (!room?.game || room.hostId !== ctx.pid || room.game.phase !== 'final') return ack({ ok: false });
      room.backToLobby();
      ack({ ok: true });
      push(room);
    });

    on('room:leave', (_, ack) => {
      if (!ctx) return ack({ ok: true });
      const { room, pid } = ctx;
      if (!room.game) { room.players.delete(pid); room.lobbyVersion++; }
      const p = room.players.get(pid);
      if (p) { p.connected = false; p.socketId = null; p.lastSeen = clock(); }
      socket.leave(room.code);
      room.ensureHost();
      ctx = null;
      ack({ ok: true });
      push(room);
    });

    socket.on('disconnect', () => {
      if (!ctx) return;
      const { room, pid } = ctx;
      const p = room.players.get(pid);
      if (p && p.socketId === socket.id) {
        p.connected = false; p.socketId = null; p.lastSeen = clock();
        room.ensureHost();
        push(room);
      }
    });
  });

  const lastBeat = new Map();
  const interval = setInterval(() => {
    const now = clock();
    for (const room of rooms.sweep(now)) push(room);
    for (const room of rooms.rooms.values()) {
      const g = room.game;
      if (!g) continue;
      const before = g.version;
      g.tick(now);
      const beat = now - (lastBeat.get(room.code) || 0) >= 1000;
      if (g.version !== before || beat) {
        if (beat) lastBeat.set(room.code, now);
        push(room);
      }
    }
  }, tickMs);
  interval.unref?.();

  return {
    server, io, rooms,
    listen: (port) => new Promise((resolve) => server.listen(port, () => resolve(server.address().port))),
    close: () => new Promise((resolve) => { clearInterval(interval); io.close(() => resolve()); }),
  };
}
