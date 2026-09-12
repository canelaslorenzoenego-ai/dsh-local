// screenshot.cjs — renders DSH Local product screenshots as PNGs, zero dependencies.
// Bitmap 5x7 font + integer rasterizer + hand-rolled PNG encoder (RGBA8 + zlib).
// Self-verifying: samples key pixels after render and fails loudly on drift.
// Run: node scripts/screenshot.cjs
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

// ---------- 5x7 bitmap font (col bits: 0x10 = leftmost column) ----------
const F = {
  A: [0x0E,0x11,0x11,0x1F,0x11,0x11,0x11], B: [0x1E,0x11,0x11,0x1E,0x11,0x11,0x1E],
  C: [0x0E,0x11,0x10,0x10,0x10,0x11,0x0E], D: [0x1E,0x11,0x11,0x11,0x11,0x11,0x1E],
  E: [0x1F,0x10,0x10,0x1E,0x10,0x10,0x1F], F: [0x1F,0x10,0x10,0x1E,0x10,0x10,0x10],
  G: [0x0E,0x11,0x10,0x17,0x11,0x11,0x0F], H: [0x11,0x11,0x11,0x1F,0x11,0x11,0x11],
  I: [0x0E,0x04,0x04,0x04,0x04,0x04,0x0E], J: [0x07,0x02,0x02,0x02,0x02,0x12,0x0C],
  K: [0x11,0x12,0x14,0x18,0x14,0x12,0x11], L: [0x10,0x10,0x10,0x10,0x10,0x10,0x1F],
  M: [0x11,0x1B,0x15,0x15,0x11,0x11,0x11], N: [0x11,0x11,0x19,0x15,0x13,0x11,0x11],
  O: [0x0E,0x11,0x11,0x11,0x11,0x11,0x0E], P: [0x1E,0x11,0x11,0x1E,0x10,0x10,0x10],
  Q: [0x0E,0x11,0x11,0x11,0x15,0x12,0x0D], R: [0x1E,0x11,0x11,0x1E,0x14,0x12,0x11],
  S: [0x0F,0x10,0x10,0x0E,0x01,0x01,0x1E], T: [0x1F,0x04,0x04,0x04,0x04,0x04,0x04],
  U: [0x11,0x11,0x11,0x11,0x11,0x11,0x0E], V: [0x11,0x11,0x11,0x11,0x11,0x0A,0x04],
  W: [0x11,0x11,0x11,0x15,0x15,0x15,0x0A], X: [0x11,0x11,0x0A,0x04,0x0A,0x11,0x11],
  Y: [0x11,0x11,0x0A,0x04,0x04,0x04,0x04], Z: [0x1F,0x01,0x02,0x04,0x08,0x10,0x1F],
  a: [0x00,0x00,0x0E,0x01,0x0F,0x11,0x0F], b: [0x10,0x10,0x1E,0x11,0x11,0x11,0x1E],
  c: [0x00,0x00,0x0E,0x10,0x10,0x11,0x0E], d: [0x01,0x01,0x0F,0x11,0x11,0x11,0x0F],
  e: [0x00,0x00,0x0E,0x11,0x1F,0x10,0x0E], f: [0x06,0x09,0x08,0x0E,0x08,0x08,0x08],
  g: [0x00,0x0F,0x11,0x11,0x0F,0x01,0x0E], h: [0x10,0x10,0x1E,0x11,0x11,0x11,0x11],
  i: [0x04,0x00,0x04,0x04,0x04,0x04,0x04], j: [0x02,0x00,0x02,0x02,0x02,0x12,0x0C],
  k: [0x10,0x10,0x12,0x14,0x18,0x14,0x12], l: [0x0C,0x04,0x04,0x04,0x04,0x04,0x0E],
  m: [0x00,0x00,0x1A,0x15,0x15,0x15,0x15], n: [0x00,0x00,0x1E,0x11,0x11,0x11,0x11],
  o: [0x00,0x00,0x0E,0x11,0x11,0x11,0x0E], p: [0x00,0x00,0x1E,0x11,0x11,0x1E,0x10],
  q: [0x00,0x00,0x0F,0x11,0x11,0x0F,0x01], r: [0x00,0x00,0x0E,0x11,0x10,0x10,0x10],
  s: [0x00,0x00,0x0F,0x10,0x0E,0x01,0x1E], t: [0x04,0x04,0x0E,0x04,0x04,0x05,0x02],
  u: [0x00,0x00,0x11,0x11,0x11,0x13,0x0D], v: [0x00,0x00,0x11,0x11,0x11,0x0A,0x04],
  w: [0x00,0x00,0x11,0x11,0x15,0x15,0x0A], x: [0x00,0x00,0x11,0x0A,0x04,0x0A,0x11],
  y: [0x00,0x00,0x11,0x11,0x0F,0x01,0x0E], z: [0x00,0x00,0x1F,0x02,0x04,0x08,0x1F],
  0: [0x0E,0x11,0x13,0x15,0x19,0x11,0x0E], 1: [0x04,0x0C,0x04,0x04,0x04,0x04,0x0E],
  2: [0x0E,0x11,0x01,0x06,0x08,0x10,0x1F], 3: [0x1F,0x02,0x04,0x02,0x01,0x11,0x0E],
  4: [0x02,0x06,0x0A,0x12,0x1F,0x02,0x02], 5: [0x1F,0x10,0x1E,0x01,0x01,0x11,0x0E],
  6: [0x06,0x08,0x10,0x1E,0x11,0x11,0x0E], 7: [0x1F,0x01,0x02,0x04,0x08,0x08,0x08],
  8: [0x0E,0x11,0x11,0x0E,0x11,0x11,0x0E], 9: [0x0E,0x11,0x11,0x0F,0x01,0x02,0x0C],
  '.': [0,0,0,0,0,0x0C,0x0C], ',': [0,0,0,0,0x0C,0x04,0x08],
  ':': [0,0x0C,0x0C,0,0x0C,0x0C,0], ';': [0,0x0C,0x0C,0,0x0C,0x0C,0x04],
  '-': [0,0,0,0x1F,0,0,0], '/': [0x01,0x01,0x02,0x04,0x08,0x10,0x10],
  '#': [0x0A,0x1F,0x0A,0x0A,0x0A,0x1F,0x0A], '=': [0,0,0x1F,0,0x1F,0,0],
  '(': [0x02,0x04,0x08,0x08,0x08,0x04,0x02], ')': [0x08,0x04,0x02,0x02,0x02,0x04,0x08],
  '+': [0,0x04,0x04,0x1F,0x04,0x04,0], '%': [0x19,0x1A,0x02,0x04,0x08,0x0B,0x13],
  '?': [0x0E,0x11,0x01,0x02,0x04,0,0x04], '!': [0x04,0x04,0x04,0x04,0x04,0,0x04],
  '_': [0,0,0,0,0,0,0x1F], "'": [0x04,0x04,0,0,0,0,0],
  '&': [0x0C,0x12,0x14,0x08,0x15,0x12,0x0D], '"': [0x0A,0x0A,0,0,0,0,0],
  '*': [0,0x15,0x0E,0x1F,0x0E,0x15,0], '@': [0x0E,0x11,0x17,0x15,0x17,0x10,0x0F],
  '>': [0x08,0x04,0x02,0x01,0x02,0x04,0x08], '<': [0x02,0x04,0x08,0x10,0x08,0x04,0x02],
  '[': [0x0E,0x08,0x08,0x08,0x08,0x08,0x0E], ']': [0x0E,0x02,0x02,0x02,0x02,0x02,0x0E],
  '|': [0x04,0x04,0x04,0x04,0x04,0x04,0x04], '^': [0x04,0x0A,0x11,0,0,0,0],
  '~': [0,0,0x08,0x15,0x02,0,0], $: [0x04,0x0F,0x14,0x0E,0x05,0x1E,0x04],
  '·': [0,0,0x0C,0x0C,0,0,0],
};

// ---------- palette (mirrors res/values/colors.xml) ----------
const BG='#0B0E14', SURFACE='#121722', SURFACE2='#1A2130', STROKE='#263043',
  TEXT='#E8EDF7', MUTED='#8B96AC', ACCENT='#4D6BFE', ACCENT_D='#3D55D8',
  ACCENT2='#8FA6FF', GREEN='#2FD575', AMBER='#F5B942', SESS_BG='#14251B',
  SESS_BG2='#101A26', SESS_STROKE='#2E5C3E', DARKWELL='#0D1119';

// ---------- raster canvas ----------
let W, H, px;
function init(w, h) { W = w; H = h; px = new Uint8Array(W * H * 4); }
function hex(c) {
  const h = c.replace('#', '');
  return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)];
}
function lerp(a, b, t) { return Math.round(a + (b - a) * t); }
function setPx(x, y, r, g, b, a) {
  x |= 0; y |= 0;
  if (x < 0 || y < 0 || x >= W || y >= H) return;
  if (!(a > 0)) return;
  if (a > 255) a = 255;
  const i = (y * W + x) * 4, ia = a / 255;
  px[i] = Math.round(px[i] * (1 - ia) + r * ia);
  px[i + 1] = Math.round(px[i + 1] * (1 - ia) + g * ia);
  px[i + 2] = Math.round(px[i + 2] * (1 - ia) + b * ia);
  px[i + 3] = 255;
}
function coverage(x, y, x0, y0, w, h, r) {
  if (r <= 0) return 1; // sharp rect: loop bounds already confine to the rect
  const dx = Math.max(x0 + r - x, x - (x0 + w - r), 0);
  const dy = Math.max(y0 + r - y, y - (y0 + h - r), 0);
  const d = Math.sqrt(dx * dx + dy * dy);
  if (d <= r - 1) return 1;
  if (d > r) return Math.max(0, 1 - (d - r));
  return r - d;
}
function fillRR(x0, y0, w, h, r, paint) {
  r = Math.min(r, w / 2, h / 2);
  for (let y = Math.max(0, Math.floor(y0)); y < Math.min(H, Math.ceil(y0 + h)); y++) {
    for (let x = Math.max(0, Math.floor(x0)); x < Math.min(W, Math.ceil(x0 + w)); x++) {
      const a = coverage(x, y, x0, y0, w, h, r);
      if (a <= 0) continue;
      const p = paint(x, y);
      setPx(x, y, p[0], p[1], p[2], p[3] * a);
    }
  }
}
function rect(x, y, w, h, r, fill) {
  const [cr, cg, cb] = hex(fill);
  fillRR(x, y, w, h, r || 0, () => [cr, cg, cb, 255]);
}
function grad(x, y, w, h, r, c1, c2, vertical) {
  const [r1, g1, b1] = hex(c1), [r2, g2, b2] = hex(c2);
  const span = vertical ? h : w;
  fillRR(x, y, w, h, r || 0, (x2, y2) => {
    const t = Math.min(1, Math.max(0, (vertical ? y2 - y : x2 - x) / Math.max(1, span)));
    return [lerp(r1, r2, t), lerp(g1, g2, t), lerp(b1, b2, t), 255];
  });
}
function circle(cx, cy, rad, fill) {
  const [r, g, b] = hex(fill);
  for (let y = Math.floor(cy - rad) - 1; y <= Math.ceil(cy + rad) + 1; y++) {
    for (let x = Math.floor(cx - rad) - 1; x <= Math.ceil(cx + rad) + 1; x++) {
      const d = Math.sqrt((x - cx) ** 2 + (y - cy) ** 2);
      const a = Math.max(0, Math.min(1, rad - d + 0.5));
      if (a > 0) setPx(x, y, r, g, b, a * 255);
    }
  }
}
function hline(x1, x2, y, color, w) {
  const [r, g, b] = hex(color);
  for (let x = Math.round(x1); x <= Math.round(x2); x++)
    for (let dy = 0; dy < (w || 2); dy++) setPx(x, y + dy, r, g, b, 255);
}

// ---------- text ----------
function textW(s, scale) { return s.length * 6 * scale - scale; }
function drawText(s, x, y, scale, color, opts) {
  opts = opts || {};
  if (opts.align === 'center') x -= textW(s, scale) / 2;
  if (opts.align === 'right') x -= textW(s, scale);
  const [r, g, b] = hex(color);
  x = Math.round(x); y = Math.round(y);
  let cx = x;
  for (const raw of String(s)) {
    let ch = raw;
    if (ch === '—' || ch === '–') ch = '-';
    if (ch === '…') { cx += 6 * scale; continue; }
    const gl = F[ch] || F[ch.toLowerCase()] || (ch === ' ' ? null : F['?']);
    if (gl) {
      for (let row = 0; row < 7; row++) {
        const bits = gl[row];
        for (let col = 0; col < 5; col++) {
          if (bits & (1 << (4 - col))) {
            for (let sy = 0; sy < scale; sy++)
              for (let sx = 0; sx < scale; sx++)
                setPx(cx + col * scale + sx, y + row * scale + sy, r, g, b, 255);
          }
        }
      }
    }
    cx += 6 * scale;
  }
}

// ---------- PNG encoder ----------
function crc32(buf) {
  let t = crc32.t;
  if (!t) {
    t = crc32.t = new Int32Array(256);
    for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1; t[n] = c; }
  }
  let c = -1;
  for (let i = 0; i < buf.length; i++) c = t[(c ^ buf[i]) & 0xFF] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}
function encodePNG() {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(W, 0); ihdr.writeUInt32BE(H, 4);
  ihdr[8] = 8; ihdr[9] = 6;
  const raw = Buffer.alloc((W * 4 + 1) * H);
  let o = 0;
  for (let y = 0; y < H; y++) {
    raw[o++] = 0;
    for (let x = 0; x < W; x++) {
      const i = (y * W + x) * 4;
      raw[o++] = px[i]; raw[o++] = px[i + 1]; raw[o++] = px[i + 2]; raw[o++] = px[i + 3];
    }
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]),
    chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw, { level: 9 })), chunk('IEND', Buffer.alloc(0)),
  ]);
}
function getPixel(x, y) {
  const i = (y * W + x) * 4;
  return [px[i], px[i + 1], px[i + 2]];
}
function check(name, x, y, want) {
  const got = getPixel(x, y), w = hex(want);
  const ok = Math.abs(got[0] - w[0]) <= 2 && Math.abs(got[1] - w[1]) <= 2 && Math.abs(got[2] - w[2]) <= 2;
  console.log('   ' + (ok ? 'ok  ' : 'FAIL') + ' ' + name + '  got(' + got + ') want(' + w + ')');
  if (!ok) process.exitCode = 1;
}

// ============================================================
// Screenshot 1 — native dashboard (1080 x 2100)
// ============================================================
function dashboard() {
  init(1080, 2100);
  rect(0, 0, W, H, 0, BG);

  // status bar
  drawText('10:42', 60, 52, 3, TEXT);
  circle(836, 66, 7, TEXT); circle(868, 66, 7, TEXT); circle(900, 66, 7, TEXT);
  rect(930, 46, 110, 40, 12, SURFACE2);
  rect(936, 52, 84, 28, 6, GREEN);
  rect(1044, 56, 8, 20, 4, STROKE);

  // header
  drawText('DSH Local', 60, 150, 5, TEXT);
  rect(820, 150, 200, 64, 32, SESS_BG);
  circle(860, 182, 10, GREEN);
  drawText('env ok', 884, 171, 2, GREEN);

  // tabs
  rect(36, 290, 340, 80, 24, '#1B2640');
  drawText('Dashboard', 36 + 170, 316, 3, TEXT, { align: 'center' });
  drawText('Terminal', 466, 316, 3, MUTED);
  drawText('Settings', 800, 316, 3, MUTED);
  hline(36, W - 36, 388, '#18202F', 2);

  // ---- session card ----
  const SY = 420;
  grad(44, SY, W - 88, 250, 34, SESS_BG, SESS_BG2, true);
  hline(44, W - 44, SY, SESS_STROKE, 2);
  circle(96, SY + 56, 10, GREEN);
  drawText('SESSION ACTIVE', 122, SY + 44, 3, GREEN);
  drawText('Only this link opens the console', 64, SY + 88, 2, MUTED);
  rect(64, SY + 116, W - 168, 60, 14, DARKWELL);
  drawText('http://127.0.0.1:3080/#token=9fK3mQ2vR8x', 84, SY + 134, 2, ACCENT2);
  const sw = (W - 88 - 128 - 24) / 2;
  rect(64, SY + 196, sw, 48, 14, SURFACE2);
  drawText('Copy link', 64 + sw / 2, SY + 210, 2, TEXT, { align: 'center' });
  rect(64 + sw + 24, SY + 196, sw, 48, 14, SURFACE2);
  drawText('Rotate token', 64 + sw + 24 + sw / 2, SY + 210, 2, TEXT, { align: 'center' });

  // ---- harness card ----
  const HY = 710;
  rect(44, HY, W - 88, 380, 34, SURFACE);
  hline(44, W - 44, HY, STROKE, 2);
  circle(112, HY + 72, 14, GREEN);
  drawText('Online - 34ms', 152, HY + 58, 3, GREEN);
  drawText('dsh - DeepSeek Harness', 64, HY + 124, 2, TEXT);
  drawText('19 tools live - session token active', 64, HY + 156, 2, MUTED);
  const bw = (W - 88 - 128 - 24) / 2;
  grad(64, HY + 210, bw, 90, 20, ACCENT_D, ACCENT, false);
  drawText('Stop', 64 + bw / 2, HY + 244, 3, '#FFFFFF', { align: 'center' });
  rect(64 + bw + 24, HY + 210, bw, 90, 20, SURFACE2);
  drawText('Open', 64 + bw + 24 + bw / 2, HY + 244, 3, TEXT, { align: 'center' });

  // ---- gateway card ----
  const GY = 1130;
  rect(44, GY, W - 88, 380, 34, SURFACE);
  hline(44, W - 44, GY, STROKE, 2);
  circle(112, GY + 72, 14, GREEN);
  drawText('Online - 12ms', 152, GY + 58, 3, GREEN);
  drawText('gateway + terminal', 64, GY + 124, 2, TEXT);
  drawText('OpenAI-compatible - 127.0.0.1:8787', 64, GY + 156, 2, MUTED);
  grad(64, GY + 210, bw, 90, 20, ACCENT_D, ACCENT, false);
  drawText('Stop', 64 + bw / 2, GY + 244, 3, '#FFFFFF', { align: 'center' });
  rect(64 + bw + 24, GY + 210, bw, 90, 20, SURFACE2);
  drawText('Open', 64 + bw + 24 + bw / 2, GY + 244, 3, TEXT, { align: 'center' });

  // bottom nav
  hline(0, W, 1900, '#18202F', 2);
  grad(0, 1902, W, 198, 0, '#0D1220', BG, true);
  const items = [['Dashboard', 270, true], ['Terminal', 540, false], ['Settings', 810, false]];
  for (const [label, cx, on] of items) {
    circle(cx, 1988, 10, on ? ACCENT : '#2A3550');
    drawText(label, cx, 2024, 2, on ? TEXT : MUTED, { align: 'center' });
  }

  // self-check
  console.log('dashboard checks:');
  check('background', 10, 1200, BG);
  check('harness card surface', 540, HY + 180, SURFACE);
  check('session dot', 96, SY + 56, GREEN);
  check('env dot', 860, 182, GREEN);
  check('title glyph', 62, 152, TEXT);
  check('gradient button', 100, HY + 255, '#3E57DB'); // t=0.086 of ACCENT_D->ACCENT

  return encodePNG();
}

// ============================================================
// Screenshot 2 — dsh web console (720 x 1560)
// ============================================================
function console2() {
  init(720, 1560);
  rect(0, 0, W, H, 0, BG);

  // session banner
  grad(16, 16, W - 32, 128, 18, SESS_BG, SESS_BG2, true);
  hline(16, W - 16, 16, SESS_STROKE, 2);
  circle(44, 44, 7, GREEN);
  drawText('SESSION ACTIVE', 60, 34, 2, GREEN);
  drawText('http://127.0.0.1:3080/#token=9fK3mQ2vR8x', 32, 66, 2, ACCENT2);
  rect(32, 96, 120, 32, 8, SURFACE2);
  drawText('Copy', 92, 104, 2, TEXT, { align: 'center' });
  rect(164, 96, 120, 32, 8, SURFACE2);
  drawText('Rotate', 224, 104, 2, TEXT, { align: 'center' });
  rect(296, 96, 120, 32, 8, SURFACE2);
  drawText('Share', 356, 104, 2, TEXT, { align: 'center' });

  // title + chips
  drawText('DSH Console', 24, 170, 4, TEXT);
  drawText('DeepSeek Harness - localhost - on-device', 24, 214, 2, MUTED);
  let cx2 = 24;
  for (const [label, ok] of [['Harness', true], ['Gateway', true], ['Node v22.23', true]]) {
    const w2 = textW(label, 2) + 56;
    rect(cx2, 248, w2, 40, 20, '#16202E');
    circle(cx2 + 20, 268, 6, ok ? GREEN : '#F45B69');
    drawText(label, cx2 + 34, 259, 2, MUTED);
    cx2 += w2 + 12;
  }

  // nav pills
  let nx = 24;
  const tabs2 = [['Presets', true], ['Overview', false], ['Chat', true], ['Files', false], ['Plugins', false]];
  for (const [label, active] of tabs2) {
    const w2 = textW(label, 2) + 32;
    rect(nx, 308, w2, 44, 14, active ? '#1B2640' : '#141B29');
    drawText(label, nx + w2 / 2, 320, 2, active ? TEXT : MUTED, { align: 'center' });
    nx += w2 + 10;
  }

  // chat card
  rect(16, 380, W - 32, 420, 18, SURFACE);
  const uw = textW('Run the test suite and fix failures', 2) + 24;
  grad(W - 32 - uw, 404, uw, 40, 14, ACCENT_D, ACCENT, false);
  drawText('Run the test suite and fix failures', W - 32 - uw + 12, 416, 2, '#FFFFFF');
  rect(24, 460, 500, 88, 14, SURFACE2);
  drawText('Standard preset active - running vitest.', 40, 476, 2, TEXT);
  drawText('3 failures fixed - 41 passing.', 40, 502, 2, TEXT);
  rect(36, 724, 500, 56, 14, DARKWELL);
  drawText('Message the model...', 52, 744, 2, MUTED);
  grad(552, 724, 120, 56, 14, ACCENT_D, ACCENT, false);
  drawText('Send', 612, 744, 2, '#FFFFFF', { align: 'center' });

  // usage card
  rect(16, 824, W - 32, 210, 18, SURFACE);
  drawText('Model usage', 36, 846, 3, TEXT);
  drawText('6 completions metered - 2 models', 36, 882, 2, MUTED);
  const bars = [['local', 64, 'deepseek'], ['dsk', 44, ''], ['gpt', 26, ''], ['claude', 14, '']];
  const bx = [48, 208, 368, 528];
  const bws = [110, 110, 110, 110];
  const hs = [64, 44, 26, 14];
  const bl = ['local-harness', 'deepseek', 'gpt-4o', 'claude'];
  for (let i = 0; i < 4; i++) {
    grad(bx[i], 946 - hs[i], bws[i], hs[i], 4, ACCENT2, ACCENT, true);
    drawText(bl[i], bx[i] + bws[i] / 2, 954, 2, MUTED, { align: 'center' });
  }

  // activity card
  rect(16, 1058, W - 32, 250, 18, SURFACE);
  drawText('Activity', 36, 1080, 3, TEXT);
  rect(596, 1076, 88, 34, 8, SURFACE2);
  drawText('Clear', 640, 1085, 2, TEXT, { align: 'center' });
  const rows = [
    ['Harness online', 'just now', GREEN],
    ['Preset applied: Standard', '2m ago', ACCENT],
    ['API key stored: deepseek', '5m ago', ACCENT],
    ['File saved: notes/todo.md', '12m ago', AMBER],
  ];
  let ry = 1130;
  for (const [t, when, col] of rows) {
    circle(48, ry + 7, 6, col);
    drawText(t, 68, ry, 2, TEXT);
    drawText(when, W - 40, ry, 2, MUTED, { align: 'right' });
    ry += 42;
  }

  // footer
  drawText('Token-gated - localhost only - nothing leaves this device', W / 2, 1380, 2, MUTED, { align: 'center' });
  drawText('dsh-local v2.7.0', W / 2, 1420, 2, STROKE, { align: 'center' });

  // self-check
  console.log('console checks:');
  check('background', 700, 1520, BG);
  check('user bubble gradient', 280, 410, '#3E57DB'); // same gradient, t=0.077
  check('bot bubble', 460, 470, SURFACE2);
  check('usage bar', 100, 940, '#5371FE'); // t=0.906 of ACCENT2->ACCENT vertical
  check('chat card', 360, 700, SURFACE);

  return encodePNG();
}

// ---------- main ----------
const docs = path.join(__dirname, '..', 'docs');
fs.mkdirSync(docs, { recursive: true });
const pub = path.join(__dirname, '..', 'public');
fs.mkdirSync(pub, { recursive: true });

const shots = [
  ['screenshot-dashboard.png', dashboard],
  ['screenshot-console.png', console2],
];
for (const [name, fn] of shots) {
  console.log('rendering ' + name + '...');
  const png = fn();
  fs.writeFileSync(path.join(docs, name), png);
  fs.writeFileSync(path.join(pub, name), png);
  console.log('   wrote docs/' + name + ' + public/' + name + ' (' + Math.round(png.length / 1024) + ' KB)');
}
console.log(process.exitCode ? 'SCREENSHOT CHECKS FAILED' : 'ALL SCREENSHOT CHECKS PASSED');
