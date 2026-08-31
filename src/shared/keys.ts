import type { Origin, PageKey, ReferenceId } from "./contracts";

const PREFIX = "pixel-pincher";
const PAGE_RECORD_PREFIX = `${PREFIX}:page:`;
export const IMAGE_RECORD_KEY_PREFIX = `${PREFIX}:image:`;

export const ORIGIN_INDEX_KEY = `${PREFIX}:origins`;

function isHttpUrl(url: URL): boolean {
  return url.protocol === "http:" || url.protocol === "https:";
}

function asOrigin(value: string): Origin {
  return value as Origin;
}

function asPageKey(value: string): PageKey {
  return value as PageKey;
}

/** Derive canonical storage identity from an already-parsed supported URL. */
export function deriveOrigin(url: URL): Origin | undefined {
  return isHttpUrl(url) ? asOrigin(url.origin) : undefined;
}

/** Derive the canonical, hashless page identity from an already-parsed supported URL. */
export function derivePageKey(url: URL): PageKey | undefined {
  if (!isHttpUrl(url)) return undefined;

  const pageUrl = new URL(url.toString());
  pageUrl.hash = "";
  return asPageKey(pageUrl.toString());
}

function key(kind: "origin" | "page" | "image", segment: string): string {
  return `${PREFIX}:${kind}:${encodeURIComponent(segment)}`;
}

export function originRecordKey(origin: Origin): string {
  return key("origin", origin);
}

export function pageRecordKey(pageKey: PageKey): string {
  return key("page", pageKey);
}

/** Return an origin only for a canonical page-record key. */
export function pageRecordKeyOrigin(value: string): Origin | undefined {
  if (!value.startsWith(PAGE_RECORD_PREFIX)) return undefined;

  let pageUrl: URL;
  try {
    pageUrl = new URL(decodeURIComponent(value.slice(PAGE_RECORD_PREFIX.length)));
  } catch {
    return undefined;
  }

  const pageKey = derivePageKey(pageUrl);
  const origin = deriveOrigin(pageUrl);
  if (pageKey === undefined || origin === undefined || pageRecordKey(pageKey) !== value) {
    return undefined;
  }

  return origin;
}

/** Identifies the image-record namespace without reading a stored payload. */
export function isImageRecordKey(value: string): boolean {
  return value.startsWith(IMAGE_RECORD_KEY_PREFIX);
}

export function imageRecordKey(referenceId: ReferenceId): string {
  return key("image", referenceId);
}
