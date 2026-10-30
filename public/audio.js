// Sonidos sintetizados con WebAudio: sin archivos externos, todo original.
let ctx = null;
let muted = false;
try { muted = localStorage.getItem('fet.muted') === '1'; } catch {}

function ac() {
  if (!ctx) {
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return null;
    ctx = new AC();
  }
  if (ctx.state === 'suspended') ctx.resume();
  return ctx;
}

function tone(freq, dur = 0.15, { type = 'sine', vol = 0.2, slideTo = null, delay = 0 } = {}) {
  if (muted) return;
  const c = ac(); if (!c) return;
  const t = c.currentTime + delay;
  const o = c.createOscillator(), g = c.createGain();
  o.type = type;
  o.frequency.setValueAtTime(freq, t);
  if (slideTo) o.frequency.exponentialRampToValueAtTime(slideTo, t + dur);
  g.gain.setValueAtTime(0.0001, t);
  g.gain.exponentialRampToValueAtTime(vol, t + 0.01);
  g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
  o.connect(g).connect(c.destination);
  o.start(t); o.stop(t + dur + 0.02);
}

function noise(dur = 0.3, vol = 0.2, delay = 0) {
  if (muted) return;
  const c = ac(); if (!c) return;
  const len = Math.floor(c.sampleRate * dur);
  const buf = c.createBuffer(1, len, c.sampleRate);
  const d = buf.getChannelData(0);
  for (let i = 0; i < len; i++) d[i] = (Math.random() * 2 - 1) * (1 - i / len);
  const s = c.createBufferSource(), g = c.createGain();
  s.buffer = buf; g.gain.value = vol;
  s.connect(g).connect(c.destination);
  s.start(c.currentTime + delay);
}

export const sfx = {
  unlock() { ac(); },
  isMuted: () => muted,
  setMuted(m) { muted = m; try { localStorage.setItem('fet.muted', m ? '1' : '0'); } catch {} },
  tick: () => tone(660, 0.08, { type: 'square', vol: 0.08 }),
  go: () => { tone(880, 0.25, { type: 'square', vol: 0.12 }); tone(1320, 0.3, { type: 'square', vol: 0.1, delay: 0.1 }); },
  step: () => tone(180, 0.04, { type: 'triangle', vol: 0.05 }),
  // latido: más grave cuanto más cerca, el ritmo lo marca la UI
  beat(heat) {
    const f = 55 + heat * 12;
    tone(f, 0.12, { vol: 0.28 });
    tone(f * 0.8, 0.14, { vol: 0.22, delay: 0.14 });
  },
  scare() { noise(0.35, 0.25); tone(900, 0.4, { type: 'sawtooth', vol: 0.15, slideTo: 90 }); },
  trap() { tone(420, 0.3, { type: 'square', vol: 0.15, slideTo: 60 }); noise(0.15, 0.18); },
  trapSet() { tone(300, 0.1, { type: 'triangle', vol: 0.12 }); tone(450, 0.1, { type: 'triangle', vol: 0.12, delay: 0.08 }); },
  flash() { tone(1200, 0.35, { type: 'sine', vol: 0.18, slideTo: 2400 }); },
  alert() { tone(300, 0.15, { type: 'sawtooth', vol: 0.15 }); tone(300, 0.15, { type: 'sawtooth', vol: 0.15, delay: 0.22 }); },
  caught() { [523, 659, 784, 1046].forEach((f, i) => tone(f, 0.18, { type: 'square', vol: 0.12, delay: i * 0.09 })); },
  win() { [523, 659, 784, 1046, 1318].forEach((f, i) => tone(f, 0.25, { type: 'triangle', vol: 0.18, delay: i * 0.12 })); },
  lose() { [392, 330, 262, 196].forEach((f, i) => tone(f, 0.3, { type: 'triangle', vol: 0.16, delay: i * 0.15 })); },
  click: () => tone(520, 0.05, { type: 'square', vol: 0.06 }),
};

export function vibrate(pattern) {
  try { if (!prefs.noVibrate && navigator.vibrate) navigator.vibrate(pattern); } catch {}
}

export const prefs = { noVibrate: false, reduceMotion: false };
try {
  prefs.noVibrate = localStorage.getItem('fet.novib') === '1';
  prefs.reduceMotion = localStorage.getItem('fet.reduce') === '1' || window.matchMedia('(prefers-reduced-motion: reduce)').matches;
} catch {}
export function savePref(key, val) {
  prefs[key] = val;
  try { localStorage.setItem(key === 'noVibrate' ? 'fet.novib' : 'fet.reduce', val ? '1' : '0'); } catch {}
}
