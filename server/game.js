import { generateMap, mapToRows, bfs } from './map.js';
import { mulberry32, shuffle, hashSeed } from './rng.js';

export const CFG = {
  VISION: 2,               // radio (Manhattan) en el que un cazador ve entidades
  HUNTER_MOVE_MS: 280,
  GHOST_MOVE_MS: 190,
  SCARE_RADIUS: 2,
  SCARE_FREEZE_MS: 4000,
  SCARE_CD_MS: 14000,
  TRAP_CD_MS: 8000,
  TRAP_STUN_MS: 3000,
  MAX_TRAPS: 2,
  FLASH_RADIUS: 4,
  FLASH_REVEAL_MS: 2000,
  FLASH_CD_MS: 18000,
  FLASH_SELF_FREEZE_MS: 800,
  TRAIL_MS: 7000,
  COUNTDOWN_MS: 5000,
  ROUND_END_MS: 12000,
  GHOST_ABANDON_MS: 20000,
  HEAT_STEPS: [7, 5, 3, 1], // distancia (camino) máxima para calor 1, 2, 3 y 4
};

export const DIRS = {
  up: [0, -1],
  down: [0, 1],
  left: [-1, 0],
  right: [1, 0],
};

const manhattan = (a, b) => Math.abs(a.x - b.x) + Math.abs(a.y - b.y);

export function ghostCountFor(n) {
  return n >= 7 ? 2 : 1;
}

export function mapSizeFor(n) {
  return n >= 7 ? 13 : 11;
}

/**
 * Partida completa (varias rondas). Lógica pura: no sabe nada de sockets.
 * El tiempo se pasa siempre como `now` (ms) para poder probarla sin relojes reales.
 */
export class Game {
  /**
   * @param {{id:string,name:string}[]} players
   * @param {{roundSeconds:number,cycles:number,seed?:number}} settings
   * @param {(id:string)=>boolean} isConnected
   */
  constructor(players, settings, now, isConnected = () => true) {
    this.playerIds = players.map((p) => p.id);
    this.settings = settings;
    this.isConnected = isConnected;
    this.seed = settings.seed ?? ((Math.random() * 2 ** 32) >>> 0);
    this.ghostCount = ghostCountFor(players.length);
    const rnd = mulberry32(this.seed);
    this.order = shuffle(this.playerIds, rnd);
    const perCycle = Math.ceil(players.length / this.ghostCount);
    this.totalRounds = perCycle * settings.cycles;
    this.scores = new Map(this.playerIds.map((id) => [id, 0]));
    this.fx = [];
    this.version = 0;
    this.roundIndex = -1;
    this.phase = 'countdown';
    this.startRound(0, now);
  }

  // ------------------------------------------------------------------ rondas
  startRound(index, now) {
    this.roundIndex = index;
    const n = this.playerIds.length;
    const ghostIds = [];
    for (let k = 0; k < this.ghostCount; k++) ghostIds.push(this.order[(index * this.ghostCount + k) % n]);
    const hunterIds = this.playerIds.filter((id) => !ghostIds.includes(id));
    const size = mapSizeFor(n);
    const { map, hunterSpawns, ghostSpawns } = generateMap(
      hashSeed(this.seed, index + 1), size, size, hunterIds.length, ghostIds.length,
    );
    const ents = new Map();
    hunterIds.forEach((id, i) => ents.set(id, {
      id, role: 'hunter', ...hunterSpawns[i],
      nextMoveAt: 0, frozenUntil: 0, flashReadyAt: 0, revealUntil: 0,
    }));
    ghostIds.forEach((id, i) => ents.set(id, {
      id, role: 'ghost', ...ghostSpawns[i],
      nextMoveAt: 0, scareReadyAt: 0, trapReadyAt: 0,
      caught: false, caughtAt: 0, caughtBy: null, trail: [], gain: 0,
    }));
    this.round = {
      index, map, rows: mapToRows(map), ents, ghostIds, hunterIds,
      traps: [], gains: new Map(this.playerIds.map((id) => [id, 0])),
      startsAt: now + CFG.COUNTDOWN_MS,
      playingAt: now + CFG.COUNTDOWN_MS,
      endsAt: now + CFG.COUNTDOWN_MS + this.settings.roundSeconds * 1000,
      result: null, nextAt: 0, ghostGoneSince: new Map(), distCache: null, posVersion: 0,
    };
    this.phase = 'countdown';
    this.bump();
  }

  bump() { this.version++; }

  drainFx() { const f = this.fx; this.fx = []; return f; }

  addGain(id, pts) {
    this.round.gains.set(id, (this.round.gains.get(id) || 0) + pts);
    this.scores.set(id, (this.scores.get(id) || 0) + pts);
  }

  /** Avanza el reloj de la partida. Devuelve true si el estado cambió. */
  tick(now) {
    const r = this.round;
    if (this.phase === 'countdown') {
      if (now >= r.startsAt) { this.phase = 'playing'; this.bump(); return true; }
    } else if (this.phase === 'playing') {
      // Fantasma desconectado demasiado tiempo: se da por abandonado
      for (const gid of r.ghostIds) {
        const g = r.ents.get(gid);
        if (g.caught) continue;
        if (this.isConnected(gid)) r.ghostGoneSince.delete(gid);
        else {
          if (!r.ghostGoneSince.has(gid)) r.ghostGoneSince.set(gid, now);
          if (now - r.ghostGoneSince.get(gid) >= CFG.GHOST_ABANDON_MS) {
            g.caught = true; g.caughtAt = now; g.caughtBy = null; g.abandoned = true;
            this.fx.push({ to: 'all', type: 'abandoned', data: { id: gid } });
          }
        }
      }
      if (r.ghostIds.every((id) => r.ents.get(id).caught)) { this.finishRound(now, 'caught'); return true; }
      if (now >= r.endsAt) { this.finishRound(now, 'time'); return true; }
    } else if (this.phase === 'roundEnd') {
      if (now >= r.nextAt) { this.advance(now); return true; }
    }
    return false;
  }

  finishRound(now, reason) {
    const r = this.round;
    const end = Math.min(now, r.endsAt);
    for (const gid of r.ghostIds) {
      const g = r.ents.get(gid);
      const until = g.caught ? g.caughtAt : end;
      const survived = Math.max(0, Math.floor((until - r.playingAt) / 1000));
      this.addGain(gid, survived + (g.caught ? 0 : 40));
    }
    if (reason === 'caught') for (const hid of r.hunterIds) this.addGain(hid, 20);
    r.result = {
      reason,
      ghosts: r.ghostIds.map((id) => {
        const g = r.ents.get(id);
        return { id, caught: g.caught, caughtBy: g.caughtBy, abandoned: !!g.abandoned,
          survivedSec: Math.max(0, Math.floor(((g.caught ? g.caughtAt : end) - r.playingAt) / 1000)) };
      }),
      gains: Object.fromEntries(r.gains),
    };
    this.phase = 'roundEnd';
    r.nextAt = now + CFG.ROUND_END_MS;
    this.fx.push({ to: 'all', type: 'roundEnd', data: { reason } });
    this.bump();
  }

  /** Pasa a la siguiente ronda o termina la partida. */
  advance(now) {
    if (this.phase !== 'roundEnd') return false;
    if (this.roundIndex + 1 >= this.totalRounds) {
      this.phase = 'final';
      this.fx.push({ to: 'all', type: 'final', data: {} });
      this.bump();
    } else this.startRound(this.roundIndex + 1, now);
    return true;
  }

  // ------------------------------------------------------------ acciones
  isFree(x, y, exceptId) {
    const { map, ents } = this.round;
    if (x < 0 || y < 0 || x >= map.w || y >= map.h) return false;
    if (map.walls[y * map.w + x]) return false;
    for (const e of ents.values()) if (e.id !== exceptId && !(e.role === 'ghost' && e.caught) && e.x === x && e.y === y) return false;
    return true;
  }

  move(pid, dir, now) {
    if (this.phase !== 'playing' || !DIRS[dir]) return false;
    const r = this.round;
    const e = r.ents.get(pid);
    if (!e || (e.role === 'ghost' && e.caught)) return false;
    if (now < e.nextMoveAt) return false;
    if (e.role === 'hunter' && now < e.frozenUntil) return false;
    const [dx, dy] = DIRS[dir];
    const nx = e.x + dx, ny = e.y + dy;
    const { map } = r;
    if (nx < 0 || ny < 0 || nx >= map.w || ny >= map.h || map.walls[ny * map.w + nx]) return false;

    if (e.role === 'hunter') {
      // ¿Hay un fantasma activo? -> captura
      for (const gid of r.ghostIds) {
        const g = r.ents.get(gid);
        if (!g.caught && g.x === nx && g.y === ny) {
          g.caught = true; g.caughtAt = now; g.caughtBy = pid;
          const remaining = Math.max(0, Math.floor((r.endsAt - now) / 1000));
          this.addGain(pid, 100 + remaining);
          e.x = nx; e.y = ny; e.nextMoveAt = now + CFG.HUNTER_MOVE_MS;
          this.fx.push({ to: 'all', type: 'caught', data: { ghost: gid, by: pid } });
          r.posVersion++;
          if (r.ghostIds.every((id) => r.ents.get(id).caught)) this.finishRound(now, 'caught');
          this.bump();
          return true;
        }
      }
      if (!this.isFree(nx, ny, pid)) return false; // otro cazador
      e.x = nx; e.y = ny; e.nextMoveAt = now + CFG.HUNTER_MOVE_MS;
      const ti = r.traps.findIndex((t) => t.x === nx && t.y === ny);
      if (ti !== -1) {
        const [trap] = r.traps.splice(ti, 1);
        e.frozenUntil = now + CFG.TRAP_STUN_MS;
        const owner = r.ents.get(trap.owner);
        if (owner) { owner.gain += 10; this.addGain(trap.owner, 10); }
        this.fx.push({ to: [pid, trap.owner], type: 'trapped', data: { hunter: pid } });
      }
    } else {
      if (!this.isFree(nx, ny, pid)) return false; // muro, cazador u otro fantasma
      e.trail.push({ x: e.x, y: e.y, t: now });
      if (e.trail.length > 24) e.trail.shift();
      e.x = nx; e.y = ny; e.nextMoveAt = now + CFG.GHOST_MOVE_MS;
    }
    r.posVersion++;
    this.bump();
    return true;
  }

  ability(pid, type, now) {
    if (this.phase !== 'playing') return false;
    const r = this.round;
    const e = r.ents.get(pid);
    if (!e) return false;
    if (e.role === 'ghost') {
      if (e.caught) return false;
      if (type === 'scare') {
        if (now < e.scareReadyAt) return false;
        e.scareReadyAt = now + CFG.SCARE_CD_MS;
        const hit = [];
        for (const hid of r.hunterIds) {
          const h = r.ents.get(hid);
          if (manhattan(h, e) <= CFG.SCARE_RADIUS) {
            h.frozenUntil = Math.max(h.frozenUntil, now + CFG.SCARE_FREEZE_MS);
            hit.push(hid);
            this.addGain(pid, 5);
          }
        }
        this.fx.push({ to: [pid, ...hit], type: 'scare', data: { by: pid, hit } });
        this.bump();
        return true;
      }
      if (type === 'trap') {
        if (now < e.trapReadyAt) return false;
        if (r.traps.filter((t) => t.owner === pid).length >= CFG.MAX_TRAPS) return false;
        if (r.traps.some((t) => t.x === e.x && t.y === e.y)) return false;
        r.traps.push({ x: e.x, y: e.y, owner: pid });
        e.trapReadyAt = now + CFG.TRAP_CD_MS;
        this.fx.push({ to: [pid], type: 'trapSet', data: {} });
        this.bump();
        return true;
      }
      return false;
    }
    // cazador
    if (type === 'flash') {
      if (now < e.flashReadyAt || now < e.frozenUntil) return false;
      e.flashReadyAt = now + CFG.FLASH_CD_MS;
      e.revealUntil = now + CFG.FLASH_REVEAL_MS;
      e.frozenUntil = Math.max(e.frozenUntil, now + CFG.FLASH_SELF_FREEZE_MS);
      const alerted = r.ghostIds.filter((gid) => {
        const g = r.ents.get(gid);
        return !g.caught && manhattan(g, e) <= CFG.FLASH_RADIUS;
      });
      this.fx.push({ to: [pid, ...alerted], type: 'flash', data: { by: pid } });
      this.bump();
      return true;
    }
    return false;
  }

  // ------------------------------------------------------------- vistas
  ghostDistances() {
    const r = this.round;
    if (r.distCache && r.distCache.v === r.posVersion) return r.distCache.maps;
    const maps = [];
    for (const gid of r.ghostIds) {
      const g = r.ents.get(gid);
      if (!g.caught) maps.push(bfs(r.map, g.x, g.y));
    }
    r.distCache = { v: r.posVersion, maps };
    return maps;
  }

  heatFor(h) {
    const maps = this.ghostDistances();
    if (!maps.length) return 0;
    let best = Infinity;
    for (const m of maps) {
      const d = m[h.y * this.round.map.w + h.x];
      if (d !== -1 && d < best) best = d;
    }
    const [h1, h2, h3, h4] = CFG.HEAT_STEPS;
    if (best <= h4) return 4;
    if (best <= h3) return 3;
    if (best <= h2) return 2;
    if (best <= h1) return 1;
    return 0;
  }

  scoreboard() {
    return this.playerIds.map((id) => ({ id, score: this.scores.get(id) || 0, gain: this.round.gains.get(id) || 0 }));
  }

  /**
   * Información AUTORIZADA para este jugador. Los cazadores nunca reciben la
   * posición del fantasma salvo que esté dentro de su visión o de su destello.
   */
  viewFor(pid, now) {
    const r = this.round;
    const base = {
      phase: this.phase,
      round: { index: this.roundIndex, total: this.totalRounds },
      map: { w: r.map.w, h: r.map.h, rows: r.rows },
      ghostIds: r.ghostIds,
      startsAt: r.startsAt,
      endsAt: r.endsAt,
      scores: this.scoreboard(),
    };
    if (this.phase === 'final') return { ...base, final: true };
    if (this.phase === 'roundEnd') return { ...base, result: r.result, nextAt: r.nextAt };
    const me = r.ents.get(pid);
    if (!me) return base;
    if (this.phase === 'countdown') return { ...base, role: me.role };

    if (me.role === 'ghost') {
      return {
        ...base, role: 'ghost',
        me: {
          x: me.x, y: me.y, caught: me.caught,
          scareReadyAt: me.scareReadyAt, trapReadyAt: me.trapReadyAt,
          trapsActive: r.traps.filter((t) => t.owner === pid).length, maxTraps: CFG.MAX_TRAPS,
        },
        hunters: r.hunterIds.map((id) => { const h = r.ents.get(id); return { id, x: h.x, y: h.y, frozenUntil: h.frozenUntil }; }),
        partners: r.ghostIds.filter((id) => id !== pid).map((id) => { const g = r.ents.get(id); return { id, x: g.x, y: g.y, caught: g.caught }; }),
        traps: r.traps.filter((t) => t.owner === pid).map((t) => ({ x: t.x, y: t.y })),
        ghostsLeft: r.ghostIds.filter((id) => !r.ents.get(id).caught).length,
      };
    }

    // ---- cazador
    const revealing = now < me.revealUntil;
    const ghosts = [];
    const trail = [];
    for (const gid of r.ghostIds) {
      const g = r.ents.get(gid);
      if (g.caught) continue;
      const d = manhattan(g, me);
      if (d <= CFG.VISION || (revealing && d <= CFG.FLASH_RADIUS)) ghosts.push({ id: gid, x: g.x, y: g.y });
      for (const p of g.trail) {
        const age = now - p.t;
        if (age < CFG.TRAIL_MS && manhattan(p, me) <= CFG.VISION + 1) trail.push({ x: p.x, y: p.y, age });
      }
    }
    return {
      ...base, role: 'hunter',
      me: {
        x: me.x, y: me.y, frozenUntil: me.frozenUntil,
        flashReadyAt: me.flashReadyAt, revealUntil: me.revealUntil,
      },
      hunters: r.hunterIds
        .filter((id) => id !== pid)
        .map((id) => r.ents.get(id))
        .filter((h) => manhattan(h, me) <= CFG.VISION)
        .map((h) => ({ id: h.id, x: h.x, y: h.y, frozenUntil: h.frozenUntil })),
      ghosts, trail,
      heat: this.heatFor(me),
      vision: CFG.VISION,
      ghostsLeft: r.ghostIds.filter((id) => !r.ents.get(id).caught).length,
    };
  }
}
