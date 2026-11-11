// Genera los iconos de la PWA a partir de la imagen base de la rana con el balón
// (scripts/icon-source.png), sin dependencias externas: decodificador y
// codificador PNG mínimos y reescalado por promedio de área.
// Uso: npm run icons
//
// La imagen base es un cuadrado redondeado con fondo verde y esquinas blancas.
// Las esquinas se rellenan con el propio fondo (se prolonga el borde) para que
// Android e iOS, que aplican su propia máscara, nunca muestren blanco.
import { readFileSync, writeFileSync } from 'node:fs';
import { deflateSync, inflateSync } from 'node:zlib';

const SOURCE = new URL('./icon-source.png', import.meta.url);

// --- PNG ---------------------------------------------------------------------------

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

const paeth = (a, b, c) => {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  return pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
};

/**
 * PNG de `size` × `size`: RGBA si `alpha`, si no RGB (sin transparencia, como pide iOS).
 * Sin pérdida: en cada fila se elige el filtro PNG (ninguno, Sub, Up, Average o
 * Paeth) que deja los valores más pequeños, lo que comprime mucho mejor los degradados.
 */
function encodePng(size, rgba, alpha) {
  const ch = alpha ? 4 : 3;
  const stride = size * ch;
  const px = Buffer.alloc(size * stride);
  for (let i = 0; i < size * size; i++) for (let k = 0; k < ch; k++) px[i * ch + k] = rgba[i * 4 + k];
  const raw = Buffer.alloc(size * (stride + 1));
  const line = Buffer.alloc(stride);
  for (let y = 0; y < size; y++) {
    let best = -1;
    let bestScore = Infinity;
    for (let f = 0; f <= 4; f++) {
      let score = 0;
      for (let x = 0; x < stride; x++) {
        const v = px[y * stride + x];
        const a = x >= ch ? px[y * stride + x - ch] : 0;
        const b = y > 0 ? px[(y - 1) * stride + x] : 0;
        const c = x >= ch && y > 0 ? px[(y - 1) * stride + x - ch] : 0;
        const pred = f === 0 ? 0 : f === 1 ? a : f === 2 ? b : f === 3 ? (a + b) >> 1 : paeth(a, b, c);
        line[x] = (v - pred) & 0xff;
        score += line[x] < 128 ? line[x] : 256 - line[x];
      }
      if (score < bestScore) {
        bestScore = score;
        best = f;
        line.copy(raw, y * (stride + 1) + 1);
      }
    }
    raw[y * (stride + 1)] = best;
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // profundidad
  ihdr[9] = alpha ? 6 : 2; // RGBA o RGB
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

/** Decodifica un PNG de 8 bits RGB o RGBA sin entrelazar. Devuelve RGBA. */
function decodePng(buf) {
  let pos = 8;
  let width = 0;
  let height = 0;
  let type = 0;
  const idat = [];
  while (pos < buf.length) {
    const len = buf.readUInt32BE(pos);
    const name = buf.toString('ascii', pos + 4, pos + 8);
    const data = buf.subarray(pos + 8, pos + 8 + len);
    if (name === 'IHDR') {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      type = data[9];
      if (data[8] !== 8 || (type !== 2 && type !== 6) || data[12] !== 0) throw new Error('PNG base no admitido (8 bits RGB/RGBA sin entrelazar).');
    } else if (name === 'IDAT') idat.push(data);
    pos += 12 + len;
  }
  const ch = type === 6 ? 4 : 3;
  const stride = width * ch;
  const raw = inflateSync(Buffer.concat(idat));
  const px = Buffer.alloc(height * stride);
  for (let y = 0; y < height; y++) {
    const f = raw[y * (stride + 1)];
    const src = y * (stride + 1) + 1;
    for (let x = 0; x < stride; x++) {
      const a = x >= ch ? px[y * stride + x - ch] : 0;
      const b = y > 0 ? px[(y - 1) * stride + x] : 0;
      const c = x >= ch && y > 0 ? px[(y - 1) * stride + x - ch] : 0;
      const p = a + b - c;
      const pa = Math.abs(p - a);
      const pb = Math.abs(p - b);
      const pc = Math.abs(p - c);
      const pred = f === 0 ? 0 : f === 1 ? a : f === 2 ? b : f === 3 ? (a + b) >> 1 : pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
      px[y * stride + x] = (raw[src + x] + pred) & 0xff;
    }
  }
  const rgba = new Float32Array(width * height * 4);
  for (let i = 0; i < width * height; i++) {
    for (let k = 0; k < 3; k++) rgba[i * 4 + k] = px[i * ch + k];
    rgba[i * 4 + 3] = ch === 4 ? px[i * ch + 3] : 255;
  }
  return { width, height, rgba };
}

// --- Imagen base ---------------------------------------------------------------------

const base = decodePng(readFileSync(SOURCE));
if (base.width !== base.height) throw new Error('La imagen base debe ser cuadrada.');
const W = base.width;
/** Radio de las esquinas redondeadas de la imagen base (312 px en 1254). */
const RADIUS = W * 0.249;
/** Margen hacia dentro desde el que se toma el color para tapar el borde antialiasado. */
const INSET = W * 0.008;

/** Centro de la esquina más cercana (o el propio punto si está en la parte recta). */
function cornerCenter(x, y) {
  return [Math.min(Math.max(x, RADIUS), W - RADIUS), Math.min(Math.max(y, RADIUS), W - RADIUS)];
}

// Esquinas: cada píxel fuera del cuadrado redondeado toma el color del fondo en
// el mismo radio, un poco hacia dentro (el fondo es un degradado suave).
{
  const src = base.rgba.slice();
  for (let y = 0; y < W; y++) {
    for (let x = 0; x < W; x++) {
      const [cx, cy] = cornerCenter(x + 0.5, y + 0.5);
      const d = Math.hypot(x + 0.5 - cx, y + 0.5 - cy);
      if (d <= RADIUS - INSET) continue;
      const k = (RADIUS - INSET * 1.5) / d;
      const sx = Math.min(W - 1, Math.max(0, Math.round(cx + (x + 0.5 - cx) * k)));
      const sy = Math.min(W - 1, Math.max(0, Math.round(cy + (y + 0.5 - cy) * k)));
      for (let c = 0; c < 4; c++) base.rgba[(y * W + x) * 4 + c] = src[(sy * W + sx) * 4 + c];
    }
  }
}

/** Color bilineal de la base (fuera de ella, el borde más cercano: el fondo continúa). */
function sample(x, y, out) {
  const fx = Math.min(W - 1, Math.max(0, x - 0.5));
  const fy = Math.min(W - 1, Math.max(0, y - 0.5));
  const x0 = Math.floor(fx);
  const y0 = Math.floor(fy);
  const x1 = Math.min(W - 1, x0 + 1);
  const y1 = Math.min(W - 1, y0 + 1);
  const tx = fx - x0;
  const ty = fy - y0;
  for (let c = 0; c < 4; c++) {
    const a = base.rgba[(y0 * W + x0) * 4 + c] * (1 - tx) + base.rgba[(y0 * W + x1) * 4 + c] * tx;
    const b = base.rgba[(y1 * W + x0) * 4 + c] * (1 - tx) + base.rgba[(y1 * W + x1) * 4 + c] * tx;
    out[c] = a * (1 - ty) + b * ty;
  }
}

/**
 * Icono de `size` px con la imagen a `scale` del lado (1 = a sangre; menos, con
 * margen de fondo). `rounded`: esquinas transparentes como la imagen original.
 */
function render(size, { scale = 1, rounded = false } = {}) {
  const out = new Uint8Array(size * size * 4);
  const step = W / (size * scale); // píxeles de la base por píxel de salida
  const n = Math.min(8, Math.max(2, Math.ceil(step))); // muestras por eje (promedio de área)
  const s = [0, 0, 0, 0];
  const r = size * 0.249;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const acc = [0, 0, 0, 0];
      let cover = 0;
      for (let j = 0; j < n; j++) {
        for (let i = 0; i < n; i++) {
          const u = x + (i + 0.5) / n;
          const v = y + (j + 0.5) / n;
          if (rounded) {
            const cx = Math.min(Math.max(u, r), size - r);
            const cy = Math.min(Math.max(v, r), size - r);
            if (Math.hypot(u - cx, v - cy) > r) continue;
          }
          cover++;
          sample(W / 2 + (u - size / 2) * step, W / 2 + (v - size / 2) * step, s);
          for (let c = 0; c < 3; c++) acc[c] += s[c];
        }
      }
      const o = (y * size + x) * 4;
      for (let c = 0; c < 3; c++) out[o + c] = cover ? Math.round(acc[c] / cover) : 0;
      out[o + 3] = Math.round((cover / (n * n)) * 255);
    }
  }
  return out;
}

const write = (name, size, opts = {}) => {
  writeFileSync(new URL(`../public/${name}`, import.meta.url), encodePng(size, render(size, opts), Boolean(opts.rounded)));
  console.log(`public/${name} (${size} × ${size})`);
};

// Android y manifiesto: a sangre (sin transparencias ni esquinas blancas).
write('pwa-192.png', 192);
write('pwa-512.png', 512);
// Maskable: la rana y el balón dentro del círculo seguro (80 %); solo las estelas pueden recortarse.
write('pwa-512-maskable.png', 512, { scale: 0.86 });
// iPhone: sin transparencia; iOS redondea las esquinas.
write('apple-touch-icon.png', 180, { scale: 0.92 });
// Pestaña del navegador: cuadrado redondeado con esquinas transparentes, como la imagen original.
write('favicon.png', 64, { rounded: true });
