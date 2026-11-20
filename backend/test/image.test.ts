import { describe, expect, test } from 'bun:test';
import { sniffImage } from '../src/common/image';
import { readAvatar } from '../src/workspace/avatars.service';

const bytes = (...parts: (number[] | string)[]) =>
  Buffer.concat(parts.map((p) => (typeof p === 'string' ? Buffer.from(p, 'latin1') : Buffer.from(p))));
const be32 = (n: number) => [(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255];
const le16 = (n: number) => [n & 255, (n >>> 8) & 255];
const le24 = (n: number) => [n & 255, (n >>> 8) & 255, (n >>> 16) & 255];

const png = (w: number, h: number) =>
  bytes([0x89], 'PNG\r\n\x1a\n', be32(13), 'IHDR', be32(w), be32(h), [8, 6, 0, 0, 0], [0, 0, 0, 0]);
const webpLossy = (w: number, h: number) =>
  bytes('RIFF', [0, 0, 0, 0], 'WEBP', 'VP8 ', [0, 0, 0, 0], [0, 0, 0], [0x9d, 0x01, 0x2a], le16(w), le16(h), [0, 0]);
const webpLossless = (w: number, h: number) => {
  const bits = ((w - 1) & 0x3fff) | (((h - 1) & 0x3fff) << 14);
  return bytes('RIFF', [0, 0, 0, 0], 'WEBP', 'VP8L', [0, 0, 0, 0], [0x2f], [bits & 255, (bits >>> 8) & 255, (bits >>> 16) & 255, (bits >>> 24) & 255], [0, 0, 0, 0, 0, 0]);
};
const webpExtended = (w: number, h: number) =>
  bytes('RIFF', [0, 0, 0, 0], 'WEBP', 'VP8X', [10, 0, 0, 0], [0x10, 0, 0, 0], le24(w - 1), le24(h - 1), [0, 0]);
// SOI, an APP0 segment to skip, then a progressive frame header (C2).
const jpeg = (w: number, h: number) =>
  bytes([0xff, 0xd8], [0xff, 0xe0, 0, 16], 'JFIF\0', [1, 1, 0, 0, 1, 0, 1, 0, 0], [0xff, 0xc2, 0, 17, 8], [h >> 8, h & 255, w >> 8, w & 255], [3, 1, 0x22, 0, 2, 0x11, 1, 3, 0x11, 1]);

describe('sniffImage', () => {
  test('reads PNG size from IHDR', () => {
    expect(sniffImage(png(256, 256))).toEqual({ type: 'image/png', width: 256, height: 256 });
  });

  test('reads all three WebP flavours', () => {
    expect(sniffImage(webpLossy(256, 200))).toEqual({ type: 'image/webp', width: 256, height: 200 });
    expect(sniffImage(webpLossless(256, 256))).toEqual({ type: 'image/webp', width: 256, height: 256 });
    expect(sniffImage(webpExtended(4000, 3000))).toEqual({ type: 'image/webp', width: 4000, height: 3000 });
  });

  test('walks JPEG segments to the frame header', () => {
    expect(sniffImage(jpeg(640, 480))).toEqual({ type: 'image/jpeg', width: 640, height: 480 });
  });

  test('refuses SVG, HTML and truncated files', () => {
    expect(sniffImage(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>'))).toBeNull();
    expect(sniffImage(Buffer.from('<!doctype html><title>x</title>'))).toBeNull();
    expect(sniffImage(png(10, 10).subarray(0, 12))).toBeNull();
    expect(sniffImage(Buffer.from([0xff, 0xd8, 0xff, 0xd9]))).toBeNull();
  });
});

describe('readAvatar', () => {
  test('accepts a small square photo and reports its real type', () => {
    expect(readAvatar(webpLossy(256, 256)).info.type).toBe('image/webp');
  });

  test('rejects non-buffers, empty, huge and oversized-pixel uploads', () => {
    expect(() => readAvatar({})).toThrow('사진 파일');
    expect(() => readAvatar(Buffer.alloc(0))).toThrow('사진 파일');
    expect(() => readAvatar(Buffer.concat([png(256, 256), Buffer.alloc(600 * 1024)]))).toThrow('512KB');
    expect(() => readAvatar(webpExtended(4000, 4000))).toThrow('1024px');
    expect(() => readAvatar(Buffer.from('GIF89a'))).toThrow('WebP, PNG, JPEG');
  });
});
