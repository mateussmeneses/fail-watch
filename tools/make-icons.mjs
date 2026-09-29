// Gera icones PNG simples para a extensao sem dependencias externas.
// Desenha um quadrado com cantos arredondados (fundo escuro) e um ponto de
// exclamacao vermelho no centro. PNG e escrito manualmente (chunks + zlib).
import { deflateSync } from 'node:zlib';
import { writeFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const outDir = join(__dirname, '..', 'icons');
mkdirSync(outDir, { recursive: true });

const BG = [30, 30, 30, 255]; // #1e1e1e
const MARK = [241, 76, 76, 255]; // #f14c4c
const TRANSPARENT = [0, 0, 0, 0];

function drawIcon(size) {
  const px = new Array(size * size);
  const r = size * 0.18; // raio do canto
  const cx = size / 2;

  function inRoundedRect(x, y) {
    const pad = size * 0.06;
    const left = pad, right = size - pad, top = pad, bottom = size - pad;
    if (x < left || x > right || y < top || y > bottom) return false;
    // cantos
    const corners = [
      [left + r, top + r],
      [right - r, top + r],
      [left + r, bottom - r],
      [right - r, bottom - r]
    ];
    const nearCornerX = x < left + r || x > right - r;
    const nearCornerY = y < top + r || y > bottom - r;
    if (nearCornerX && nearCornerY) {
      for (const [ccx, ccy] of corners) {
        if (Math.hypot(x - ccx, y - ccy) <= r) return true;
      }
      return false;
    }
    return true;
  }

  // ponto de exclamacao: barra vertical + ponto
  function inMark(x, y) {
    const barW = size * 0.14;
    const barTop = size * 0.24;
    const barBottom = size * 0.62;
    if (Math.abs(x - cx) <= barW / 2 && y >= barTop && y <= barBottom) return true;
    const dotCy = size * 0.74;
    const dotR = size * 0.09;
    if (Math.hypot(x - cx, y - dotCy) <= dotR) return true;
    return false;
  }

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const i = y * size + x;
      if (!inRoundedRect(x + 0.5, y + 0.5)) {
        px[i] = TRANSPARENT;
      } else if (inMark(x + 0.5, y + 0.5)) {
        px[i] = MARK;
      } else {
        px[i] = BG;
      }
    }
  }
  return px;
}

function crc32(buf) {
  let c = ~0;
  for (let i = 0; i < buf.length; i++) {
    c ^= buf[i];
    for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1));
  }
  return ~c >>> 0;
}

function chunk(type, data) {
  const typeBuf = Buffer.from(type, 'ascii');
  const lenBuf = Buffer.alloc(4);
  lenBuf.writeUInt32BE(data.length, 0);
  const crcBuf = Buffer.alloc(4);
  crcBuf.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0);
  return Buffer.concat([lenBuf, typeBuf, data, crcBuf]);
}

function writePng(size, path) {
  const px = drawIcon(size);
  // raw: cada linha comeca com filter byte 0 + RGBA
  const raw = Buffer.alloc(size * (1 + size * 4));
  let o = 0;
  for (let y = 0; y < size; y++) {
    raw[o++] = 0;
    for (let x = 0; x < size; x++) {
      const [r, g, b, a] = px[y * size + x];
      raw[o++] = r;
      raw[o++] = g;
      raw[o++] = b;
      raw[o++] = a;
    }
  }
  const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // color type RGBA
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;
  const png = Buffer.concat([
    sig,
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0))
  ]);
  writeFileSync(path, png);
}

for (const size of [16, 48, 128]) {
  writePng(size, join(outDir, `icon${size}.png`));
  console.log('wrote icon' + size + '.png');
}
