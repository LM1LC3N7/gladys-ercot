// Generates cover.png (800x534) for gladys-ercot: plain Node, no dependency.
// A transmission tower and a lightning bolt over a dusk plain, and a screen
// with a 15-minute price curve and its bars, on a gradient (no brand logo).
// Usage: node scripts/cover.mjs cover.png
import { writeFileSync } from 'node:fs';
import { deflateSync } from 'node:zlib';

const W = 800;
const H = 534;
const px = Buffer.alloc(W * H * 3);
const set = (x, y, [r, g, b], a = 1) => {
  if (x < 0 || y < 0 || x >= W || y >= H) return;
  const i = (y * W + x) * 3;
  px[i] = px[i] * (1 - a) + r * a;
  px[i + 1] = px[i + 1] * (1 - a) + g * a;
  px[i + 2] = px[i + 2] * (1 - a) + b * a;
};
const skyAt = (x, y) => {
  const t = (x / W) * 0.7 + (y / H) * 0.3;
  return [40 + 160 * t, 70 + 40 * t, 140 - 60 * t];
};
for (let y = 0; y < H; y += 1) {
  for (let x = 0; x < W; x += 1) {
    set(x, y, skyAt(x, y));
  }
}
const white = [255, 255, 255];
const dark = [28, 38, 64];
const sun = [255, 200, 50];
const disc = (cx, cy, r, color, alpha = 1) => {
  for (let y = Math.floor(cy - r - 1); y <= cy + r + 1; y += 1) {
    for (let x = Math.floor(cx - r - 1); x <= cx + r + 1; x += 1) {
      const a = Math.max(0, Math.min(1, r - Math.hypot(x - cx, y - cy) + 0.5));
      if (a > 0) set(x, y, color, a * alpha);
    }
  }
};
const box = (x0, y0, x1, y1, r, color, alpha = 1) => {
  for (let y = y0; y < y1; y += 1) {
    for (let x = x0; x < x1; x += 1) {
      const cx = Math.min(Math.max(x, x0 + r), x1 - r);
      const cy = Math.min(Math.max(y, y0 + r), y1 - r);
      const a = Math.max(0, Math.min(1, r - Math.hypot(x - cx, y - cy) + 0.5));
      if (a > 0) set(x, y, color, a * alpha);
    }
  }
};
const line = (x0, y0, x1, y1, width, color) => {
  const minX = Math.floor(Math.min(x0, x1) - width);
  const maxX = Math.ceil(Math.max(x0, x1) + width);
  const minY = Math.floor(Math.min(y0, y1) - width);
  const maxY = Math.ceil(Math.max(y0, y1) + width);
  const len2 = (x1 - x0) ** 2 + (y1 - y0) ** 2 || 1;
  for (let y = minY; y <= maxY; y += 1) {
    for (let x = minX; x <= maxX; x += 1) {
      const t = Math.max(0, Math.min(1, ((x - x0) * (x1 - x0) + (y - y0) * (y1 - y0)) / len2));
      const d = Math.hypot(x - (x0 + t * (x1 - x0)), y - (y0 + t * (y1 - y0)));
      const a = Math.max(0, Math.min(1, width / 2 - d + 0.5));
      if (a > 0) set(x, y, color, a);
    }
  }
};

disc(400, 270, 260, white, 0.05);

// The setting sun.
disc(180, 300, 70, sun, 0.9);
// A flat plain.
for (let x = 0; x < W; x += 1) {
  const top = 400 + 12 * Math.sin((x / W) * Math.PI * 2);
  for (let y = Math.floor(top); y < H; y += 1) set(x, y, [150, 110, 70]);
}
// A transmission tower: legs, cross-arms and the wires.
const steel = [225, 230, 240];
line(260, 120, 210, 410, 8, steel);
line(260, 120, 310, 410, 8, steel);
for (const [y, half] of [
  [170, 70],
  [230, 55],
]) {
  line(260 - half, y, 260 + half, y, 7, steel);
}
for (let k = 0; k < 6; k += 1) {
  const y0 = 180 + k * 38;
  line(260 - 8 - k * 7, y0, 260 + 15 + k * 7, y0 + 36, 4, steel);
  line(260 + 8 + k * 7, y0, 260 - 15 - k * 7, y0 + 36, 4, steel);
}
for (const x of [190, 330]) line(x, 172, x < 260 ? 0 : 480, x < 260 ? 210 : 190, 3, white);
// The lightning bolt.
const bolt = [255, 215, 60];
line(120, 60, 95, 140, 12, bolt);
line(95, 140, 130, 140, 12, bolt);
line(130, 140, 100, 225, 12, bolt);

// The screen: the price of each quarter hour, a curve over its bars.
box(480, 80, 750, 340, 18, white);
box(500, 100, 730, 320, 10, dark);
const values = [28, 25, 22, 24, 30, 41, 55, 72, 95, 88, 64, 50, 43, 38, 34, 31];
const xs = values.map((_, i) => 515 + i * 13.5);
values.forEach((v, i) => {
  const h = (v / 100) * 190;
  const t = v / 100;
  box(Math.round(xs[i]), Math.round(305 - h), Math.round(xs[i] + 9), 305, 2, [
    80 + 150 * t,
    170 - 90 * t,
    120 - 60 * t,
  ]);
});
for (let i = 1; i < values.length; i += 1) {
  line(
    xs[i - 1] + 4.5,
    300 - (values[i - 1] / 100) * 190,
    xs[i] + 4.5,
    300 - (values[i] / 100) * 190,
    4,
    sun,
  );
}
// PNG encoding.
const crcTable = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
const crc = (buf) => {
  let c = 0xffffffff;
  for (const b of buf) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
};
const chunk = (type, data) => {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type), data]);
  const c = Buffer.alloc(4);
  c.writeUInt32BE(crc(td));
  return Buffer.concat([len, td, c]);
};
const ihdr = Buffer.alloc(13);
ihdr.writeUInt32BE(W, 0);
ihdr.writeUInt32BE(H, 4);
ihdr[8] = 8;
ihdr[9] = 2;
const raw = Buffer.alloc((W * 3 + 1) * H);
for (let y = 0; y < H; y += 1) {
  raw[y * (W * 3 + 1)] = 0;
  px.copy(raw, y * (W * 3 + 1) + 1, y * W * 3, (y + 1) * W * 3);
}
const png = Buffer.concat([
  Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
  chunk('IHDR', ihdr),
  chunk('IDAT', deflateSync(raw, { level: 9 })),
  chunk('IEND', Buffer.alloc(0)),
]);
writeFileSync(process.argv[2] ?? 'cover.png', png);
console.log('cover', png.length, 'bytes');
