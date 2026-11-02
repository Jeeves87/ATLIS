import zlib from 'zlib'
import fs from 'fs'

function crc32(buf) {
  let c
  const table = []
  for (let n = 0; n < 256; n++) {
    c = n
    for (let k = 0; k < 8; k++) {
      c = c & 1 ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1)
    }
    table[n] = c
  }
  let crc = 0xffffffff
  for (let i = 0; i < buf.length; i++) {
    crc = table[(crc ^ buf[i]) & 0xff] ^ (crc >>> 8)
  }
  return (crc ^ 0xffffffff) >>> 0
}

function chunk(type, data) {
  const typeBuf = Buffer.from(type, 'ascii')
  const len = Buffer.alloc(4)
  len.writeUInt32BE(data.length, 0)
  const crcBuf = Buffer.alloc(4)
  crcBuf.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0)
  return Buffer.concat([len, typeBuf, data, crcBuf])
}

function makePng(size, drawFn) {
  const width = size
  const height = size
  const raw = Buffer.alloc((width * 4 + 1) * height)
  for (let y = 0; y < height; y++) {
    const rowStart = y * (width * 4 + 1)
    raw[rowStart] = 0
    for (let x = 0; x < width; x++) {
      const [r, g, b, a] = drawFn(x, y, width, height)
      const off = rowStart + 1 + x * 4
      raw[off] = r
      raw[off + 1] = g
      raw[off + 2] = b
      raw[off + 3] = a
    }
  }
  const idatData = zlib.deflateSync(raw, { level: 9 })
  const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(width, 0)
  ihdr.writeUInt32BE(height, 4)
  ihdr[8] = 8
  ihdr[9] = 6
  ihdr[10] = 0
  ihdr[11] = 0
  ihdr[12] = 0
  return Buffer.concat([sig, chunk('IHDR', ihdr), chunk('IDAT', idatData), chunk('IEND', Buffer.alloc(0))])
}

function insideRounded(px, py, w, h) {
  const margin = w * 0.06
  const r = w * 0.22
  const left = margin
  const right = w - margin
  const top = margin
  const bottom = h - margin
  const cxL = left + r
  const cxR = right - r
  const cyT = top + r
  const cyB = bottom - r
  if (px < left || px > right || py < top || py > bottom) return false
  if (px < cxL && py < cyT) return (px - cxL) ** 2 + (py - cyT) ** 2 <= r * r
  if (px > cxR && py < cyT) return (px - cxR) ** 2 + (py - cyT) ** 2 <= r * r
  if (px < cxL && py > cyB) return (px - cxL) ** 2 + (py - cyB) ** 2 <= r * r
  if (px > cxR && py > cyB) return (px - cxR) ** 2 + (py - cyB) ** 2 <= r * r
  return true
}

function pointInPoly(px, py, poly) {
  let inside = false
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const xi = poly[i][0]
    const yi = poly[i][1]
    const xj = poly[j][0]
    const yj = poly[j][1]
    const intersect = yi > py !== yj > py && px < ((xj - xi) * (py - yi)) / (yj - yi) + xi
    if (intersect) inside = !inside
  }
  return inside
}

function draw(x, y, w, h) {
  if (!insideRounded(x, y, w, h)) return [0, 0, 0, 0]
  const pts = [
    [0.58, 0.16],
    [0.3, 0.56],
    [0.46, 0.56],
    [0.38, 0.86],
    [0.72, 0.42],
    [0.54, 0.42],
    [0.62, 0.16]
  ].map(([px, py]) => [px * w, py * h])
  if (pointInPoly(x + 0.5, y + 0.5, pts)) return [255, 255, 255, 255]
  return [124, 92, 255, 255]
}

const sizes = [16, 24, 32, 48, 64, 128, 256]
const pngBufs = {}
for (const s of sizes) {
  const buf = makePng(s, draw)
  pngBufs[s] = buf
  fs.writeFileSync(`resources/icon-${s}.png`, buf)
}
fs.copyFileSync('resources/icon-256.png', 'resources/icon.png')

// Build a Vista-style .ico containing PNG-encoded frames (widely supported by
// Windows Explorer, taskbar, and Electron's Tray/app icon).
function makeIco(sizesToPack) {
  const count = sizesToPack.length
  const headerSize = 6
  const dirEntrySize = 16
  const header = Buffer.alloc(headerSize)
  header.writeUInt16LE(0, 0) // reserved
  header.writeUInt16LE(1, 2) // type: icon
  header.writeUInt16LE(count, 4) // image count

  const dirEntries = []
  const imageDatas = []
  let offset = headerSize + count * dirEntrySize
  for (const s of sizesToPack) {
    const data = pngBufs[s]
    const entry = Buffer.alloc(dirEntrySize)
    entry[0] = s >= 256 ? 0 : s // width (0 = 256)
    entry[1] = s >= 256 ? 0 : s // height
    entry[2] = 0 // color palette
    entry[3] = 0 // reserved
    entry.writeUInt16LE(1, 4) // color planes
    entry.writeUInt16LE(32, 6) // bits per pixel
    entry.writeUInt32LE(data.length, 8) // size of image data
    entry.writeUInt32LE(offset, 12) // offset of image data
    offset += data.length
    dirEntries.push(entry)
    imageDatas.push(data)
  }
  return Buffer.concat([header, ...dirEntries, ...imageDatas])
}

const ico = makeIco([16, 32, 48, 256])
fs.writeFileSync('resources/icon.ico', ico)

console.log('done', fs.readdirSync('resources').filter((f) => f.startsWith('icon')))
