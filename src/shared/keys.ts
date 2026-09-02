import type { Origin, PageKey, ReferenceId } from "./contracts";

const PREFIX = "pixel-pincher";
/** Namespace left by unpublished builds; repository maintenance deletes these opaque keys. */
export const OBSOLETE_PAGE_STORAGE_PREFIX = `${PREFIX}:page:`;
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

function key(kind: "origin" | "image", segment: string): string {
  return `${PREFIX}:${kind}:${encodeURIComponent(segment)}`;
}

export function originRecordKey(origin: Origin): string {
  return key("origin", origin);
}

/** Identifies the image-record namespace without reading a stored payload. */
export function isImageRecordKey(value: string): boolean {
  return value.startsWith(IMAGE_RECORD_KEY_PREFIX);
}

export function imageRecordKey(referenceId: ReferenceId): string {
  return key("image", referenceId);
}
