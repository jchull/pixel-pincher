import type { Origin, PageKey, ReferenceId } from "./contracts";

const PREFIX = "pixel-pincher";

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

export function imageRecordKey(referenceId: ReferenceId): string {
  return key("image", referenceId);
}
