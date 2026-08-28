import { describe, expect, it } from "vitest";

import {
  parseContentEvent,
  parseHydration,
  parseImportedReference,
  parseOrigin,
  parseOriginIndexV1,
  parseOriginRecordV1,
  parseOverlaySettings,
  parsePageKey,
  parsePageRecordV1,
  parsePopupRequest,
  parseReferenceId,
  parseReferenceMetadata,
  parseSettingsPatch,
  parseSizing,
  parseSupportedUrl,
} from "../../src/shared/parse";

const id = "123e4567-e89b-42d3-a456-426614174000";
const metadata = {
  id,
  name: "reference.png",
  mimeType: "image/png",
  width: 2,
  height: 2,
  encodedBytes: 3,
  importedAt: 1,
};
const importedReference = {
  metadata,
  dataUrl: "data:image/png;base64,AQID",
};
const settings = {
  visible: true,
  opacity: 0.5,
  inverted: false,
  placement: { x: 0, y: 0 },
  sizing: { kind: "fit-width", lastScalePercent: 100 },
  interactionMode: "click-through",
};
function errorCode(result: { readonly ok: boolean; readonly error?: { readonly code: string } }): string {
  if (result.ok) throw new Error("Expected parser failure.");
  return result.error?.code ?? "missing-error";
}

const snapshot = {
  revision: 0,
  origin: "https://example.com",
  pageKey: "https://example.com/page",
  settings,
  reference: metadata,
};

describe("boundary parsers", () => {
  it("accepts only canonical supported URLs, origins, and page keys", () => {
    expect(parseSupportedUrl("https://example.com/page").ok).toBe(true);
    expect(parseSupportedUrl("https://example.com").ok).toBe(false);
    expect(errorCode(parseSupportedUrl("chrome://extensions/"))).toBe("unsupported-url");
    expect(parseOrigin("https://example.com").ok).toBe(true);
    expect(parseOrigin("https://example.com/").ok).toBe(false);
    expect(parsePageKey("https://example.com/page").ok).toBe(true);
    expect(parsePageKey("https://example.com/page#section").ok).toBe(false);
  });

  it("enforces canonical UUID-v4 reference IDs", () => {
    expect(parseReferenceId(id).ok).toBe(true);
    expect(parseReferenceId(id.toUpperCase()).ok).toBe(false);
    expect(parseReferenceId("123e4567-e89b-12d3-a456-426614174000").ok).toBe(false);
  });

  it("validates settings bounds, variants, and exact fields", () => {
    expect(parseOverlaySettings(settings).ok).toBe(true);
    expect(parseOverlaySettings({ ...settings, opacity: 1.1 }).ok).toBe(false);
    expect(parseOverlaySettings({ ...settings, extra: true }).ok).toBe(false);
    expect(parseSizing({ kind: "scale", percent: 10 }).ok).toBe(true);
    expect(parseSizing({ kind: "scale", percent: 10.5 }).ok).toBe(false);
    expect(parseSizing({ kind: "fit-width", lastScalePercent: 401 }).ok).toBe(false);
    expect(parseSettingsPatch({ kind: "inversion", inverted: true }).ok).toBe(true);
    expect(parseSettingsPatch({ kind: "inversion", inverted: true, extra: true }).ok).toBe(false);
  });

  it("rejects malformed, oversized, or mismatched image references", () => {
    expect(parseReferenceMetadata(metadata).ok).toBe(true);
    expect(parseReferenceMetadata({ ...metadata, width: 0 }).ok).toBe(false);
    expect(parseReferenceMetadata({ ...metadata, width: 40_000_001, height: 1 }).ok).toBe(false);
    expect(parseImportedReference(importedReference).ok).toBe(true);
    expect(parseImportedReference({ ...importedReference, dataUrl: "data:image/png,abc" }).ok).toBe(false);
    expect(parseImportedReference({ ...importedReference, metadata: { ...metadata, encodedBytes: 2 } }).ok).toBe(false);
  });

  it("parses each popup request and rejects accessors, inherited fields, and extras", () => {
    expect(parsePopupRequest({ kind: "register-site", requestId: "a", url: "https://example.com/page" }).ok).toBe(true);
    expect(parsePopupRequest({ kind: "clear-site", requestId: "a", url: "ftp://example.com/" }).ok).toBe(false);
    expect(parsePopupRequest({ kind: "get-tab-state", requestId: "a", extra: true }).ok).toBe(false);
    const inherited = Object.create({ kind: "get-tab-state", requestId: "a" });
    expect(parsePopupRequest(inherited).ok).toBe(false);
    const accessor = Object.defineProperty({}, "kind", { enumerable: true, get: () => "get-tab-state" });
    Object.defineProperty(accessor, "requestId", { enumerable: true, value: "a" });
    expect(parsePopupRequest(accessor).ok).toBe(false);
  });

  it("makes hydration constructive and rejects cross-record reference mismatch", () => {
    expect(parseHydration({ snapshot, reference: importedReference }).ok).toBe(true);
    expect(parseHydration({ snapshot: { ...snapshot, reference: null }, reference: importedReference }).ok).toBe(false);
    expect(parseHydration({ snapshot, reference: { ...importedReference, metadata: { ...metadata, id: "123e4567-e89b-42d3-b456-426614174000" } } }).ok).toBe(false);
  });

  it("rejects malformed, future, and inconsistent storage records", () => {
    const originRecord = {
      schemaVersion: 1,
      revision: 1,
      origin: "https://example.com",
      settings: { visible: true, opacity: 0.5, inverted: false, sizing: { kind: "scale", percent: 100 }, interactionMode: "drag" },
      reference: metadata,
    };
    expect(parseOriginRecordV1(originRecord).ok).toBe(true);
    expect(parseOriginRecordV1({ ...originRecord, settings: { ...originRecord.settings, placement: { x: 0, y: 0 } } }).ok).toBe(false);
    expect(errorCode(parseOriginRecordV1({ ...originRecord, schemaVersion: 2 }))).toBe("invalid-stored-data");
    expect(parsePageRecordV1({ schemaVersion: 1, revision: 1, origin: "https://example.com", pageKey: "https://elsewhere.example/page", placement: { x: 0, y: 0 } }).ok).toBe(false);
    expect(parseOriginIndexV1({ schemaVersion: 1, origins: ["https://example.com", "https://example.com"] }).ok).toBe(false);
  });

  it("parses strict content events", () => {
    expect(parseContentEvent({ kind: "placement-committed", url: "https://example.com/page", placement: { x: -1_000_000, y: 1_000_000 } }).ok).toBe(true);
    expect(parseContentEvent({ kind: "placement-committed", url: "https://example.com/page", placement: { x: 1_000_001, y: 0 } }).ok).toBe(false);
  });
});
