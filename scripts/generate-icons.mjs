// Genera los iconos PNG de la PWA sin dependencias externas (codificador PNG mínimo).
// Uso: npm run icons
import { writeFileSync } from 'node:fs';
import { deflateSync } from 'node:zlib';

const NAVY = [15, 39, 66];
const ORANGE = [245, 130, 32];
const WHITE = [255, 255, 255];

const CRC_TABLE = new Uint32Array(256).map((_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});

function crc32(buf) {
  let c = 0xffffffff;
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

function encodePng(size, pixel) {
  const raw = Buffer.alloc(size * (size * 4 + 1));
  for (let y = 0; y < size; y++) {
    const row = y * (size * 4 + 1);
    raw[row] = 0;
    for (let x = 0; x < size; x++) {
      const [r, g, b, a] = pixel(x + 0.5, y + 0.5);
      raw.set([r, g, b, a], row + 1 + x * 4);
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // RGBA
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

// Balón naranja con dos costuras blancas sobre fondo azul marino.
function icon(size, { scale, rounded }) {
  const c = size / 2;
  const R = (size / 2) * scale;
  const corner = size * 0.22;
  return (x, y) => {
    if (rounded) {
      const dx = Math.max(corner - x, 0, x - (size - corner));
      const dy = Math.max(corner - y, 0, y - (size - corner));
      if (dx * dx + dy * dy > corner * corner) return [0, 0, 0, 0];
    }
    const d = Math.hypot(x - c, y - c);
    if (d > R) return [...NAVY, 255];
    if (d > R * 0.9) return [...WHITE, 255];
    const seam = R * 0.06;
    const nx = (x - c) / R;
    const curve = Math.abs(Math.abs(nx) - 0.42 * (1 - ((y - c) / R) ** 2) - 0.12);
    if (Math.abs(y - c) < seam || curve * R < seam) return [...WHITE, 255];
    return [...ORANGE, 255];
  };
}

const out = (name, size, opts) => writeFileSync(`public/${name}`, encodePng(size, icon(size, opts)));
out('pwa-192.png', 192, { scale: 0.72, rounded: false });
out('pwa-512.png', 512, { scale: 0.72, rounded: false });
out('pwa-512-maskable.png', 512, { scale: 0.56, rounded: false });
out('apple-touch-icon.png', 180, { scale: 0.7, rounded: false });
console.log('Iconos generados en public/');
