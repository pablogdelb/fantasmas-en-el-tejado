import test from 'node:test';
import assert from 'node:assert/strict';
import { io as connect } from 'socket.io-client';
import { createApp } from '../server/app.js';
import { CFG } from '../server/game.js';

let fake = 1_000_000;
const manhattan = (a, b) => Math.abs(a.x - b.x) + Math.abs(a.y - b.y);

class Client {
  constructor(url, name) {
    this.name = name;
    this.socket = connect(url, { transports: ['websocket'], forceNew: true });
    this.state = null; this.fx = []; this.replaced = false;
    this.socket.on('state', (s) => { this.state = s; });
    this.socket.on('fx', (f) => this.fx.push(f));
    this.socket.on('replaced', () => { this.replaced = true; });
  }
  ready() { return new Promise((res) => (this.socket.connected ? res() : this.socket.once('connect', res))); }
  call(ev, payload = {}) { return new Promise((res) => this.socket.emit(ev, payload, res)); }
  async waitState(pred, ms = 3000) {
    const t0 = Date.now();
    while (Date.now() - t0 < ms) { if (this.state && pred(this.state)) return this.state; await sleep(15); }
    throw new Error(`timeout esperando estado (${this.name}); último: ${JSON.stringify(this.state)?.slice(0, 200)}`);
  }
  close() { this.socket.close(); }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function setup(n) {
  const app = createApp({ clock: () => fake, tickMs: 20 });
  const port = await app.listen(0);
  const url = `http://127.0.0.1:${port}`;
  const clients = [];
  for (let i = 0; i < n; i++) { const c = new Client(url, `Jugador${i}`); await c.ready(); clients.push(c); }
  const created = await clients[0].call('room:create', { name: clients[0].name });
  assert.ok(created.ok);
  clients[0].token = created.token; clients[0].code = created.code;
  for (const c of clients.slice(1)) {
    const r = await c.call('room:join', { name: c.name, code: created.code.toLowerCase() });
    assert.ok(r.ok, r.error);
    c.token = r.token;
  }
  return { app, url, clients, code: created.code };
}

test('sala de 8: unión, anfitrión, límites y validaciones', async () => {
  const { app, url, clients, code } = await setup(8);
  try {
    assert.match(code, /^[A-HJKMNP-Z2-9]{5}$/);
    const s = await clients[7].waitState((x) => x.players?.length === 8);
    assert.equal(s.phase, 'lobby');
    assert.equal(s.players.filter((p) => p.isHost).length, 1);
    assert.equal(s.you.isHost, false);
    assert.equal(new Set(s.players.map((p) => p.color)).size, 8, 'colores únicos');

    // novena persona: sala llena
    const extra = new Client(url, 'X'); await extra.ready();
    assert.equal((await extra.call('room:join', { name: 'Extra', code })).ok, false);
    // código inexistente y nombre vacío
    assert.equal((await extra.call('room:join', { name: 'Extra', code: 'ZZZZZ' })).ok, false);
    assert.equal((await extra.call('room:join', { name: '   ', code })).ok, false);
    extra.close();

    // solo el anfitrión puede configurar y empezar
    assert.equal((await clients[3].call('room:start')).ok, false);
    assert.equal((await clients[3].call('room:settings', { roundSeconds: 60 })).ok, false);
    assert.equal((await clients[0].call('room:settings', { roundSeconds: 60, cycles: 1 })).ok, true);
    assert.equal((await clients[0].call('room:settings', { roundSeconds: 7777 })).ok, true);
    const hs = await clients[1].waitState((x) => x.settings.roundSeconds === 60);
    assert.equal(hs.settings.roundSeconds, 60, 'valor inválido ignorado');
    // nombres con HTML se limpian y los repetidos se distinguen
    const dup = new Client(url, 'D'); await dup.ready();
    assert.equal((await dup.call('room:join', { name: '<b>Hack</b>', code })).ok, false, 'llena');
    dup.close();
  } finally { clients.forEach((c) => c.close()); await app.close(); }
});

test('nombres: HTML eliminado y duplicados diferenciados', async () => {
  const app = createApp({ clock: () => fake, tickMs: 20 });
  const port = await app.listen(0);
  const a = new Client(`http://127.0.0.1:${port}`, 'a'), b = new Client(`http://127.0.0.1:${port}`, 'b');
  try {
    await a.ready(); await b.ready();
    const r = await a.call('room:create', { name: '<img src=x>Ana' });
    await b.call('room:join', { name: 'imgsrc=xAna', code: r.code });
    const s = await a.waitState((x) => x.players.length === 2);
    assert.ok(s.players.every((p) => !/[<>]/.test(p.name)));
    assert.equal(new Set(s.players.map((p) => p.name)).size, 2);
  } finally { a.close(); b.close(); await app.close(); }
});

test('partida completa de 8: roles, bombas… mapas idénticos, privacidad, reconexión, fin y revancha', async () => {
  const { app, url, clients, code } = await setup(8);
  try {
    await clients[0].call('room:settings', { roundSeconds: 60, cycles: 1 });
    assert.equal((await clients[0].call('room:start')).ok, true);
    const states = await Promise.all(clients.map((c) => c.waitState((s) => s.phase === 'countdown')));
    // misma ronda, mismo mapa, mismos fantasmas para todos
    const ghosts = states[0].ghostIds;
    assert.equal(ghosts.length, 2, '8 jugadores => 2 fantasmas');
    for (const s of states) { assert.deepEqual(s.ghostIds, ghosts); assert.deepEqual(s.map.rows, states[0].map.rows); }
    const byRole = states.reduce((a, s) => (a[s.role]++, a), { ghost: 0, hunter: 0 });
    assert.deepEqual(byRole, { ghost: 2, hunter: 6 });
    // en la cuenta atrás nadie recibe posiciones
    for (const s of states) assert.equal(s.me, undefined);
    // no se puede mover todavía
    assert.equal((await clients[2].call('game:move', { dir: 'down' })).ok, false);
    // no se puede unir nadie con la partida en marcha
    const late = new Client(url, 'Tarde'); await late.ready();
    assert.match((await late.call('room:join', { name: 'Tarde', code })).error, /empezado/);
    late.close();

    fake += CFG.COUNTDOWN_MS + 50;
    const playing = await Promise.all(clients.map((c) => c.waitState((s) => s.phase === 'playing')));
    // PRIVACIDAD en vivo: ningún cazador conoce la posición de un fantasma lejano
    const ghostsView = playing.filter((s) => s.role === 'ghost');
    const gpos = new Map(ghostsView.map((s) => [s.you.id, s.me]));
    for (const s of playing.filter((x) => x.role === 'hunter')) {
      for (const g of s.ghosts) assert.ok(manhattan(g, s.me) <= s.vision);
      const raw = JSON.stringify(s);
      for (const [gid, pos] of gpos) if (manhattan(pos, s.me) > CFG.FLASH_RADIUS) assert.equal(raw.includes(`"id":"${gid}","x"`), false);
      assert.equal(s.traps, undefined);
      assert.equal(s.partners, undefined);
    }
    for (const s of ghostsView) assert.equal(s.hunters.length, 6);

    // un cazador se mueve de verdad (busca una dirección libre)
    const hClient = clients[states.findIndex((s) => s.role === 'hunter')];
    const before = hClient.state.me;
    let moved = false;
    for (const dir of ['down', 'right', 'up', 'left']) {
      fake += 300;
      const r = await hClient.call('game:move', { dir });
      if (r.ok) { moved = true; break; }
    }
    assert.ok(moved, 'el cazador pudo moverse');
    const after = await hClient.waitState((s) => s.me && (s.me.x !== before.x || s.me.y !== before.y));
    assert.notDeepEqual([after.me.x, after.me.y], [before.x, before.y]);
    // entradas basura no rompen nada
    assert.equal((await hClient.call('game:move', { dir: { $ne: 1 } })).ok, false);
    assert.equal((await hClient.call('game:ability', { type: 'DROP TABLE' })).ok, false);

    // RECONEXIÓN: cierra el socket de un jugador y vuelve con su token
    const victim = clients[4];
    const myId = victim.state.you.id;
    victim.close();
    const gone = await clients[0].waitState((s) => s.players.some((p) => p.id === myId && !p.connected));
    assert.equal(gone.players.length, 8, 'su asiento se conserva');
    const back = new Client(url, 'vuelta'); await back.ready();
    assert.equal((await back.call('room:rejoin', { code, token: victim.token })).ok, true);
    const bs = await back.waitState((s) => s.you?.id === myId);
    assert.equal(bs.phase, 'playing');
    assert.equal(bs.players.length, 8, 'sin duplicados');
    assert.equal(bs.role, states[4].role, 'mismo rol');
    clients[4] = back; back.token = victim.token;
    // token inválido
    const bad = new Client(url, 'bad'); await bad.ready();
    assert.equal((await bad.call('room:rejoin', { code, token: 'nope' })).ok, false);
    bad.close();

    // DUPLICADO: una segunda pestaña con el mismo token expulsa a la primera
    const dupTab = new Client(url, 'tab2'); await dupTab.ready();
    assert.equal((await dupTab.call('room:rejoin', { code, token: back.token })).ok, true);
    await sleep(100);
    assert.equal(back.replaced, true);
    const after2 = await clients[0].waitState((s) => s.players.length === 8);
    assert.equal(after2.players.filter((p) => p.connected).length, 8);
    clients[4] = dupTab; dupTab.token = back.token;

    // FIN POR TIEMPO: todo el mundo recibe el resultado y las puntuaciones
    fake += 60_000;
    const ended = await Promise.all(clients.map((c) => c.waitState((s) => s.phase === 'roundEnd')));
    assert.equal(ended[0].result.reason, 'time');
    for (const s of ended) assert.deepEqual(s.scores, ended[0].scores);
    const ghostGain = ended[0].result.gains[ghosts[0]];
    assert.ok(ghostGain >= 100, `el fantasma gana por sobrevivir (${ghostGain})`);

    // solo el anfitrión puede saltar
    assert.equal((await clients[2].call('game:skip')).ok, false);
    // recorrer rondas restantes (4 rondas con 8 jugadores)
    for (let r = 1; r < 4; r++) {
      assert.equal((await clients[0].call('game:skip')).ok, true);
      await Promise.all(clients.map((c) => c.waitState((s) => s.phase === 'countdown' && s.round.index === r)));
      fake += CFG.COUNTDOWN_MS + 50;
      await Promise.all(clients.map((c) => c.waitState((s) => s.phase === 'playing')));
      fake += 60_000;
      await Promise.all(clients.map((c) => c.waitState((s) => s.phase === 'roundEnd' && s.round.index === r)));
    }
    assert.equal((await clients[0].call('game:skip')).ok, true);
    const fin = await Promise.all(clients.map((c) => c.waitState((s) => s.phase === 'final')));
    assert.equal(fin[0].scores.length, 8);
    // todos fueron fantasma una vez: todos puntúan algo
    assert.ok(fin[0].scores.every((x) => x.score >= 100));

    // REVANCHA
    assert.equal((await clients[3].call('room:rematch')).ok, false, 'solo el anfitrión');
    assert.equal((await clients[0].call('room:rematch')).ok, true);
    const lobby = await Promise.all(clients.map((c) => c.waitState((s) => s.phase === 'lobby')));
    assert.equal(lobby[0].players.length, 8);
    assert.equal((await clients[0].call('room:start')).ok, true);
    const again = await clients[5].waitState((s) => s.phase === 'countdown');
    assert.equal(again.round.index, 0);
    assert.ok(again.scores.every((x) => x.score === 0), 'puntuación reiniciada');
  } finally { clients.forEach((c) => c.close()); await app.close(); }
});

test('captura real por sockets: gana el cazador y la ronda termina para todos', async () => {
  const { app, clients } = await setup(6);
  try {
    await clients[0].call('room:start');
    await Promise.all(clients.map((c) => c.waitState((s) => s.phase === 'countdown')));
    fake += CFG.COUNTDOWN_MS + 50;
    await Promise.all(clients.map((c) => c.waitState((s) => s.phase === 'playing')));
    // el servidor es autoritativo: forzamos posiciones en el estado del servidor para provocar la captura
    const room = [...app.rooms.rooms.values()][0];
    const g = room.game, r = g.round;
    const gid = r.ghostIds[0], hid = r.hunterIds[0];
    let ok = false;
    for (let y = 0; y < r.map.h && !ok; y++) for (let x = 0; x < r.map.w - 1 && !ok; x++) {
      if (g.isFree(x, y) && g.isFree(x + 1, y)) { Object.assign(r.ents.get(gid), { x: x + 1, y }); Object.assign(r.ents.get(hid), { x, y }); r.posVersion++; ok = true; }
    }
    const hc = clients.find((c) => c.state.you.id === hid);
    fake += 400;
    assert.equal((await hc.call('game:move', { dir: 'right' })).ok, true);
    const ended = await Promise.all(clients.map((c) => c.waitState((s) => s.phase === 'roundEnd')));
    assert.equal(ended[0].result.reason, 'caught');
    assert.equal(ended[0].result.ghosts[0].caughtBy, hid);
    assert.ok(hc.fx.some((f) => f.type === 'caught'));
    const sc = Object.fromEntries(ended[0].scores.map((x) => [x.id, x.score]));
    assert.ok(sc[hid] > 100);
  } finally { clients.forEach((c) => c.close()); await app.close(); }
});

test('el anfitrión se desconecta en el lobby: otro jugador toma el mando', async () => {
  const { app, clients } = await setup(4);
  try {
    clients[0].close();
    const s = await clients[1].waitState((x) => x.players.some((p) => p.isHost && p.id !== clients[0].state.you.id));
    assert.equal(s.players.filter((p) => p.isHost).length, 1);
  } finally { clients.forEach((c) => c.close()); await app.close(); }
});

test('mínimo de jugadores: con 2 no se puede empezar, con 3 sí', async () => {
  const { app, clients } = await setup(2);
  try {
    assert.equal((await clients[0].call('room:start')).ok, false);
  } finally { clients.forEach((c) => c.close()); await app.close(); }
  const t = await setup(3);
  try { assert.equal((await t.clients[0].call('room:start')).ok, true); }
  finally { t.clients.forEach((c) => c.close()); await t.app.close(); }
});

test('servidor HTTP: sirve la web, /sala/CODIGO y /healthz; no sale del directorio public', async () => {
  const app = createApp();
  const port = await app.listen(0);
  try {
    const base = `http://127.0.0.1:${port}`;
    assert.equal((await fetch(base + '/healthz')).status, 200);
    const home = await fetch(base + '/');
    assert.equal(home.status, 200); assert.match(await home.text(), /Fantasmas en el Tejado/);
    assert.equal((await fetch(base + '/sala/ABCDE')).status, 200);
    assert.equal((await fetch(base + '/app.js')).status, 200);
    assert.equal((await fetch(base + '/..%2Fpackage.json')).status, 404);
    assert.equal((await fetch(base + '/%2e%2e/package.json')).status === 200, false);
    assert.equal((await fetch(base + '/nope')).status, 404);
  } finally { await app.close(); }
});
