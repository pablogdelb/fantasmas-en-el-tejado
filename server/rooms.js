import { randomBytes } from 'node:crypto';
import { Game } from './game.js';

export const MIN_PLAYERS = 3;     // recomendado 6-8; 3 permite probar
export const MAX_PLAYERS = 8;
export const RECONNECT_MS = 60_000;
export const ROOM_IDLE_MS = 10 * 60_000;
const CODE_CHARS = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
const ROUND_SECONDS = [60, 90, 120];
const COLORS = ['#ff4d6d', '#4dc3ff', '#ffd23f', '#6bff8a', '#c77dff', '#ff9a3c', '#3cf2d0', '#f58cff'];

export function sanitizeName(raw) {
  if (typeof raw !== 'string') return '';
  return raw.replace(/[\u0000-\u001f\u007f<>]/g, '').replace(/\s+/g, ' ').trim().slice(0, 14);
}

export function normalizeCode(raw) {
  return typeof raw === 'string' ? raw.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 5) : '';
}

export class Room {
  constructor(code) {
    this.code = code;
    this.players = new Map();   // id -> {id,name,token,socketId,connected,lastSeen,color}
    this.hostId = null;
    this.settings = { roundSeconds: 90, cycles: 1 };
    this.game = null;           // null = lobby
    this.createdAt = Date.now();
    this.lobbyVersion = 0;
  }

  get connectedCount() { let n = 0; for (const p of this.players.values()) if (p.connected) n++; return n; }

  addPlayer(name, now) {
    const used = new Set([...this.players.values()].map((p) => p.color));
    const color = COLORS.find((c) => !used.has(c)) || COLORS[this.players.size % COLORS.length];
    const p = {
      id: randomBytes(6).toString('hex'),
      name: this.uniqueName(name),
      token: randomBytes(24).toString('hex'),
      socketId: null, connected: false, lastSeen: now, color,
    };
    this.players.set(p.id, p);
    if (!this.hostId) this.hostId = p.id;
    this.lobbyVersion++;
    return p;
  }

  uniqueName(name) {
    const taken = new Set([...this.players.values()].map((p) => p.name.toLowerCase()));
    if (!taken.has(name.toLowerCase())) return name;
    for (let i = 2; i < 20; i++) {
      const n = `${name.slice(0, 12)}${i}`;
      if (!taken.has(n.toLowerCase())) return n;
    }
    return name + randomBytes(1).toString('hex');
  }

  findByToken(token) {
    if (typeof token !== 'string') return null;
    for (const p of this.players.values()) if (p.token === token) return p;
    return null;
  }

  /** Si el anfitrión se va, el siguiente jugador conectado toma el mando. */
  ensureHost() {
    const host = this.players.get(this.hostId);
    if (host && host.connected) return;
    const next = [...this.players.values()].find((p) => p.connected);
    if (next && next.id !== this.hostId) { this.hostId = next.id; this.lobbyVersion++; }
  }

  setSettings(s) {
    if (ROUND_SECONDS.includes(s.roundSeconds)) this.settings.roundSeconds = s.roundSeconds;
    if (s.cycles === 1 || s.cycles === 2) this.settings.cycles = s.cycles;
    this.lobbyVersion++;
  }

  canStart() {
    const n = this.players.size;
    return n >= MIN_PLAYERS && n <= MAX_PLAYERS && [...this.players.values()].filter((p) => p.connected).length >= MIN_PLAYERS;
  }

  start(now) {
    this.game = new Game([...this.players.values()], { ...this.settings }, now, (id) => !!this.players.get(id)?.connected);
  }

  backToLobby() { this.game = null; this.lobbyVersion++; }

  /** Vista pública de la sala (sin información de partida). */
  publicPlayers() {
    return [...this.players.values()].map((p) => ({
      id: p.id, name: p.name, color: p.color, connected: p.connected, isHost: p.id === this.hostId,
    }));
  }

  viewFor(pid, now) {
    const me = this.players.get(pid);
    const base = {
      code: this.code,
      you: { id: pid, name: me?.name, isHost: pid === this.hostId },
      players: this.publicPlayers(),
      settings: this.settings,
      limits: { min: MIN_PLAYERS, max: MAX_PLAYERS },
      serverNow: now,
    };
    if (!this.game) return { ...base, phase: 'lobby', canStart: this.canStart() };
    return { ...base, ...this.game.viewFor(pid, now) };
  }
}

export class RoomManager {
  constructor() { this.rooms = new Map(); }

  create(now = Date.now()) {
    let code;
    do {
      code = Array.from(randomBytes(5), (b) => CODE_CHARS[b % CODE_CHARS.length]).join('');
    } while (this.rooms.has(code));
    const room = new Room(code);
    room.createdAt = now;
    this.rooms.set(code, room);
    return room;
  }

  get(code) { return this.rooms.get(normalizeCode(code)) || null; }

  /** Limpieza: expulsa jugadores ausentes del lobby y borra salas abandonadas. */
  sweep(now = Date.now()) {
    const changed = [];
    for (const [code, room] of this.rooms) {
      if (!room.game) {
        for (const p of [...room.players.values()]) {
          if (!p.connected && now - p.lastSeen > RECONNECT_MS) {
            room.players.delete(p.id);
            room.lobbyVersion++;
            changed.push(room);
          }
        }
        room.ensureHost();
      }
      const idle = [...room.players.values()].every((p) => !p.connected && now - p.lastSeen > ROOM_IDLE_MS);
      if (room.players.size === 0 || idle) this.rooms.delete(code);
    }
    return changed;
  }
}
