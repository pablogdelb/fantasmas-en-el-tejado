import test from 'node:test';
import assert from 'node:assert/strict';
import { generateMap, bfs } from '../server/map.js';
import { Game, CFG, DIRS, ghostCountFor, mapSizeFor } from '../server/game.js';
import { mulberry32 } from '../server/rng.js';

const mkPlayers = (n) => Array.from({ length: n }, (_, i) => ({ id: `p${i}`, name: `J${i}` }));
const manhattan = (a, b) => Math.abs(a.x - b.x) + Math.abs(a.y - b.y);

test('mapas: 200 semillas por número de jugadores son conexos y con salidas válidas', () => {
  for (const n of [3, 4, 5, 6, 7, 8]) {
    const size = mapSizeFor(n), g = ghostCountFor(n);
    for (let seed = 1; seed <= 200; seed++) {
      const { map, hunterSpawns, ghostSpawns } = generateMap(seed * 7919, size, size, n - g, g);
      assert.equal(hunterSpawns.length, n - g, `cazadores n=${n} seed=${seed}`);
      assert.equal(ghostSpawns.length, g, `fantasmas n=${n} seed=${seed}`);
      const all = [...hunterSpawns, ...ghostSpawns];
      assert.equal(new Set(all.map((p) => `${p.x},${p.y}`)).size, all.length, 'casillas de salida distintas');
      for (const p of all) assert.equal(map.walls[p.y * size + p.x], false, 'salida en casilla libre');
      const d = bfs(map, hunterSpawns[0].x, hunterSpawns[0].y);
      for (let i = 0; i < map.walls.length; i++) if (!map.walls[i]) assert.notEqual(d[i], -1, 'todo conexo');
      for (const gs of ghostSpawns) assert.ok(d[gs.y * size + gs.x] >= 8, `fantasma lejos (${d[gs.y * size + gs.x]})`);
      for (const hs of hunterSpawns) {
        const free = [[1, 0], [-1, 0], [0, 1], [0, -1]].some(([dx, dy]) => {
          const x = hs.x + dx, y = hs.y + dy;
          return x >= 0 && y >= 0 && x < size && y < size && !map.walls[y * size + x] && !all.some((o) => o.x === x && o.y === y);
        });
        assert.ok(free, `ningún cazador empieza encerrado (n=${n} seed=${seed})`);
      }
      const openCount = map.walls.filter((w) => !w).length;
      assert.ok(openCount > size * size * 0.6, 'mapa con espacio suficiente');
    }
  }
});

test('mapas deterministas por semilla', () => {
  const a = generateMap(42, 11, 11, 5, 1), b = generateMap(42, 11, 11, 5, 1);
  assert.deepEqual(a.map.walls, b.map.walls);
});

test('rotación: cada jugador es fantasma, y con 2 fantasmas hay 4 rondas con 8 jugadores', () => {
  for (const n of [3, 4, 5, 6, 7, 8]) {
    const g = new Game(mkPlayers(n), { roundSeconds: 60, cycles: 1, seed: 5 }, 0);
    const counts = new Map();
    for (let r = 0; r < g.totalRounds; r++) {
      if (r > 0) g.startRound(r, 0);
      assert.equal(g.round.ghostIds.length, ghostCountFor(n));
      for (const id of g.round.ghostIds) counts.set(id, (counts.get(id) || 0) + 1);
    }
    assert.equal(counts.size, n, `todos son fantasma al menos una vez (n=${n})`);
    if (n % ghostCountFor(n) === 0) for (const c of counts.values()) assert.equal(c, 1);
  }
  assert.equal(new Game(mkPlayers(8), { roundSeconds: 60, cycles: 1, seed: 1 }, 0).totalRounds, 4);
  assert.equal(new Game(mkPlayers(6), { roundSeconds: 60, cycles: 2, seed: 1 }, 0).totalRounds, 12);
});

function started(n = 6, seed = 11, roundSeconds = 60) {
  const g = new Game(mkPlayers(n), { roundSeconds, cycles: 1, seed }, 0);
  g.tick(CFG.COUNTDOWN_MS);
  assert.equal(g.phase, 'playing');
  return g;
}

/** Coloca entidades a mano para probar reglas concretas. */
function place(g, id, x, y) { const e = g.round.ents.get(id); e.x = x; e.y = y; g.round.posVersion++; return e; }
function openNeighbour(g, e) {
  for (const [d, [dx, dy]] of Object.entries(DIRS)) if (g.isFree(e.x + dx, e.y + dy, e.id)) return d;
  throw new Error('sin vecino libre');
}

test('cuenta atrás: no se puede mover antes de empezar', () => {
  const g = new Game(mkPlayers(6), { roundSeconds: 60, cycles: 1, seed: 3 }, 0);
  const hid = g.round.hunterIds[0];
  assert.equal(g.move(hid, 'down', 100), false);
  assert.equal(g.phase, 'countdown');
});

test('movimiento: muros, límites y enfriamiento', () => {
  const g = started();
  const t0 = CFG.COUNTDOWN_MS;
  const hid = g.round.hunterIds[0];
  const e = g.round.ents.get(hid);
  for (let y = 0; y < g.round.map.h; y++) for (let x = 0; x < g.round.map.w; x++) {
    if (g.isFree(x, y) && g.isFree(x + 1, y)) { place(g, hid, x, y); y = 99; break; }
  }
  const dir = 'right';
  const [dx, dy] = DIRS[dir];
  const ox = e.x, oy = e.y;
  assert.equal(g.move(hid, dir, t0), true);
  assert.deepEqual([e.x, e.y], [ox + dx, oy + dy]);
  assert.equal(g.move(hid, dir, t0 + 10), false, 'enfriamiento');
  assert.equal(g.move(hid, 'banana', t0 + 1000), false, 'dirección inválida');
  // contra el borde
  place(g, hid, 0, 0); e.nextMoveAt = 0;
  assert.equal(g.move(hid, 'up', t0 + 2000), false);
  assert.equal(g.move(hid, 'left', t0 + 2000), false);
});

test('captura: el cazador que entra en la casilla del fantasma gana la ronda', () => {
  const g = started(6);
  const t = CFG.COUNTDOWN_MS + 1000;
  const gid = g.round.ghostIds[0];
  const hid = g.round.hunterIds[0];
  const ghost = g.round.ents.get(gid), hunter = g.round.ents.get(hid);
  // buscar una casilla libre con vecino libre
  let found = false;
  for (let y = 0; y < g.round.map.h && !found; y++) for (let x = 0; x < g.round.map.w && !found; x++) {
    if (!g.isFree(x, y) || !g.isFree(x + 1, y)) continue;
    place(g, gid, x + 1, y); place(g, hid, x, y); found = true;
  }
  assert.ok(found);
  assert.equal(g.move(hid, 'right', t), true);
  assert.equal(ghost.caught, true);
  assert.equal(ghost.caughtBy, hid);
  assert.equal(g.phase, 'roundEnd');
  assert.equal(g.round.result.reason, 'caught');
  assert.ok(g.round.gains.get(hid) >= 100 + 20, 'captor: 100 + tiempo + 20 de equipo');
  for (const other of g.round.hunterIds.filter((i) => i !== hid)) assert.equal(g.round.gains.get(other), 20);
  assert.equal(hunter.x, ghost.x);
});

test('el fantasma no puede atravesar cazadores y no hay capturas por su movimiento', () => {
  const g = started(6);
  const gid = g.round.ghostIds[0], hid = g.round.hunterIds[0];
  let found = false;
  for (let y = 0; y < g.round.map.h && !found; y++) for (let x = 0; x < g.round.map.w && !found; x++) {
    if (!g.isFree(x, y) || !g.isFree(x + 1, y)) continue;
    place(g, gid, x, y); place(g, hid, x + 1, y); found = true;
  }
  assert.equal(g.move(gid, 'right', CFG.COUNTDOWN_MS + 500), false);
  assert.equal(g.round.ents.get(gid).caught, false);
});

test('tiempo agotado: gana el fantasma con bonus de supervivencia', () => {
  const g = started(6, 11, 60);
  const end = CFG.COUNTDOWN_MS + 60_000;
  g.tick(end);
  assert.equal(g.phase, 'roundEnd');
  assert.equal(g.round.result.reason, 'time');
  const gid = g.round.ghostIds[0];
  assert.equal(g.round.gains.get(gid), 60 + 40);
  for (const h of g.round.hunterIds) assert.equal(g.round.gains.get(h), 0);
});

test('trampa: inmoviliza al cazador y puntúa al fantasma; no es visible para cazadores', () => {
  const g = started(6);
  const t = CFG.COUNTDOWN_MS + 1000;
  const gid = g.round.ghostIds[0], hid = g.round.hunterIds[0];
  const ghost = g.round.ents.get(gid), hunter = g.round.ents.get(hid);
  let found = false;
  for (let y = 0; y < g.round.map.h && !found; y++) for (let x = 0; x < g.round.map.w - 2 && !found; x++) {
    if (g.isFree(x, y) && g.isFree(x + 1, y) && g.isFree(x + 2, y)) {
      place(g, gid, x + 1, y); place(g, hid, x, y); found = true;
    }
  }
  assert.ok(found);
  assert.equal(g.ability(gid, 'trap', t), true);
  assert.equal(g.ability(gid, 'trap', t + 100), false, 'enfriamiento');
  const hv = g.viewFor(hid, t);
  assert.equal(JSON.stringify(hv).includes('traps'), false, 'el cazador no ve trampas');
  place(g, gid, ghost.x + 1, ghost.y); // el fantasma se aparta
  hunter.nextMoveAt = 0;
  assert.equal(g.move(hid, 'right', t + 500), true);
  assert.equal(g.round.gains.get(gid), 10, 'el fantasma gana 10 por la trampa');
  assert.equal(hunter.frozenUntil, t + 500 + CFG.TRAP_STUN_MS);
  assert.equal(g.move(hid, 'right', t + 1500), false, 'congelado');
  assert.equal(g.round.traps.length, 0, 'la trampa se consume');
  assert.equal(g.move(hid, 'right', t + 500 + CFG.TRAP_STUN_MS + 1), true, 'tras el aturdimiento puede moverse');
});

test('susto: congela solo a los cazadores cercanos', () => {
  const g = started(6);
  const t = CFG.COUNTDOWN_MS + 1000;
  const gid = g.round.ghostIds[0];
  const [near, far] = g.round.hunterIds;
  const ghost = g.round.ents.get(gid);
  let found = false;
  for (let y = 0; y < g.round.map.h && !found; y++) for (let x = 0; x < g.round.map.w - 1 && !found; x++) {
    if (g.isFree(x, y) && g.isFree(x + 1, y)) { place(g, gid, x, y); place(g, near, x + 1, y); found = true; }
  }
  // lejano: la esquina opuesta del fantasma
  let best = null, bd = -1;
  for (let y = 0; y < g.round.map.h; y++) for (let x = 0; x < g.round.map.w; x++)
    if (g.isFree(x, y) && manhattan({ x, y }, ghost) > bd) { bd = manhattan({ x, y }, ghost); best = { x, y }; }
  place(g, far, best.x, best.y);
  assert.equal(g.ability(gid, 'scare', t), true);
  assert.equal(g.round.ents.get(near).frozenUntil, t + CFG.SCARE_FREEZE_MS);
  assert.equal(g.round.ents.get(far).frozenUntil, 0);
  assert.equal(g.ability(gid, 'scare', t + 100), false);
  const frozen = g.round.hunterIds.filter((i) => g.round.ents.get(i).frozenUntil > 0).length;
  assert.ok(frozen >= 1);
  assert.equal(g.round.gains.get(gid), 5 * frozen);
});

test('destello: revela al fantasma durante 2 s solo dentro del radio', () => {
  const g = started(6);
  const t = CFG.COUNTDOWN_MS + 1000;
  const gid = g.round.ghostIds[0], hid = g.round.hunterIds[0];
  let ok = false;
  for (let y = 0; y < g.round.map.h && !ok; y++) for (let x = 0; x < g.round.map.w - 4 && !ok; x++) {
    if (g.isFree(x, y) && g.isFree(x + 4, y)) { place(g, hid, x, y); place(g, gid, x + 4, y); ok = true; }
  }
  assert.ok(ok);
  assert.equal(g.viewFor(hid, t).ghosts.length, 0, 'a 4 casillas no se ve');
  assert.equal(g.ability(hid, 'flash', t), true);
  assert.equal(g.viewFor(hid, t + 500).ghosts.length, 1, 'con destello sí');
  assert.equal(g.viewFor(hid, t + CFG.FLASH_REVEAL_MS + 1).ghosts.length, 0, 'se apaga');
  const other = g.round.hunterIds[1];
  let far = null, fd = -1;
  for (let y = 0; y < g.round.map.h; y++) for (let x = 0; x < g.round.map.w; x++) {
    const d = manhattan({ x, y }, g.round.ents.get(gid));
    if (g.isFree(x, y) && d > fd) { fd = d; far = { x, y }; }
  }
  place(g, other, far.x, far.y);
  assert.ok(fd > CFG.FLASH_RADIUS);
  assert.equal(g.viewFor(other, t + 500).ghosts.length, 0, 'solo lo ve quien lo lanza');
  assert.equal(g.ability(hid, 'flash', t + 5000), false, 'enfriamiento');
});

test('SEGURIDAD: un cazador nunca recibe la posición del fantasma fuera de su visión (partida simulada)', () => {
  const rnd = mulberry32(99);
  for (const n of [6, 7, 8]) {
    const g = new Game(mkPlayers(n), { roundSeconds: 120, cycles: 1, seed: n * 31 }, 0);
    let now = 0;
    while (g.phase !== 'final' && now < 3_000_000) {
      now += 100;
      g.tick(now);
      if (g.phase !== 'playing') continue;
      for (const [id, e] of g.round.ents) {
        if (rnd() < 0.7) g.move(id, ['up', 'down', 'left', 'right'][Math.floor(rnd() * 4)], now);
        if (e.role === 'hunter' && rnd() < 0.01) g.ability(id, 'flash', now);
        if (e.role === 'ghost' && rnd() < 0.02) g.ability(id, rnd() < 0.5 ? 'scare' : 'trap', now);
      }
      if (g.phase !== 'playing') continue;
      for (const hid of g.round.hunterIds) {
        const v = g.viewFor(hid, now);
        const me = g.round.ents.get(hid);
        for (const gv of v.ghosts) assert.ok(manhattan(gv, me) <= (now < me.revealUntil ? CFG.FLASH_RADIUS : CFG.VISION), 'fantasma visible fuera de rango');
        for (const p of v.trail) assert.ok(manhattan(p, me) <= CFG.VISION + 1, 'huella fuera de rango');
        for (const hv of v.hunters) assert.ok(manhattan(hv, me) <= CFG.VISION, 'compañero fuera de rango');
        assert.equal('traps' in v, false);
        assert.ok(v.heat >= 0 && v.heat <= 4);
        // la vista serializada no contiene posiciones del fantasma lejano
        const s = JSON.stringify(v);
        for (const gid of g.round.ghostIds) {
          const ge = g.round.ents.get(gid);
          if (!ge.caught && manhattan(ge, me) > CFG.FLASH_RADIUS) assert.equal(s.includes(`"id":"${gid}","x"`), false, 'posición filtrada');
        }
      }
      for (const gid of g.round.ghostIds) {
        const v = g.viewFor(gid, now);
        assert.equal(v.role, 'ghost');
        assert.equal(v.hunters.length, g.round.hunterIds.length);
      }
    }
    assert.equal(g.phase, 'final', `la partida de ${n} termina`);
    assert.ok([...g.scores.values()].every((s) => s >= 0));
  }
});

test('la distancia de calor aumenta al acercarse', () => {
  const g = started(6);
  const gid = g.round.ghostIds[0], hid = g.round.hunterIds[0];
  const ghost = g.round.ents.get(gid);
  const d = bfs(g.round.map, ghost.x, ghost.y);
  const cells = [];
  for (let i = 0; i < d.length; i++) if (d[i] >= 0) cells.push({ i, d: d[i] });
  const heatAt = (dist) => {
    const c = cells.find((c) => c.d === dist);
    if (!c) return null;
    place(g, hid, c.i % g.round.map.w, (c.i / g.round.map.w) | 0);
    return g.heatFor(g.round.ents.get(hid));
  };
  assert.equal(heatAt(1), 4);
  assert.equal(heatAt(3), 3);
  assert.equal(heatAt(5), 2);
  assert.equal(heatAt(7), 1);
  assert.equal(heatAt(8), 0, 'más allá del alcance no hay pista');
  const far = heatAt(Math.max(...cells.map((c) => c.d)));
  assert.equal(far, 0);
});

test('fantasma desconectado 20 s: ronda abandonada y la partida continúa', () => {
  let connected = true;
  const g = new Game(mkPlayers(6), { roundSeconds: 90, cycles: 1, seed: 8 }, 0, () => connected);
  g.tick(CFG.COUNTDOWN_MS);
  const gid = g.round.ghostIds[0];
  connected = false;
  g.tick(CFG.COUNTDOWN_MS + 1000);
  assert.equal(g.phase, 'playing');
  g.tick(CFG.COUNTDOWN_MS + 1000 + CFG.GHOST_ABANDON_MS);
  assert.equal(g.phase, 'roundEnd');
  assert.equal(g.round.result.ghosts[0].abandoned, true);
  assert.equal(g.round.result.ghosts[0].id, gid);
});

test('avance de rondas y final con clasificación', () => {
  const g = new Game(mkPlayers(4), { roundSeconds: 60, cycles: 1, seed: 2 }, 0);
  let now = 0;
  for (let r = 0; r < 4; r++) {
    now += CFG.COUNTDOWN_MS; g.tick(now);
    now += 60_000; g.tick(now);
    assert.equal(g.phase, 'roundEnd');
    now += CFG.ROUND_END_MS; g.tick(now);
  }
  assert.equal(g.phase, 'final');
  const total = [...g.scores.values()].reduce((a, b) => a + b, 0);
  assert.equal(total, 4 * 100, 'cada ronda sin captura da 100 al fantasma');
});

test('5 jugadores: 1 fantasma, 4 cazadores, casa de 10×10 y 5 rondas con todos de fantasma', () => {
  assert.equal(ghostCountFor(5), 1);
  assert.equal(mapSizeFor(5), 10);
  const g = new Game(mkPlayers(5), { roundSeconds: 90, cycles: 1, seed: 77 }, 0);
  assert.equal(g.totalRounds, 5);
  assert.equal(g.round.map.w, 10);
  assert.equal(g.round.map.h, 10);
  assert.equal(g.round.hunterIds.length, 4);
  const seen = new Set();
  for (let r = 0; r < g.totalRounds; r++) { if (r) g.startRound(r, 0); seen.add(g.round.ghostIds[0]); }
  assert.equal(seen.size, 5, 'cada jugador es fantasma una vez');
});
