// Dibujado del tablero en canvas 2D. Solo pinta lo que el servidor ha enviado.
import { prefs } from './audio.js';

const FLOOR_A = '#1a1530', FLOOR_B = '#171229';
const WALL_TOP = '#4b3b7a', WALL_SIDE = '#2b2150';

export class Board {
  constructor(canvas) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.size = 0;
    this.disp = new Map();   // id -> {x,y} suavizado
    this.rings = [];         // efectos: {x,y,t0,color}
    this.view = null;
  }

  resize(px) {
    const dpr = Math.min(window.devicePixelRatio || 1, 2.5);
    this.size = px;
    this.canvas.style.width = this.canvas.style.height = px + 'px';
    this.canvas.width = this.canvas.height = Math.floor(px * dpr);
    this.dpr = dpr;
  }

  setView(view) { this.view = view; }

  ring(x, y, color) { this.rings.push({ x, y, t0: performance.now(), color }); }

  smooth(id, tx, ty, dt) {
    let d = this.disp.get(id);
    if (!d) { d = { x: tx, y: ty }; this.disp.set(id, d); }
    const k = prefs.reduceMotion ? 1 : 1 - Math.pow(1e-6, dt);
    d.x += (tx - d.x) * k; d.y += (ty - d.y) * k;
    return d;
  }

  draw(now, dt, playersById, serverNow) {
    const v = this.view;
    const { ctx, size } = this;
    if (!v || !v.map || !size) return;
    const { w, h, rows } = v.map;
    const cs = size / w;
    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    ctx.clearRect(0, 0, size, size);

    // suelo
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      ctx.fillStyle = (x + y) % 2 ? FLOOR_A : FLOOR_B;
      ctx.fillRect(x * cs, y * cs, cs + 0.5, cs + 0.5);
    }
    // muros (muebles)
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      if (rows[y][x] !== '#') continue;
      ctx.fillStyle = WALL_SIDE;
      ctx.fillRect(x * cs + 1, y * cs + 1, cs - 2, cs - 2);
      ctx.fillStyle = WALL_TOP;
      ctx.fillRect(x * cs + 2, y * cs + 2, cs - 4, cs - 7);
      ctx.fillStyle = 'rgba(255,255,255,0.06)';
      ctx.fillRect(x * cs + 2, y * cs + 2, cs - 4, 3);
    }

    const t = now / 1000;
    const isGhost = v.role === 'ghost';
    const me = v.me;
    if (!me) return; // cuenta atrás: aún no hay posiciones, solo el plano de la casa

    // luz de los cazadores (se ve desde el fantasma)
    if (isGhost && v.hunters) {
      for (const hu of v.hunters) {
        const d = this.smooth(hu.id, hu.x, hu.y, dt);
        const g = ctx.createRadialGradient((d.x + .5) * cs, (d.y + .5) * cs, 0, (d.x + .5) * cs, (d.y + .5) * cs, cs * 3.4);
        g.addColorStop(0, 'rgba(255,214,102,0.22)'); g.addColorStop(1, 'rgba(255,214,102,0)');
        ctx.fillStyle = g;
        ctx.fillRect(0, 0, size, size);
      }
    }

    // trampas propias
    if (isGhost && v.traps) for (const tr of v.traps) this.drawTrap(tr.x, tr.y, cs, t);

    // huellas (cazador)
    if (v.trail) for (const p of v.trail) {
      const a = Math.max(0, 1 - p.age / 7000);
      ctx.fillStyle = `rgba(150,255,235,${0.55 * a})`;
      ctx.beginPath(); ctx.ellipse((p.x + .5) * cs, (p.y + .5) * cs, cs * .16, cs * .22, 0, 0, 7); ctx.fill();
    }

    // entidades
    if (v.role === 'hunter') {
      for (const hu of v.hunters || []) this.drawHunter(hu, playersById, cs, t, dt, false, serverNow);
      for (const gh of v.ghosts || []) this.drawGhost(gh.id, gh.x, gh.y, cs, t, dt, 1);
      this.drawHunter({ id: 'me', x: me.x, y: me.y, frozenUntil: me.frozenUntil }, playersById, cs, t, dt, true, serverNow);
    } else if (isGhost) {
      for (const hu of v.hunters || []) this.drawHunter(hu, playersById, cs, t, dt, false, serverNow);
      for (const pa of v.partners || []) if (!pa.caught) this.drawGhost(pa.id, pa.x, pa.y, cs, t, dt, 0.6);
      if (!me.caught) this.drawGhost('me', me.x, me.y, cs, t, dt, 1, true);
    }

    // niebla de guerra (solo cazadores): oscurece todo menos su radio de visión
    if (v.role === 'hunter') {
      const d = this.smooth('me', me.x, me.y, dt);
      const R = v.vision;
      for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
        const dist = Math.abs(x - d.x) + Math.abs(y - d.y);
        let a;
        if (dist <= R - 0.2) a = 0.0;
        else if (dist <= R + 1) a = 0.4;
        else a = 0.72;
        if (a > 0) { ctx.fillStyle = `rgba(6,4,16,${a})`; ctx.fillRect(x * cs, y * cs, cs + 0.5, cs + 0.5); }
        else {
          // luz cálida de la linterna: más intensa cerca del cazador
          ctx.fillStyle = `rgba(255,222,140,${0.2 * (1 - dist / (R + 1))})`;
          ctx.fillRect(x * cs, y * cs, cs + 0.5, cs + 0.5);
        }
      }
      // destello propio
      if (serverNow < me.revealUntil) {
        const k = (me.revealUntil - serverNow) / 2000;
        const g = ctx.createRadialGradient((d.x + .5) * cs, (d.y + .5) * cs, cs, (d.x + .5) * cs, (d.y + .5) * cs, cs * 4.5);
        g.addColorStop(0, `rgba(255,255,230,${0.35 * k})`); g.addColorStop(1, 'rgba(255,255,230,0)');
        ctx.fillStyle = g; ctx.fillRect(0, 0, size, size);
      }
    }

    // ondas
    this.rings = this.rings.filter((r) => now - r.t0 < 900);
    for (const r of this.rings) {
      const k = (now - r.t0) / 900;
      ctx.strokeStyle = r.color; ctx.globalAlpha = 1 - k; ctx.lineWidth = 3;
      ctx.beginPath(); ctx.arc((r.x + .5) * cs, (r.y + .5) * cs, cs * (0.5 + k * 3.5), 0, 7); ctx.stroke();
      ctx.globalAlpha = 1;
    }
  }

  drawTrap(x, y, cs, t) {
    const { ctx } = this;
    const cx = (x + .5) * cs, cy = (y + .5) * cs;
    ctx.save(); ctx.translate(cx, cy); ctx.rotate(t * 0.8);
    ctx.fillStyle = 'rgba(190,100,255,0.85)';
    ctx.beginPath();
    for (let i = 0; i < 8; i++) {
      const r = i % 2 ? cs * .14 : cs * .34, a = (i / 8) * Math.PI * 2;
      ctx.lineTo(Math.cos(a) * r, Math.sin(a) * r);
    }
    ctx.closePath(); ctx.fill(); ctx.restore();
  }

  drawHunter(hu, playersById, cs, t, dt, mine, serverNow = 0) {
    const { ctx } = this;
    const d = this.smooth(hu.id, hu.x, hu.y, dt);
    const cx = (d.x + .5) * cs, cy = (d.y + .5) * cs, r = cs * .36;
    const p = hu.id === 'me' ? playersById.get(this.view.youId) : playersById.get(hu.id);
    const color = p?.color || '#ffd23f';
    const frozen = hu.frozenUntil > serverNow;
    // linterna
    ctx.fillStyle = 'rgba(255,224,130,0.25)';
    ctx.beginPath(); ctx.arc(cx, cy, r * 1.5, 0, 7); ctx.fill();
    ctx.fillStyle = color;
    ctx.beginPath(); ctx.arc(cx, cy, r, 0, 7); ctx.fill();
    ctx.lineWidth = mine ? 3 : 1.5; ctx.strokeStyle = mine ? '#fff' : 'rgba(0,0,0,0.5)'; ctx.stroke();
    ctx.fillStyle = '#12091f'; ctx.font = `800 ${cs * .38}px system-ui, sans-serif`;
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.fillText((p?.name || '?')[0].toUpperCase(), cx, cy + 1);
    if (frozen) {
      ctx.strokeStyle = 'rgba(140,220,255,0.95)'; ctx.lineWidth = 3;
      ctx.beginPath(); ctx.arc(cx, cy, r * 1.25, 0, 7); ctx.stroke();
      ctx.fillStyle = 'rgba(140,220,255,0.3)'; ctx.fill();
    }
  }

  drawGhost(id, x, y, cs, t, dt, alpha, mine = false) {
    const { ctx } = this;
    const d = this.smooth(id, x, y, dt);
    const bob = prefs.reduceMotion ? 0 : Math.sin(t * 4 + d.x) * cs * .04;
    const cx = (d.x + .5) * cs, cy = (d.y + .5) * cs + bob, r = cs * .36;
    ctx.save(); ctx.globalAlpha = alpha;
    const g = ctx.createRadialGradient(cx, cy, r * .3, cx, cy, r * 2);
    g.addColorStop(0, 'rgba(160,140,255,0.45)'); g.addColorStop(1, 'rgba(160,140,255,0)');
    ctx.fillStyle = g; ctx.beginPath(); ctx.arc(cx, cy, r * 2, 0, 7); ctx.fill();
    ctx.fillStyle = mine ? '#ffffff' : '#e9e4ff';
    ctx.beginPath();
    ctx.arc(cx, cy - r * .1, r, Math.PI, 0);
    const bottom = cy + r * .85, n = 4, wv = (r * 2) / n;
    ctx.lineTo(cx + r, bottom);
    for (let i = 0; i < n; i++) {
      const xx = cx + r - (i + 1) * wv;
      ctx.quadraticCurveTo(xx + wv / 2, bottom - r * (i % 2 ? -.35 : .35) - r * .0, xx, bottom);
    }
    ctx.closePath(); ctx.fill();
    ctx.fillStyle = '#1b1035';
    ctx.beginPath(); ctx.arc(cx - r * .35, cy - r * .15, r * .16, 0, 7); ctx.arc(cx + r * .35, cy - r * .15, r * .16, 0, 7); ctx.fill();
    ctx.beginPath(); ctx.ellipse(cx, cy + r * .25, r * .14, r * .2, 0, 0, 7); ctx.fill();
    ctx.restore();
  }
}
