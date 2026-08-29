import {
  AppError,
  type ImportError,
  type ImportedReference,
  type MimeType,
  type ReferenceId,
  type ReferenceMetadata,
  type Result,
  MAX_IMAGE_ENCODED_BYTES,
  MAX_IMAGE_PIXELS,
  MAX_IMAGE_RAW_BYTES,
} from "../shared/contracts";

/** The minimal File-shaped fields the import path needs from a picked file. */
export type ImportFileLike = Readonly<{ name: string; type: string; size: number }>;

export type ImportedDimensions = Readonly<{ width: number; height: number }>;

/**
 * Trusted internal adapters for the import path. File bytes, declared MIME
 * types, and decoded dimensions are untrusted input and are validated here;
 * the produced reference is revalidated at the background message boundary.
 */
export type ImportDependencies = Readonly<{
  readFile(file: ImportFileLike): Promise<Uint8Array>;
  decodeImage(bytes: Uint8Array, mimeType: MimeType): Promise<ImportedDimensions>;
  randomReferenceId(): string;
  currentTimestamp(): number;
}>;

const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const PNG_MAGIC = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a] as const;
const JPEG_MAGIC = [0xff, 0xd8, 0xff] as const;
const RIFF_MAGIC = [0x52, 0x49, 0x46, 0x46] as const;
const WEBP_MAGIC = [0x57, 0x45, 0x42, 0x50] as const;
const BASE64_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
const BASE64_FLUSH_CHARS = 32_768;
/**
 * The widest `data:<mime>;base64,` prefix among the supported types
 * (`data:image/svg+xml;base64,`). Used to bound the encoded size of a file
 * before its bytes are read.
 */
const DATA_URL_PREFIX_BYTES = "data:image/svg+xml;base64,".length;
/** SVG sniff window: a well-formed SVG declares its root within the first 16 KiB. */
const SVG_SCAN_BYTES = 16_384;

function typeError(): ImportError {
  return new AppError("invalid-image-type");
}

function tooLargeError(): ImportError {
  return new AppError("image-too-large");
}

function tooManyPixelsError(): ImportError {
  return new AppError("image-too-many-pixels");
}

function decodeError(): ImportError {
  return new AppError("image-decode-failed");
}

function hasMagicAt(bytes: Uint8Array, magic: readonly number[], offset: number): boolean {
  if (bytes.byteLength < magic.length + offset) return false;
  return magic.every((byte, index) => bytes[offset + index] === byte);
}

/**
 * Detects the image type from bytes. SVG is recognized by its textual
 * declaration only; the bytes stay opaque and are never parsed as markup.
 */
function sniffImageMimeType(bytes: Uint8Array): MimeType | null {
  if (hasMagicAt(bytes, PNG_MAGIC, 0)) return "image/png";
  if (hasMagicAt(bytes, JPEG_MAGIC, 0)) return "image/jpeg";
  if (hasMagicAt(bytes, RIFF_MAGIC, 0) && hasMagicAt(bytes, WEBP_MAGIC, 8)) return "image/webp";
  return looksLikeSvg(bytes) ? "image/svg+xml" : null;
}

function looksLikeSvg(bytes: Uint8Array): boolean {
  const window = new TextDecoder("utf-8").decode(bytes.subarray(0, SVG_SCAN_BYTES), { stream: true });
  let text = window;
  for (;;) {
    const trimmed = text.replace(/^\s+/, "");
    if (trimmed !== text) {
      text = trimmed;
      continue;
    }
    if (text.startsWith("<?xml")) {
      const end = text.indexOf("?>");
      if (end === -1) return false;
      text = text.slice(end + 2);
      continue;
    }
    if (text.startsWith("<!--")) {
      const end = text.indexOf("-->", 4);
      if (end === -1) return false;
      text = text.slice(end + 3);
      continue;
    }
    if (text.startsWith("<!DOCTYPE")) {
      const end = findDoctypeEnd(text);
      if (end === -1) return false;
      text = text.slice(end + 1);
      continue;
    }
    break;
  }
  return /^<svg(?=[\s/>]|$)/.test(text);
}

/**
 * Finds the closing `>` of a `<!DOCTYPE ...>` declaration while staying
 * opaque: quoted strings and the bracketed internal subset are skipped so a
 * `>` inside a system literal or entity value cannot end the scan early.
 * Returns -1 when the declaration does not close within the scanned window,
 * keeping the sniff bounded.
 */
function findDoctypeEnd(text: string): number {
  const start = "<!DOCTYPE".length;
  let bracketDepth = 0;
  let quote = "";
  for (let i = start; i < text.length; i++) {
    const char = text.charAt(i);
    if (quote !== "") {
      if (char === quote) quote = "";
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      continue;
    }
    if (char === "[") bracketDepth += 1;
    else if (char === "]") bracketDepth = Math.max(0, bracketDepth - 1);
    else if (char === ">" && bracketDepth === 0) return i;
  }
  return -1;
}

function base64Encode(bytes: Uint8Array): string {
  const total = bytes.byteLength;
  const fullGroups = Math.floor(total / 3);
  const parts: string[] = [];
  let current = "";
  for (let i = 0; i < fullGroups * 3; i += 3) {
    const value = (bytes[i] << 16) | (bytes[i + 1] << 8) | bytes[i + 2];
    current +=
      BASE64_ALPHABET[(value >> 18) & 63] +
      BASE64_ALPHABET[(value >> 12) & 63] +
      BASE64_ALPHABET[(value >> 6) & 63] +
      BASE64_ALPHABET[value & 63];
    if (current.length >= BASE64_FLUSH_CHARS) {
      parts.push(current);
      current = "";
    }
  }
  const remainder = total - fullGroups * 3;
  if (remainder === 1) {
    const value = bytes[fullGroups * 3] << 16;
    current += BASE64_ALPHABET[(value >> 18) & 63] + BASE64_ALPHABET[(value >> 12) & 63] + "==";
  } else if (remainder === 2) {
    const offset = fullGroups * 3;
    const value = (bytes[offset] << 16) | (bytes[offset + 1] << 8);
    current +=
      BASE64_ALPHABET[(value >> 18) & 63] +
      BASE64_ALPHABET[(value >> 12) & 63] +
      BASE64_ALPHABET[(value >> 6) & 63] +
      "=";
  }
  parts.push(current);
  return parts.join("");
}

async function readFileSafely(
  readFile: ImportDependencies["readFile"],
  file: ImportFileLike,
): Promise<Uint8Array | null> {
  try {
    const bytes = await readFile(file);
    return bytes instanceof Uint8Array ? bytes : null;
  } catch {
    return null;
  }
}

async function decodeImageSafely(
  decodeImage: ImportDependencies["decodeImage"],
  bytes: Uint8Array,
  mimeType: MimeType,
): Promise<ImportedDimensions | null> {
  try {
    return await decodeImage(bytes, mimeType);
  } catch {
    return null;
  }
}

function isValidDimensions(dimensions: ImportedDimensions | null): dimensions is ImportedDimensions {
  if (dimensions === null) return false;
  const { width, height } = dimensions;
  return Number.isSafeInteger(width) &&
    Number.isSafeInteger(height) &&
    width > 0 &&
    height > 0 &&
    width <= MAX_IMAGE_PIXELS &&
    height <= MAX_IMAGE_PIXELS;
}

/**
 * Builds an import function that turns a picked file into an
 * `ImportedReference` that passes the shared `parseImportedReference`
 * contract. The function is pure: every side effect (file reading, image
 * decoding, UUID generation, timestamps) comes from injected dependencies, so
 * tests run without browser timing or DOM access. SVG content is carried as
 * opaque bytes inside a base64 data URL and is never inserted into any DOM.
 *
 * Failures are returned as `ImportError` results; this module never sends
 * Chrome messages. A caller dispatches `replace-reference` only on success.
 */
export function createImportReference(deps: ImportDependencies) {
  return async function importReference(
    file: ImportFileLike,
  ): Promise<Result<ImportedReference, ImportError>> {
    if (typeof file !== "object" || file === null || typeof file.name !== "string" ||
      file.name.length === 0 || typeof file.type !== "string" ||
      typeof file.size !== "number" || !Number.isSafeInteger(file.size) || file.size < 0) {
      return { ok: false, error: typeError() };
    }

    // base64 expands every 3 input bytes to 4 characters; reject files whose
    // encoded form cannot fit the limit before any bytes are allocated.
    if (file.size > MAX_IMAGE_RAW_BYTES || DATA_URL_PREFIX_BYTES + Math.ceil(file.size / 3) * 4 > MAX_IMAGE_ENCODED_BYTES) {
      return { ok: false, error: tooLargeError() };
    }

    const bytes = await readFileSafely(deps.readFile, file);
    if (bytes === null) return { ok: false, error: decodeError() };
    if (bytes.byteLength !== file.size) return { ok: false, error: decodeError() };

    const detected = sniffImageMimeType(bytes);
    if (detected === null) return { ok: false, error: typeError() };
    if (file.type.trim().toLowerCase() !== detected) return { ok: false, error: typeError() };
    if (bytes.byteLength > MAX_IMAGE_RAW_BYTES) return { ok: false, error: tooLargeError() };

    const dimensions = await decodeImageSafely(deps.decodeImage, bytes, detected);
    if (!isValidDimensions(dimensions)) return { ok: false, error: decodeError() };
    if (dimensions.width * dimensions.height > MAX_IMAGE_PIXELS) {
      return { ok: false, error: tooManyPixelsError() };
    }

    const id = deps.randomReferenceId();
    if (!UUID_V4.test(id)) return { ok: false, error: decodeError() };
    const importedAt = deps.currentTimestamp();
    if (!Number.isSafeInteger(importedAt) || importedAt < 0) return { ok: false, error: decodeError() };

    const dataUrl = `data:${detected};base64,${base64Encode(bytes)}`;
    const encodedBytes = dataUrl.length;
    if (encodedBytes > MAX_IMAGE_ENCODED_BYTES) return { ok: false, error: tooLargeError() };

    const metadata: ReferenceMetadata = {
      id: id as ReferenceId,
      name: file.name,
      mimeType: detected,
      width: dimensions.width,
      height: dimensions.height,
      encodedBytes,
      importedAt,
    };
    return { ok: true, value: { metadata, dataUrl } };
  };
}
