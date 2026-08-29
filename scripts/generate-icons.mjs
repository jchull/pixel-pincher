import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { deflateSync } from "node:zlib";
import { fileURLToPath } from "node:url";

/**
 * Generates the production extension icons in public/icon at the sizes the
 * manifest requires. The icons are rendered from vector shapes with 4x4
 * supersampling, so the glyph stays legible at 16 pixels.
 */

const SIZES = [16, 32, 48, 128];
const SAMPLES = 4;

const BACKGROUND = [37, 99, 235]; // #2563eb
const GLYPH = [255, 255, 255];

// Unit-space (0..1) pin geometry: a circle with a tapered tail and a
// background-colored center hole.
const PIN = {
    circleCenter: [0.5, 0.36],
    circleRadius: 0.27,
    holeRadius: 0.115,
    tailBaseY: 0.42,
    tailBaseHalfWidth: 0.16,
    tailTipY: 0.9,
};

const ICON = { cornerRadius: 0.22 };

function insideBackground(x, y) {
    const limit = 0.5 - ICON.cornerRadius;
    const dx = Math.max(Math.abs(x - 0.5) - limit, 0);
    const dy = Math.max(Math.abs(y - 0.5) - limit, 0);
    const corner = Math.hypot(dx, dy);
    const edge = Math.max(Math.abs(x - 0.5), Math.abs(y - 0.5));
    return edge < 0.5 && corner <= ICON.cornerRadius;
}

function insidePin(x, y) {
    const [cx, cy] = PIN.circleCenter;
    if ((x - cx) ** 2 + (y - cy) ** 2 <= PIN.circleRadius ** 2) return true;
    if (y < PIN.tailBaseY || y > PIN.tailTipY) return false;
    const halfWidth =
        PIN.tailBaseHalfWidth *
        ((PIN.tailTipY - y) / (PIN.tailTipY - PIN.tailBaseY));
    return Math.abs(x - 0.5) <= halfWidth;
}

function insideHole(x, y) {
    const [cx, cy] = PIN.circleCenter;
    return (x - cx) ** 2 + (y - cy) ** 2 <= PIN.holeRadius ** 2;
}

function renderIcon(size) {
    const pixels = new Uint8Array(size * size * 4);
    const step = 1 / size;

    for (let row = 0; row < size; row += 1) {
        for (let column = 0; column < size; column += 1) {
            let r = 0;
            let g = 0;
            let b = 0;
            let a = 0;

            for (let sy = 0; sy < SAMPLES; sy += 1) {
                for (let sx = 0; sx < SAMPLES; sx += 1) {
                    const x = (column + (sx + 0.5) / SAMPLES) * step;
                    const y = (row + (sy + 0.5) / SAMPLES) * step;
                    if (!insideBackground(x, y)) continue;
                    const [cr, cg, cb] = insideHole(x, y)
                        ? BACKGROUND
                        : insidePin(x, y)
                          ? GLYPH
                          : BACKGROUND;
                    r += cr;
                    g += cg;
                    b += cb;
                    a += 255;
                }
            }

            const samples = SAMPLES * SAMPLES;
            const offset = (row * size + column) * 4;
            if (a === 0) continue;
            pixels[offset] = Math.round((r * 255) / a);
            pixels[offset + 1] = Math.round((g * 255) / a);
            pixels[offset + 2] = Math.round((b * 255) / a);
            pixels[offset + 3] = Math.round(a / samples);
        }
    }

    return pixels;
}

const CRC_TABLE = new Uint32Array(256).map((_, n) => {
    let value = n;
    for (let bit = 0; bit < 8; bit += 1)
        value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
    return value >>> 0;
});

function crc32(bytes) {
    let value = 0xffffffff;
    for (const byte of bytes)
        value = CRC_TABLE[(value ^ byte) & 0xff] ^ (value >>> 8);
    return (value ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
    const body = new Uint8Array(8 + type.length + data.length);
    const view = new DataView(body.buffer);
    view.setUint32(0, data.length);
    for (let i = 0; i < type.length; i += 1) body[4 + i] = type.charCodeAt(i);
    body.set(data, 4 + type.length);
    view.setUint32(body.length - 4, crc32(body.subarray(4, body.length - 4)));
    return body;
}

function concatenate(parts) {
    const total = parts.reduce((sum, part) => sum + part.length, 0);
    const output = new Uint8Array(total);
    let offset = 0;
    for (const part of parts) {
        output.set(part, offset);
        offset += part.length;
    }
    return output;
}

function encodePng(size, pixels) {
    const signature = new Uint8Array([
        0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
    ]);
    const header = new Uint8Array(13);
    const view = new DataView(header.buffer);
    view.setUint32(0, size);
    view.setUint32(4, size);
    header[8] = 8; // bit depth
    header[9] = 6; // color type: RGBA
    const scanlines = new Uint8Array(size * (size * 4 + 1));
    for (let row = 0; row < size; row += 1) {
        scanlines[row * (size * 4 + 1)] = 0; // filter: none
        scanlines.set(
            pixels.subarray(row * size * 4, (row + 1) * size * 4),
            row * (size * 4 + 1) + 1,
        );
    }
    return concatenate([
        signature,
        chunk("IHDR", header),
        chunk("IDAT", new Uint8Array(deflateSync(scanlines, { level: 9 }))),
        chunk("IEND", new Uint8Array(0)),
    ]);
}

const iconDirectory = join(
    dirname(fileURLToPath(import.meta.url)),
    "..",
    "public",
    "icon",
);
mkdirSync(iconDirectory, { recursive: true });

for (const size of SIZES) {
    const png = encodePng(size, renderIcon(size));
    writeFileSync(join(iconDirectory, `${size}.png`), png);
}
