import { mulberry32 } from './rng.js';

const DIRS = [[1, 0], [-1, 0], [0, 1], [0, -1]];

/** Distancias BFS desde (sx,sy). -1 = inalcanzable / muro. */
export function bfs(map, sx, sy) {
  const { w, h, walls } = map;
  const dist = new Int16Array(w * h).fill(-1);
  if (walls[sy * w + sx]) return dist;
  const q = [sx + sy * w];
  dist[q[0]] = 0;
  for (let i = 0; i < q.length; i++) {
    const cur = q[i];
    const cx = cur % w, cy = (cur / w) | 0;
    for (const [dx, dy] of DIRS) {
      const nx = cx + dx, ny = cy + dy;
      if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
      const ni = ny * w + nx;
      if (walls[ni] || dist[ni] !== -1) continue;
      dist[ni] = dist[cur] + 1;
      q.push(ni);
    }
  }
  return dist;
}

/**
 * Genera una "casa" w×h: segmentos de pared sin tocarse (pasillos de ≥1 casilla),
 * se descarta cualquier zona aislada. Devuelve el mapa y los puntos de salida.
 */
export function generateMap(seed, w, h, hunterCount, ghostCount) {
  const rnd = mulberry32(seed);
  const walls = new Array(w * h).fill(false);
  const target = Math.floor(w * h * 0.2);
  let placed = 0;
  for (let tries = 0; tries < 4000 && placed < target; tries++) {
    const len = 2 + Math.floor(rnd() * 3);
    const horiz = rnd() < 0.5;
    const x = Math.floor(rnd() * w), y = Math.floor(rnd() * h);
    const cells = [];
    for (let i = 0; i < len; i++) cells.push([x + (horiz ? i : 0), y + (horiz ? 0 : i)]);
    if (cells.some(([cx, cy]) => cx >= w || cy >= h)) continue;
    // Margen: ninguna pared vecina (8 direcciones) para no formar bloques
    let ok = true;
    for (const [cx, cy] of cells) {
      for (let dy = -1; dy <= 1 && ok; dy++)
        for (let dx = -1; dx <= 1; dx++) {
          const nx = cx + dx, ny = cy + dy;
          if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
          if (cells.some(([ax, ay]) => ax === nx && ay === ny)) continue;
          if (walls[ny * w + nx]) { ok = false; break; }
        }
      if (!ok) break;
    }
    if (!ok) continue;
    for (const [cx, cy] of cells) walls[cy * w + cx] = true;
    placed += len;
  }

  // Punto de partida de los cazadores: casilla libre más cercana a la esquina (0,0)
  let start = -1, best = Infinity;
  for (let i = 0; i < walls.length; i++) {
    if (walls[i]) continue;
    const d = (i % w) + ((i / w) | 0);
    if (d < best) { best = d; start = i; }
  }
  const map = { w, h, walls };
  const sx = start % w, sy = (start / w) | 0;

  // Quedarse solo con la zona conectada con el punto de partida
  const reach = bfs(map, sx, sy);
  for (let i = 0; i < walls.length; i++) if (!walls[i] && reach[i] === -1) walls[i] = true;

  // Cazadores: las casillas más cercanas al punto de partida
  const open = [];
  for (let i = 0; i < walls.length; i++) if (!walls[i]) open.push(i);
  open.sort((a, b) => reach[a] - reach[b] || a - b);
  // separados (sin casillas contiguas) para que ninguno empiece encerrado por sus compañeros
  const picked = [];
  const adjacent = (a, b) => Math.abs((a % w) - (b % w)) + Math.abs(((a / w) | 0) - ((b / w) | 0)) === 1;
  for (const i of open) {
    if (picked.length === hunterCount) break;
    if (!picked.some((j) => adjacent(i, j))) picked.push(i);
  }
  for (const i of open) { if (picked.length === hunterCount) break; if (!picked.includes(i)) picked.push(i); }
  const hunterSpawns = picked.map((i) => ({ x: i % w, y: (i / w) | 0 }));

  // Fantasmas: lo más lejos posible, separados entre sí
  const far = open.slice().sort((a, b) => reach[b] - reach[a] || (rnd() < 0.5 ? -1 : 1));
  const ghostSpawns = [];
  for (const i of far) {
    const p = { x: i % w, y: (i / w) | 0 };
    if (ghostSpawns.every((g) => Math.abs(g.x - p.x) + Math.abs(g.y - p.y) >= 4)) ghostSpawns.push(p);
    if (ghostSpawns.length === ghostCount) break;
  }
  return { map, hunterSpawns, ghostSpawns };
}

export function mapToRows(map) {
  const rows = [];
  for (let y = 0; y < map.h; y++) {
    let r = '';
    for (let x = 0; x < map.w; x++) r += map.walls[y * map.w + x] ? '#' : '.';
    rows.push(r);
  }
  return rows;
}
