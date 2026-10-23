'use strict'
// Rasterise assets/icon.svg to PNGs. No graphics library, no dependencies, no build step:
// run `node assets/render-icons.js`. The mark is a squircle, two circles and a triangle,
// so we evaluate the shapes directly per sample (4x4 supersampled for antialiasing),
// composite in premultiplied alpha, and write the PNGs with zlib.

const fs = require('fs')
const zlib = require('zlib')
const path = require('path')

const ROOT = path.resolve(__dirname, '..')
const OUT = path.join(__dirname)
const SIZE = 1024
const SS = 4 // 4x4 subsamples per pixel

// ---------- geometry (source units, viewBox 0 0 1024 1024) ----------

function inRoundRect (x, y, rx, ry, rw, rh, r) {
  if (x < rx || x > rx + rw || y < ry || y > ry + rh) return false
  const cx = Math.min(Math.max(x, rx + r), rx + rw - r)
  const cy = Math.min(Math.max(y, ry + r), ry + rh - r)
  const dx = x - cx
  const dy = y - cy
  return dx * dx + dy * dy <= r * r
}

function inCircle (x, y, cx, cy, r) {
  const dx = x - cx
  const dy = y - cy
  return dx * dx + dy * dy <= r * r
}

function inTriangle (x, y, ax, ay, bx, by, cx, cy) {
  const d1 = (x - bx) * (ay - by) - (ax - bx) * (y - by)
  const d2 = (x - cx) * (by - cy) - (bx - cx) * (y - cy)
  const d3 = (x - ax) * (cy - ay) - (cx - ax) * (y - ay)
  const neg = d1 < 0 || d2 < 0 || d3 < 0
  const pos = d1 > 0 || d2 > 0 || d3 > 0
  return !(neg && pos)
}

// ---------- colour ----------

function hex (h) {
  return [parseInt(h.slice(1, 3), 16) / 255, parseInt(h.slice(3, 5), 16) / 255, parseInt(h.slice(5, 7), 16) / 255]
}

// stops: [[offset, [r,g,b]], ...]
function gradientAt (stops, t) {
  t = Math.min(1, Math.max(0, t))
  for (let i = 1; i < stops.length; i++) {
    if (t <= stops[i][0]) {
      const [o0, c0] = stops[i - 1]
      const [o1, c1] = stops[i]
      const k = o1 === o0 ? 0 : (t - o0) / (o1 - o0)
      return [c0[0] + (c1[0] - c0[0]) * k, c0[1] + (c1[1] - c0[1]) * k, c0[2] + (c1[2] - c0[2]) * k]
    }
  }
  return stops[stops.length - 1][1]
}

const BG = [
  [0.00, hex('#5083fb')],
  [0.55, hex('#336df4')],
  [1.00, hex('#0442d2')]
]
const IRIS = [
  [0.00, hex('#002f9e')],
  [1.00, hex('#0442d2')]
]
const WHITE = [1, 1, 1]

// ---------- the sample function: one point -> premultiplied RGBA ----------

function sample (x, y) {
  let pa = 0
  let pr = 0
  let pg = 0
  let pb = 0

  // paint(straight colour, alpha) over the accumulated result
  function paint (c, a) {
    if (a <= 0) return
    pr = c[0] * a + pr * (1 - a)
    pg = c[1] * a + pg * (1 - a)
    pb = c[2] * a + pb * (1 - a)
    pa = a + pa * (1 - a)
  }

  const inSquircle = inRoundRect(x, y, 0, 0, SIZE, SIZE, 232)

  if (inSquircle) {
    // background gradient runs corner to corner (objectBoundingBox 0,0 -> 1,1)
    paint(gradientAt(BG, (x + y) / (2 * SIZE)), 1)
    // top sheen: white fading out by 45% of the height
    const sheen = 0.22 * Math.max(0, 1 - y / (0.45 * SIZE))
    paint(WHITE, sheen)
  }

  // speech bubble body
  if (inRoundRect(x, y, 196, 222, 632, 452, 150)) paint(WHITE, 1)
  // speech bubble tail
  if (inTriangle(x, y, 300, 580, 250, 830, 470, 610)) paint(WHITE, 1)

  // the pupil
  if (inCircle(x, y, 512, 448, 108)) {
    paint(gradientAt(IRIS, (y - 340) / 216), 1)
  }
  // catchlight
  if (inCircle(x, y, 552, 406, 33)) paint(WHITE, 0.92)

  return [pr, pg, pb, pa]
}

// ---------- render at full size (premultiplied float) ----------

function render () {
  const img = new Float32Array(SIZE * SIZE * 4)
  const step = 1 / SS
  const inv = 1 / (SS * SS)
  for (let py = 0; py < SIZE; py++) {
    for (let px = 0; px < SIZE; px++) {
      let ar = 0
      let ag = 0
      let ab = 0
      let aa = 0
      for (let sy = 0; sy < SS; sy++) {
        const y = py + (sy + 0.5) * step
        for (let sx = 0; sx < SS; sx++) {
          const x = px + (sx + 0.5) * step
          const s = sample(x, y)
          ar += s[0]
          ag += s[1]
          ab += s[2]
          aa += s[3]
        }
      }
      const i = (py * SIZE + px) * 4
      img[i] = ar * inv
      img[i + 1] = ag * inv
      img[i + 2] = ab * inv
      img[i + 3] = aa * inv
    }
  }
  return img
}

// ---------- area-average downscale (premultiplied) ----------

function resize (src, srcSize, dstSize) {
  const dst = new Float32Array(dstSize * dstSize * 4)
  const ratio = srcSize / dstSize
  for (let dy = 0; dy < dstSize; dy++) {
    const y0 = dy * ratio
    const y1 = y0 + ratio
    for (let dx = 0; dx < dstSize; dx++) {
      const x0 = dx * ratio
      const x1 = x0 + ratio
      let ar = 0
      let ag = 0
      let ab = 0
      let aa = 0
      let wsum = 0
      for (let sy = Math.floor(y0); sy < Math.ceil(y1); sy++) {
        const wy = Math.min(y1, sy + 1) - Math.max(y0, sy)
        if (wy <= 0) continue
        for (let sx = Math.floor(x0); sx < Math.ceil(x1); sx++) {
          const wx = Math.min(x1, sx + 1) - Math.max(x0, sx)
          const w = wx * wy
          if (w <= 0) continue
          const si = (sy * srcSize + sx) * 4
          ar += src[si] * w
          ag += src[si + 1] * w
          ab += src[si + 2] * w
          aa += src[si + 3] * w
          wsum += w
        }
      }
      const di = (dy * dstSize + dx) * 4
      dst[di] = ar / wsum
      dst[di + 1] = ag / wsum
      dst[di + 2] = ab / wsum
      dst[di + 3] = aa / wsum
    }
  }
  return dst
}

// ---------- PNG writer ----------

const CRC_TABLE = (() => {
  const t = new Int32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    t[n] = c
  }
  return t
})()

function crc32 (buf) {
  let c = -1
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8)
  return (c ^ -1) >>> 0
}

function chunk (type, data) {
  const len = Buffer.alloc(4)
  len.writeUInt32BE(data.length, 0)
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data])
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(body), 0)
  return Buffer.concat([len, body, crc])
}

function encodePNG (premult, size) {
  const stride = size * 4
  const raw = Buffer.alloc((stride + 1) * size)
  for (let y = 0; y < size; y++) {
    raw[y * (stride + 1)] = 0 // filter: none
    for (let x = 0; x < size; x++) {
      const si = (y * size + x) * 4
      const di = y * (stride + 1) + 1 + x * 4
      const a = premult[si + 3]
      if (a <= 0.0001) {
        raw[di] = raw[di + 1] = raw[di + 2] = raw[di + 3] = 0
      } else {
        raw[di] = Math.min(255, Math.round((premult[si] / a) * 255))
        raw[di + 1] = Math.min(255, Math.round((premult[si + 1] / a) * 255))
        raw[di + 2] = Math.min(255, Math.round((premult[si + 2] / a) * 255))
        raw[di + 3] = Math.min(255, Math.round(a * 255))
      }
    }
  }
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(size, 0)
  ihdr.writeUInt32BE(size, 4)
  ihdr[8] = 8 // bit depth
  ihdr[9] = 6 // colour type: RGBA
  ihdr[10] = 0
  ihdr[11] = 0
  ihdr[12] = 0
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0))
  ])
}

// ---------- go ----------

fs.mkdirSync(OUT, { recursive: true })
console.log(`rendering ${SIZE}x${SIZE} ...`)
const t0 = Date.now()
const base = render()
console.log('rendered in', ((Date.now() - t0) / 1000).toFixed(1) + 's')

for (const s of [1024, 512, 256, 128, 64, 48, 32, 16]) {
  const data = s === SIZE ? base : resize(base, SIZE, s)
  const file = path.join(OUT, s === SIZE ? 'icon.png' : `icon-${s}.png`)
  fs.writeFileSync(file, encodePNG(data, s))
  console.log('wrote', path.basename(file), `${s}x${s}`, fs.statSync(file).size + 'B')
}
