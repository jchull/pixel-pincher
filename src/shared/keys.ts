import type { Origin, PageKey, ReferenceId } from "./contracts";

const PREFIX = "pixel-pincher";

export const ORIGIN_INDEX_KEY = `${PREFIX}:origins`;

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
