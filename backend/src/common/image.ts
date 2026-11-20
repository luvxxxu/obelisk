/**
 * Just enough of WebP, PNG and JPEG to tell what an upload really is and how big it is,
 * without decoding it. Profile photos are cut and shrunk in the browser; the server only checks.
 */

export type ImageType = 'image/webp' | 'image/png' | 'image/jpeg';

export interface ImageInfo {
  type: ImageType;
  width: number;
  height: number;
}

const ascii = (b: Uint8Array, at: number, s: string) => {
  for (let i = 0; i < s.length; i++) if (b[at + i] !== s.charCodeAt(i)) return false;
  return true;
};
const u16be = (b: Uint8Array, at: number) => (b[at]! << 8) | b[at + 1]!;
const u16le = (b: Uint8Array, at: number) => b[at]! | (b[at + 1]! << 8);
const u24le = (b: Uint8Array, at: number) => b[at]! | (b[at + 1]! << 8) | (b[at + 2]! << 16);
const u32be = (b: Uint8Array, at: number) => ((b[at]! << 24) >>> 0) + (b[at + 1]! << 16) + (b[at + 2]! << 8) + b[at + 3]!;

function png(b: Uint8Array): ImageInfo | null {
  // Signature, then the IHDR chunk: length(4) "IHDR" width(4) height(4).
  if (b.length < 24 || !(b[0] === 0x89 && ascii(b, 1, 'PNG\r\n\x1a\n') && ascii(b, 12, 'IHDR'))) return null;
  return { type: 'image/png', width: u32be(b, 16), height: u32be(b, 20) };
}

function webp(b: Uint8Array): ImageInfo | null {
  if (b.length < 30 || !ascii(b, 0, 'RIFF') || !ascii(b, 8, 'WEBP')) return null;
  if (ascii(b, 12, 'VP8 ')) {
    // Lossy: frame tag (3), start code 9d 01 2a, then 14-bit width and height.
    if (!(b[23] === 0x9d && b[24] === 0x01 && b[25] === 0x2a)) return null;
    return { type: 'image/webp', width: u16le(b, 26) & 0x3fff, height: u16le(b, 28) & 0x3fff };
  }
  if (ascii(b, 12, 'VP8L')) {
    // Lossless: signature 0x2f, then 14 bits width-1 and 14 bits height-1.
    if (b[20] !== 0x2f) return null;
    const bits = b[21]! | (b[22]! << 8) | (b[23]! << 16) | (b[24]! << 24);
    return { type: 'image/webp', width: (bits & 0x3fff) + 1, height: ((bits >>> 14) & 0x3fff) + 1 };
  }
  if (ascii(b, 12, 'VP8X')) {
    // Extended: 24-bit canvas width-1 and height-1.
    return { type: 'image/webp', width: u24le(b, 24) + 1, height: u24le(b, 27) + 1 };
  }
  return null;
}

function jpeg(b: Uint8Array): ImageInfo | null {
  if (b.length < 4 || b[0] !== 0xff || b[1] !== 0xd8) return null;
  let at = 2;
  while (at + 9 < b.length) {
    if (b[at] !== 0xff) return null;
    const marker = b[at + 1]!;
    if (marker === 0xff) {
      at++; // fill byte
      continue;
    }
    // Start-of-frame markers (baseline, progressive, …) carry the size; C4, C8 and CC are not frames.
    if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
      return { type: 'image/jpeg', width: u16be(b, at + 7), height: u16be(b, at + 5) };
    }
    if (marker === 0xd9 || marker === 0xda) return null; // end of image / start of scan before any frame
    at += 2 + u16be(b, at + 2);
  }
  return null;
}

/** What the bytes are (never what the client claims), or null for anything else, SVG included. */
export function sniffImage(bytes: Uint8Array): ImageInfo | null {
  return png(bytes) ?? webp(bytes) ?? jpeg(bytes);
}
