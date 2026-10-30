import { sfx, vibrate, prefs, savePref } from './audio.js';
import { Board } from './render.js';

/* global io */
const $ = (id) => document.getElementById(id);
const socket = io({ transports: ['websocket', 'polling'] });

// ------------------------------------------------------------------ estado
let session = null;      // { code, token }
let state = null;        // última vista autorizada recibida del servidor
let offset = 0;          // serverNow - Date.now()
let lastPhaseKey = '';
let heldDir = null, holdTimer = null;
const serverNow = () => Date.now() + offset;
const store = {
  get(k) { try { return localStorage.getItem(k); } catch { return null; } },
  set(k, v) { try { v == null ? localStorage.removeItem(k) : localStorage.setItem(k, v); } catch { /* modo privado */ } },
};
try { session = JSON.parse(store.get('fet.session') || 'null'); } catch { session = null; }
const saveSession = (s) => { session = s; store.set('fet.session', s ? JSON.stringify(s) : null); };

const SCREENS = ['home', 'lobby', 'game', 'round', 'final'];
function show(name) {
  for (const s of SCREENS) $('screen-' + s).classList.toggle('hidden', s !== name);
  $('btn-settings').classList.toggle('hidden', false);
}
function el(tag, props = {}, ...kids) {
  const n = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (k === 'class') n.className = v; else if (k === 'style') n.setAttribute('style', v); else n[k] = v;
  }
  for (const k of kids) n.append(k);
  return n;
}
const mm = (ms) => { const s = Math.max(0, Math.ceil(ms / 1000)); return `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`; };

// ------------------------------------------------------------------ ajustes
$('btn-settings').onclick = () => {
  $('set-sound').checked = !sfx.isMuted(); $('set-vib').checked = !prefs.noVibrate; $('set-motion').checked = prefs.reduceMotion;
  $('settings').classList.remove('hidden');
};
$('set-close').onclick = () => $('settings').classList.add('hidden');
$('set-sound').onchange = (e) => { sfx.setMuted(!e.target.checked); sfx.unlock(); };
$('set-vib').onchange = (e) => savePref('noVibrate', !e.target.checked);
$('set-motion').onchange = (e) => savePref('reduceMotion', e.target.checked);
document.addEventListener('pointerdown', () => sfx.unlock(), { once: true });

// ------------------------------------------------------------------ conexión
socket.on('connect', () => {
  $('conn').classList.add('hidden');
  if (session) {
    socket.emit('room:rejoin', session, (r) => {
      if (!r?.ok) { saveSession(null); state = null; show('home'); history.replaceState(null, '', '/'); }
    });
  }
});
socket.on('disconnect', () => $('conn').classList.remove('hidden'));
socket.on('replaced', () => { saveSession(null); state = null; show('home'); $('home-error').textContent = 'Has abierto la partida en otra pestaña.'; });

// ------------------------------------------------------------------ inicio
const pathCode = (location.pathname.match(/^\/sala\/([A-Za-z0-9]{5})/) || [])[1] || new URLSearchParams(location.search).get('sala');
if (pathCode) $('in-code').value = pathCode.toUpperCase().slice(0, 5);
$('in-name').value = store.get('fet.name') || '';

function enter(r, name) {
  if (!r?.ok) { $('home-error').textContent = r?.error || 'No se pudo conectar'; return; }
  store.set('fet.name', name);
  saveSession({ code: r.code, token: r.token });
  history.replaceState(null, '', '/sala/' + r.code);
}
$('btn-create').onclick = () => {
  const name = $('in-name').value.trim();
  if (!name) { $('home-error').textContent = 'Escribe tu nombre'; return; }
  sfx.click();
  socket.emit('room:create', { name }, (r) => enter(r, name));
};
$('btn-join').onclick = () => {
  const name = $('in-name').value.trim(), code = $('in-code').value.trim();
  if (!name) { $('home-error').textContent = 'Escribe tu nombre'; return; }
  if (code.length < 5) { $('home-error').textContent = 'El código tiene 5 caracteres'; return; }
  sfx.click();
  socket.emit('room:join', { name, code }, (r) => enter(r, name));
};
$('in-code').addEventListener('input', (e) => { e.target.value = e.target.value.toUpperCase().replace(/[^A-Z0-9]/g, ''); });
for (const id of ['in-name', 'in-code']) $(id).addEventListener('keydown', (e) => { if (e.key === 'Enter') ($('in-code').value ? $('btn-join') : $('btn-create')).click(); });

function leave() {
  socket.emit('room:leave', {}, () => {});
  saveSession(null); state = null; lastPhaseKey = '';
  history.replaceState(null, '', '/'); show('home');
}
$('btn-leave').onclick = leave;
$('btn-leave2').onclick = leave;

// ------------------------------------------------------------------ sala
const linkFor = (code) => `${location.origin}/sala/${code}`;
$('btn-copy').onclick = async () => {
  try { await navigator.clipboard.writeText(state.code); toast('Código copiado'); } catch { toast('Copia el código a mano'); }
};
$('btn-share').onclick = async () => {
  const url = linkFor(state.code);
  const data = { title: 'Fantasmas en el Tejado', text: `¡Únete a mi sala! Código ${state.code}`, url };
  try { if (navigator.share) await navigator.share(data); else { await navigator.clipboard.writeText(url); toast('Enlace copiado'); } } catch { /* cancelado */ }
};
for (const [id, key] of [['seg-seconds', 'roundSeconds'], ['seg-cycles', 'cycles']]) {
  $(id).addEventListener('click', (e) => {
    const b = e.target.closest('button'); if (!b) return;
    socket.emit('room:settings', { [key]: Number(b.dataset.v) }, () => {});
  });
}
$('btn-start').onclick = () => {
  sfx.click();
  socket.emit('room:start', {}, (r) => { if (!r?.ok) $('lobby-error').textContent = r?.error || ''; });
};

function renderLobby(s) {
  show('lobby');
  $('lobby-error').textContent = '';
  $('lobby-code').textContent = s.code;
  const n = s.players.length;
  $('lobby-count').textContent = `(${n}/${s.limits.max})`;
  const ul = $('lobby-players'); ul.replaceChildren();
  for (const p of s.players) {
    ul.append(el('li', { class: p.connected ? '' : 'off' },
      el('span', { class: 'dot', style: `background:${p.color};color:${p.color}` }),
      el('span', { class: 'n', textContent: p.name + (p.id === s.you.id ? ' (tú)' : '') }),
      el('span', { class: 'crown', textContent: p.isHost ? '👑' : '' })));
  }
  const g = n >= 7 ? 2 : 1;
  $('lobby-hint').textContent = n < s.limits.min
    ? `Hacen falta al menos ${s.limits.min} jugadores.`
    : n < 6 ? 'Se puede jugar ya, pero lo ideal es de 6 a 8 jugadores.' : `${g} fantasma${g > 1 ? 's' : ''} por ronda.`;
  const host = s.you.isHost;
  $('lobby-host').classList.toggle('hidden', !host);
  $('lobby-guest').classList.toggle('hidden', host);
  for (const b of $('seg-seconds').children) b.classList.toggle('on', Number(b.dataset.v) === s.settings.roundSeconds);
  for (const b of $('seg-cycles').children) b.classList.toggle('on', Number(b.dataset.v) === s.settings.cycles);
  const rounds = Math.ceil(n / g) * s.settings.cycles;
  const mins = Math.round((rounds * (s.settings.roundSeconds + 17)) / 60);
  $('lobby-rounds').textContent = n >= s.limits.min ? `${rounds} rondas · unos ${mins} min · todos serán fantasma` : '';
  $('btn-start').disabled = !s.canStart;
}

// ------------------------------------------------------------------ juego
const board = new Board($('board'));
let abilityDefs = [];
let abilityKey = '';
let boardKey = '';
const names = () => new Map((state?.players || []).map((p) => [p.id, p]));
const nameOf = (id) => names().get(id)?.name || '?';

function sizeBoard() {
  const wrap = $('board-wrap');
  const w = state?.map?.w || 11;
  const px = Math.floor(Math.min(wrap.clientWidth - 8, wrap.clientHeight - 8) / w) * w;
  if (px > 0 && `${px}/${w}` !== boardKey) { boardKey = `${px}/${w}`; board.resize(px); }
}
new ResizeObserver(sizeBoard).observe($('board-wrap'));
window.addEventListener('orientationchange', () => setTimeout(sizeBoard, 200));

function buildAbilities(role) {
  const box = $('abilities'); box.replaceChildren(); abilityDefs = [];
  const defs = role === 'ghost'
    ? [{ type: 'scare', label: '😱 SUSTO', sub: 'congela cerca', key: 'scareReadyAt', cd: 14000, ghosty: true },
       { type: 'trap', label: '🕸 TRAMPA', sub: '', key: 'trapReadyAt', cd: 8000, ghosty: true }]
    : [{ type: 'flash', label: '🔦 DESTELLO', sub: 'ver a 4 casillas', key: 'flashReadyAt', cd: 18000 }];
  for (const d of defs) {
    const cd = el('span', { class: 'cd' });
    const sub = el('small', { textContent: d.sub });
    const b = el('button', { class: 'ab' + (d.ghosty ? ' ghosty' : '') }, el('span', { textContent: d.label }), sub, cd);
    b.onclick = () => useAbility(d.type);
    box.append(b);
    abilityDefs.push({ ...d, b, cdEl: cd, subEl: sub });
  }
}
function useAbility(type) {
  socket.emit('game:ability', { type }, (r) => { if (!r?.ok) vibrate(20); });
}

function startHold(dir, btn) {
  stopHold(); heldDir = dir; btn?.classList.add('down');
  const send = () => socket.emit('game:move', { dir }, (r) => { if (r?.ok) sfx.step(); });
  send(); holdTimer = setInterval(send, 70);
}
function stopHold() { if (holdTimer) clearInterval(holdTimer); holdTimer = null; heldDir = null; for (const b of $('dpad').children) b.classList.remove('down'); }
for (const b of $('dpad').children) {
  b.addEventListener('pointerdown', (e) => { e.preventDefault(); try { b.setPointerCapture(e.pointerId); } catch { /* sin captura */ } startHold(b.dataset.dir, b); });
  for (const ev of ['pointerup', 'pointercancel', 'lostpointercapture']) b.addEventListener(ev, stopHold);
  b.addEventListener('contextmenu', (e) => e.preventDefault());
}
const KEYS = { ArrowUp: 'up', KeyW: 'up', ArrowDown: 'down', KeyS: 'down', ArrowLeft: 'left', KeyA: 'left', ArrowRight: 'right', KeyD: 'right' };
addEventListener('keydown', (e) => {
  if (!state || !['countdown', 'playing'].includes(state.phase) || e.target.tagName === 'INPUT') return;
  if (KEYS[e.code]) { e.preventDefault(); if (heldDir !== KEYS[e.code]) startHold(KEYS[e.code]); }
  else if (e.code === 'Space' && abilityDefs[0]) { e.preventDefault(); useAbility(abilityDefs[0].type); }
  else if (e.code === 'KeyE' && abilityDefs[1]) useAbility(abilityDefs[1].type);
});
addEventListener('keyup', (e) => { if (KEYS[e.code] && heldDir === KEYS[e.code]) stopHold(); });
addEventListener('blur', stopHold);

let toastTimer = null;
function toast(msg, ms = 1800) {
  const t = $('toast'); t.textContent = msg; t.classList.remove('hidden');
  clearTimeout(toastTimer); toastTimer = setTimeout(() => t.classList.add('hidden'), ms);
}
function vfx(col, cls = 'fx') {
  if (prefs.reduceMotion) return;
  const v = $('vignette'); v.classList.remove('fx', 'pulse'); void v.offsetWidth;
  v.style.setProperty('--col', col); v.classList.add(cls);
}

function renderGame(s) {
  show('game');
  const ghost = s.role === 'ghost';
  const key = `${s.round.index}:${s.role}`;
  if (key !== abilityKey) {
    abilityKey = key; boardKey = ''; board.disp.clear(); board.rings = []; buildAbilities(s.role);
    $('heat').classList.toggle('hidden', ghost);
    nextBeat = 0;
  }
  s.youId = s.you.id;
  board.setView(s);
  sizeBoard();
  $('hud-round').textContent = `${s.round.index + 1}/${s.round.total}`;
  $('hud-role').textContent = ghost ? '👻 FANTASMA' : '🔦 CAZADOR';
  $('hud-role').style.color = ghost ? 'var(--ghost)' : 'var(--hunter)';
  $('hud-ghosts').textContent = s.ghostsLeft ?? s.ghostIds.length;
  const gn = s.ghostIds.map(nameOf).join(' y ');
  $('hud-ghostname').textContent = ghost
    ? (s.me?.caught ? '💀 Te han atrapado: ahora miras' : `Los cazadores te buscan: ¡no te dejes atrapar!`)
    : `Fantasma: ${gn}`;
  // calor
  if (!ghost) [...$('heat').children].forEach((c, i) => c.classList.toggle('on', i < s.heat));

  const ov = $('overlay');
  if (s.phase === 'countdown') {
    ov.classList.remove('hidden');
    $('overlay-big').style.color = ghost ? 'var(--ghost)' : 'var(--hunter)';
    $('overlay-big').textContent = ghost ? '👻 ERES EL FANTASMA' : '🔦 ERES CAZADOR';
    $('overlay-sub').textContent = ghost
      ? 'Huye y estorba a los cazadores con SUSTO y TRAMPA. Sobrevive hasta que se acabe el tiempo.'
      : `Atrapa a ${gn} entrando en su casilla. Cuanto más rápido late el móvil, más cerca está. Habla con tus compañeros.`;
    if (!wake) requestWake();
  } else ov.classList.add('hidden');
}

// ---- bucle de dibujo, temporizador y latidos
let last = performance.now(), nextBeat = 0, lastCountNum = null, lastFrozen = false;
const BEAT_MS = [0, 1500, 1000, 650, 380];
const HEAT_COL = ['', 'rgba(77,195,255,.45)', 'rgba(255,210,63,.5)', 'rgba(255,154,60,.55)', 'rgba(255,45,85,.65)'];
function frame(now) {
  requestAnimationFrame(frame);
  const dt = Math.min(0.1, (now - last) / 1000); last = now;
  const s = state;
  if (!s || !['countdown', 'playing'].includes(s.phase)) return;
  const sn = serverNow();
  board.draw(now, dt, names(), sn);

  const timer = $('hud-timer');
  const remaining = s.phase === 'playing' ? s.endsAt - sn : s.endsAt - s.startsAt;
  timer.textContent = mm(remaining);
  timer.classList.toggle('low', s.phase === 'playing' && remaining < 10000);

  if (s.phase === 'countdown') {
    const n = Math.max(1, Math.ceil((s.startsAt - sn) / 1000));
    if (n !== lastCountNum) { lastCountNum = n; sfx.tick(); $('overlay-count').textContent = n; }
    return;
  }
  lastCountNum = null;

  // habilidades
  for (const d of abilityDefs) {
    const readyAt = s.me?.[d.key] || 0;
    const left = readyAt - sn;
    let blocked = left > 0;
    if (d.type === 'trap') {
      d.subEl.textContent = `${s.me.trapsActive}/${s.me.maxTraps} puestas`;
      if (s.me.trapsActive >= s.me.maxTraps) blocked = true;
    }
    if (s.me?.caught) blocked = true;
    if (s.role === 'hunter' && s.me.frozenUntil > sn) blocked = true;
    d.b.disabled = blocked;
    d.b.classList.toggle('ready', !blocked);
    d.cdEl.style.transform = `scaleY(${left > 0 ? Math.min(1, left / d.cd) : 0})`;
    if (left > 0) d.subEl.textContent = `${(left / 1000).toFixed(0)} s`;
    else if (d.type === 'scare') d.subEl.textContent = 'congela cerca';
    else if (d.type === 'flash') d.subEl.textContent = 'ver a 4 casillas';
  }

  // congelación
  const frozen = s.role === 'hunter' && s.me.frozenUntil > sn;
  if (frozen !== lastFrozen) { lastFrozen = frozen; if (!frozen) vibrate(20); }
  $('dpad').style.opacity = frozen || s.me?.caught ? 0.35 : 1;
  $('freeze').classList.toggle('hidden', !frozen);
  if (frozen) $('freeze').textContent = `❄ CONGELADO ${(Math.max(0, s.me.frozenUntil - sn) / 1000).toFixed(1)} s`;

  // latidos / peligro
  let level = 0;
  if (s.role === 'hunter') level = s.heat;
  else if (s.role === 'ghost' && !s.me.caught) {
    const dmin = Math.min(...s.hunters.map((h) => Math.abs(h.x - s.me.x) + Math.abs(h.y - s.me.y)), 99);
    level = dmin <= 1 ? 4 : dmin <= 2 ? 3 : dmin <= 3 ? 2 : 0;
  }
  if (level > 0 && now >= nextBeat) {
    nextBeat = now + BEAT_MS[level];
    sfx.beat(level);
    if (level >= 2) vibrate(level >= 4 ? [40, 50, 40] : 25);
    vfx(HEAT_COL[level], 'pulse');
    $('vignette').style.setProperty('--dur', (BEAT_MS[level] * 0.9) / 1000 + 's');
  } else if (level === 0) nextBeat = 0;
}
requestAnimationFrame(frame);

// ------------------------------------------------------------------ fx del servidor
socket.on('fx', ({ type, data }) => {
  const me = state?.you.id;
  if (!me) return;
  switch (type) {
    case 'scare':
      if (data.hit.includes(me)) { sfx.scare(); vibrate([80, 40, 160]); vfx('rgba(155,140,255,.85)'); toast('😱 ¡BUUU! Congelado 4 s', 2200); $('board-wrap').classList.add('shake'); setTimeout(() => $('board-wrap').classList.remove('shake'), 400); }
      else if (data.by === me) { sfx.scare(); toast(data.hit.length ? `😱 Has asustado a ${data.hit.length}` : '😱 Susto en el vacío…'); }
      break;
    case 'trapped':
      if (data.hunter === me) { sfx.trap(); vibrate([120, 60, 200]); vfx('rgba(190,100,255,.8)'); toast('🕸 ¡TRAMPA! Paralizado 3 s', 2200); }
      else { sfx.trap(); toast('🕸 ¡Un cazador ha caído en tu trampa! +10'); }
      break;
    case 'trapSet': sfx.trapSet(); toast('🕸 Trampa colocada'); break;
    case 'flash':
      if (data.by === me) { sfx.flash(); vfx('rgba(255,255,230,.8)'); if (state.me) board.ring(state.me.x, state.me.y, '#fffbe0'); }
      else { sfx.alert(); vibrate([60, 60, 60]); vfx('rgba(255,45,85,.6)'); toast('🔦 ¡Un cazador te ha iluminado cerca!'); }
      break;
    case 'caught': sfx.caught(); vibrate([100, 50, 100, 50, 200]); toast(`🎯 ¡${nameOf(data.by)} ha atrapado a ${nameOf(data.ghost)}!`, 3000); break;
    case 'abandoned': toast(`${nameOf(data.id)} se ha desconectado`, 3000); break;
    default: break;
  }
});

// ------------------------------------------------------------------ fin de ronda y final
function rankingList(s, ol, withGain) {
  const byId = names();
  const rows = [...s.scores].sort((a, b) => b.score - a.score);
  ol.replaceChildren();
  rows.forEach((r, i) => {
    const p = byId.get(r.id);
    ol.append(el('li', { class: r.id === s.you.id ? 'me' : '' },
      el('span', { class: 'pos', textContent: ['🥇', '🥈', '🥉'][i] || String(i + 1) }),
      el('span', {}, el('span', { class: 'dot', style: `display:inline-block;width:10px;height:10px;border-radius:50%;margin-right:8px;background:${p?.color}` }), (p?.name || '?')),
      el('span', { class: 'gain', textContent: withGain && r.gain ? `+${r.gain}` : '' }),
      el('span', { class: 'tot', textContent: String(r.score) })));
  });
  return rows;
}

function renderRound(s) {
  show('round');
  const res = s.result, byId = names();
  const iAmGhost = s.ghostIds.includes(s.you.id);
  const hunterWin = res.reason === 'caught';
  $('round-title').textContent = hunterWin ? '🎯 ¡LOS CAZADORES GANAN!' : '👻 ¡EL FANTASMA SE SALVA!';
  $('round-sub').textContent = res.ghosts.map((g) => {
    const nm = byId.get(g.id)?.name;
    if (g.abandoned) return `${nm} se desconectó.`;
    return g.caught ? `${nm} fue atrapado por ${byId.get(g.caughtBy)?.name} a los ${g.survivedSec} s.` : `${nm} sobrevivió toda la ronda.`;
  }).join(' ');
  rankingList(s, $('round-table'), true);
  const last = s.round.index + 1 >= s.round.total;
  const left = Math.max(0, Math.ceil((s.nextAt - serverNow()) / 1000));
  $('round-next').textContent = last ? `Clasificación final en ${left} s` : `Siguiente ronda en ${left} s`;
  $('btn-skip').classList.toggle('hidden', !s.you.isHost);
  $('btn-skip').textContent = last ? 'VER CLASIFICACIÓN' : 'SIGUIENTE RONDA';
  const key = `end:${s.round.index}`;
  if (key !== lastPhaseKey) {
    lastPhaseKey = key;
    (hunterWin !== iAmGhost ? sfx.win : sfx.lose)();
    vibrate(hunterWin !== iAmGhost ? [60, 40, 60, 40, 160] : [200]);
  }
}
$('btn-skip').onclick = () => socket.emit('game:skip', {}, () => {});

function renderFinal(s) {
  show('final');
  const rows = rankingList(s, $('final-table'), false);
  const pod = $('podium'); pod.replaceChildren();
  const byId = names();
  const order = [1, 0, 2].filter((i) => rows[i]);
  for (const i of order) {
    const p = byId.get(rows[i].id);
    pod.append(el('div', { class: `step p${i + 1}` },
      el('div', { textContent: ['🥇', '🥈', '🥉'][i], style: 'font-size:26px' }),
      el('div', { class: 'nm', textContent: p?.name || '?' }),
      el('div', { textContent: `${rows[i].score} pts` })));
  }
  $('btn-rematch').classList.toggle('hidden', !s.you.isHost);
  $('final-wait').classList.toggle('hidden', s.you.isHost);
  if (lastPhaseKey !== 'final') { lastPhaseKey = 'final'; (rows[0]?.id === s.you.id ? sfx.win : sfx.click)(); }
}
$('btn-rematch').onclick = () => socket.emit('room:rematch', {}, () => {});

// ------------------------------------------------------------------ recepción de estado
socket.on('state', (s) => {
  offset = s.serverNow - Date.now();
  const prev = state;
  state = s;
  if (s.phase === 'lobby') lastPhaseKey = '';
  if (prev?.phase === 'roundEnd' && s.phase !== 'roundEnd') { /* nueva ronda */ }
  switch (s.phase) {
    case 'lobby': renderLobby(s); break;
    case 'countdown': case 'playing': renderGame(s); break;
    case 'roundEnd': renderRound(s); break;
    case 'final': renderFinal(s); break;
    default: break;
  }
});
setInterval(() => {
  if (state?.phase === 'roundEnd') renderRound(state);
}, 500);

// pantalla encendida durante la partida (si el navegador lo permite)
let wake = null;
async function requestWake() { try { wake = await navigator.wakeLock?.request('screen'); wake?.addEventListener('release', () => { wake = null; }); } catch { /* no disponible */ } }
document.addEventListener('visibilitychange', async () => {
  if (document.visibilityState === 'visible' && state && ['countdown', 'playing'].includes(state.phase)) {
    requestWake();
  }
});
