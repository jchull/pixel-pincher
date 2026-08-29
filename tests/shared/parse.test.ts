import { describe, expect, it } from "vitest";

import {
  publicError,
  type PublicError,
  type Result,
} from "../../src/shared/contracts";
import {
  parseContentEvent,
  parseContentRequest,
  parseHydration,
  parseImportedReference,
  parseOrigin,
  parseOverlaySnapshot,
  parseImageRecordV1,
  parseOriginIndexV1,
  parseOriginRecordV1,
  parseOverlaySettings,
  parsePageKey,
  parsePageRecordV1,
  parsePopupRequest,
  parsePopupResponse,
  parsePublicError,
  parseReferenceId,
  parseReferenceMetadata,
  parseSettingsPatch,
  parseSizing,
  parseSupportedUrl,
  parseTabState,
} from "../../src/shared/parse";

const id = "123e4567-e89b-42d3-a456-426614174000";
const dataUrl = "data:image/png;base64,AQID";
const metadata = {
  id,
  name: "reference.png",
  mimeType: "image/png",
  width: 2,
  height: 2,
  encodedBytes: new TextEncoder().encode(dataUrl).byteLength,
  importedAt: 1,
};
const importedReference = {
  metadata,
  dataUrl,
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
    expect(parseReferenceMetadata({ ...metadata, importedAt: Number.MAX_SAFE_INTEGER + 1 }).ok).toBe(false);
    expect(parseImportedReference(importedReference).ok).toBe(true);
    expect(parseImportedReference({ ...importedReference, dataUrl: "data:image/png,abc" }).ok).toBe(false);
    expect(parseImportedReference({ ...importedReference, dataUrl: "data:image/gif;base64,AQID" }).ok).toBe(false);
    expect(parseImportedReference({ ...importedReference, dataUrl: "data:image/png;base64," }).ok).toBe(false);
    expect(parseImportedReference({ ...importedReference, metadata: { ...metadata, encodedBytes: 2 } }).ok).toBe(false);
    expect(parseImageRecordV1({ schemaVersion: 1, referenceId: id, dataUrl }).ok).toBe(true);
    expect(parseImageRecordV1({ schemaVersion: 1, referenceId: id, dataUrl: "data:text/plain;base64,AQID" }).ok).toBe(false);
    const oversizedDataUrl = `data:image/png;base64,${"AAAA".repeat(4 * 1024 * 1024)}`;
    expect(parseImageRecordV1({ schemaVersion: 1, referenceId: id, dataUrl: oversizedDataUrl }).ok).toBe(false);
  });

  it("validates multi-megabyte base64 payloads without recursive regex matching", () => {
    const payload = "AAAA".repeat(512 * 1024);
    const largeDataUrl = `data:image/png;base64,${payload}`;
    expect(parseImportedReference({
      metadata: { ...metadata, encodedBytes: new TextEncoder().encode(largeDataUrl).byteLength },
      dataUrl: largeDataUrl,
    })).toEqual({ ok: true, value: expect.objectContaining({ dataUrl: largeDataUrl }) });
  });

  it("rejects data URLs with trailing line terminators or any unmatched suffix", () => {
    for (const suffix of ["\n", "\r\n", "\r", " ", "\n\n", ";", "A"]) {
      expect(parseImageRecordV1({ schemaVersion: 1, referenceId: id, dataUrl: dataUrl + suffix }).ok, `record [${suffix}]`).toBe(false);
      expect(parseImportedReference({ ...importedReference, dataUrl: dataUrl + suffix }).ok, `reference [${suffix}]`).toBe(false);
    }
    // The canonical URL still parses and round-trips exactly.
    expect(parseImageRecordV1({ schemaVersion: 1, referenceId: id, dataUrl }).ok).toBe(true);
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

  it("makes hydration constructive and requires complete metadata equality", () => {
    expect(parseHydration({ snapshot, reference: importedReference }).ok).toBe(true);
    expect(parseHydration({ snapshot: { ...snapshot, reference: null }, reference: importedReference }).ok).toBe(false);
    expect(parseHydration({ snapshot, reference: { ...importedReference, metadata: { ...metadata, id: "123e4567-e89b-42d3-b456-426614174000" } } }).ok).toBe(false);
    expect(parseHydration({ snapshot, reference: { ...importedReference, metadata: { ...metadata, name: "other.png" } } }).ok).toBe(false);
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

  it("parses every strict content message variant and safe revisions", () => {
    expect(parseContentRequest({ kind: "hydrate-overlay", hydration: { snapshot, reference: importedReference } }).ok).toBe(true);
    expect(parseContentRequest({ kind: "apply-settings", snapshot }).ok).toBe(true);
    expect(parseContentRequest({ kind: "clear-overlay", revision: 1 }).ok).toBe(true);
    expect(parseContentRequest({ kind: "clear-overlay", revision: Number.MAX_SAFE_INTEGER + 1 }).ok).toBe(false);
    expect(parseContentEvent({ kind: "content-ready", url: "https://example.com/page" }).ok).toBe(true);
    expect(parseContentEvent({ kind: "placement-committed", url: "https://example.com/page", placement: { x: -1_000_000, y: 1_000_000 } }).ok).toBe(true);
    expect(parseContentEvent({ kind: "image-load-failed", url: "https://example.com/page", referenceId: id }).ok).toBe(true);
    expect(parseContentEvent({ kind: "placement-committed", url: "https://example.com/page", placement: { x: 1_000_001, y: 0 } }).ok).toBe(false);
  });

  it("parses only reference-aware render diagnostics in tab state", () => {
    const diagnostic = { referenceId: id, error: publicError("image-render-failed") };
    expect(parseTabState({
      tabId: 3,
      url: "https://example.com/page",
      origin: "https://example.com",
      enabled: true,
      snapshot,
      diagnostic,
    }).ok).toBe(true);
    expect(parseTabState({
      tabId: 3,
      url: "https://example.com/page",
      origin: "https://example.com",
      enabled: true,
      snapshot,
      diagnostic: { ...diagnostic, error: publicError("storage-failed") },
    }).ok).toBe(false);
  });

  it("parses canonical popup responses and every request variant", () => {
    const response = { requestId: "response-1", ok: true, value: 1 };
    const numberParser = (value: unknown): Result<number, PublicError> => typeof value === "number"
      ? { ok: true, value }
      : { ok: false, error: publicError("invalid-request") };
    expect(parsePopupResponse(response, numberParser).ok).toBe(true);
    expect(parsePopupResponse({ requestId: "response-1", ok: false, error: { code: "storage-failed", message: "Pixel Pincher could not save this change." } }, numberParser).ok).toBe(true);
    expect(parsePopupResponse({ requestId: "response-1", ok: false, error: { code: "storage-failed", message: "raw Chrome error" } }, numberParser).ok).toBe(false);
    expect(parsePublicError({ code: "invalid-request", message: "Pixel Pincher received an invalid request." }).ok).toBe(true);
    expect(parsePopupRequest({ kind: "get-tab-state", requestId: "a" }).ok).toBe(true);
    expect(parsePopupRequest({ kind: "register-site", requestId: "a", url: "https://example.com/page" }).ok).toBe(true);
    expect(parsePopupRequest({ kind: "replace-reference", requestId: "a", url: "https://example.com/page", reference: importedReference }).ok).toBe(true);
    expect(parsePopupRequest({ kind: "update-settings", requestId: "a", url: "https://example.com/page", patch: { kind: "visibility", visible: false } }).ok).toBe(true);
    expect(parsePopupRequest({ kind: "clear-site", requestId: "a", url: "https://example.com/page" }).ok).toBe(true);
  });

  it("parses snapshots directly and rejects malformed or extra snapshot fields", () => {
    expect(parseOverlaySnapshot(snapshot).ok).toBe(true);
    expect(parseOverlaySnapshot({ ...snapshot, revision: -1 }).ok).toBe(false);
    expect(parseOverlaySnapshot({ ...snapshot, pageKey: "https://elsewhere.example/page" }).ok).toBe(false);
    expect(parseOverlaySnapshot({ ...snapshot, extra: true }).ok).toBe(false);
    expect(parseOverlaySnapshot({ ...snapshot, reference: { ...metadata, extra: true } }).ok).toBe(false);
  });

  it("covers every settings patch variant and its malformed counterpart", () => {
    const patches = [
      { valid: { kind: "visibility", visible: true }, invalid: { kind: "visibility", visible: "true" } },
      { valid: { kind: "opacity", opacity: 0.25 }, invalid: { kind: "opacity", opacity: -0.1 } },
      { valid: { kind: "inversion", inverted: true }, invalid: { kind: "inversion", inverted: 1 } },
      { valid: { kind: "sizing", sizing: { kind: "scale", percent: 100 } }, invalid: { kind: "sizing", sizing: { kind: "scale", percent: 401 } } },
      { valid: { kind: "interaction-mode", interactionMode: "drag" }, invalid: { kind: "interaction-mode", interactionMode: "pass-through" } },
      { valid: { kind: "placement", placement: { x: 1, y: -1 } }, invalid: { kind: "placement", placement: { x: 1.5, y: -1 } } },
    ];
    for (const patch of patches) {
      expect(parseSettingsPatch(patch.valid).ok).toBe(true);
      expect(parseSettingsPatch(patch.invalid).ok).toBe(false);
      expect(parseSettingsPatch({ ...patch.valid, extra: true }).ok).toBe(false);
    }
    expect(parseSettingsPatch({ kind: "unknown" }).ok).toBe(false);
  });

  it("covers popup and content variants, malformed fields, extras, and unknown discriminants", () => {
    const popupRequests = [
      { kind: "get-tab-state", requestId: "a" },
      { kind: "register-site", requestId: "a", url: "https://example.com/page" },
      { kind: "replace-reference", requestId: "a", url: "https://example.com/page", reference: importedReference },
      { kind: "update-settings", requestId: "a", url: "https://example.com/page", patch: { kind: "visibility", visible: true } },
      { kind: "clear-site", requestId: "a", url: "https://example.com/page" },
    ];
    for (const request of popupRequests) {
      expect(parsePopupRequest(request).ok).toBe(true);
      expect(parsePopupRequest({ ...request, extra: true }).ok).toBe(false);
    }
    expect(parsePopupRequest({ kind: "unknown", requestId: "a" }).ok).toBe(false);
    expect(parsePopupRequest({ kind: "register-site", requestId: 1, url: "https://example.com/page" }).ok).toBe(false);

    const contentRequests = [
      { kind: "hydrate-overlay", hydration: { snapshot, reference: importedReference } },
      { kind: "apply-settings", snapshot },
      { kind: "clear-overlay", revision: 1 },
    ];
    for (const request of contentRequests) {
      expect(parseContentRequest(request).ok).toBe(true);
      expect(parseContentRequest({ ...request, extra: true }).ok).toBe(false);
    }
    expect(parseContentRequest({ kind: "unknown" }).ok).toBe(false);
    expect(parseContentRequest({ kind: "clear-overlay", revision: -1 }).ok).toBe(false);

    const contentEvents = [
      { kind: "content-ready", url: "https://example.com/page" },
      { kind: "placement-committed", url: "https://example.com/page", placement: { x: 0, y: 0 } },
      { kind: "image-load-failed", url: "https://example.com/page", referenceId: id },
    ];
    for (const event of contentEvents) {
      expect(parseContentEvent(event).ok).toBe(true);
      expect(parseContentEvent({ ...event, extra: true }).ok).toBe(false);
    }
    expect(parseContentEvent({ kind: "unknown" }).ok).toBe(false);
    expect(parseContentEvent({ kind: "content-ready", url: "ftp://example.com/" }).ok).toBe(false);
  });

  it("accepts every public error code and rejects unknown or extra errors", () => {
    for (const [code, message] of Object.entries({
      "unsupported-url": "This page cannot use Pixel Pincher.",
      "site-access-denied": "Pixel Pincher needs permission for this site.",
      "site-access-revoked": "Site access was removed.",
      "content-unavailable": "The page overlay is unavailable. Reload the page and try again.",
      "invalid-image-type": "Choose a PNG, JPEG, WebP, or SVG image.",
      "image-too-large": "The image is too large. Choose an image up to 10 MiB.",
      "image-too-many-pixels": "The image has too many pixels. Choose an image with at most 40 million pixels.",
      "image-decode-failed": "Pixel Pincher could not decode that image.",
      "invalid-request": "Pixel Pincher received an invalid request.",
      "invalid-stored-data": "Stored Pixel Pincher data is invalid. Clear this site's data and try again.",
      "storage-failed": "Pixel Pincher could not save this change.",
      "image-render-failed": "Pixel Pincher could not render the reference image.",
    })) {
      expect(parsePublicError({ code, message }).ok).toBe(true);
    }
    expect(parsePublicError({ code: "unknown", message: "unknown" }).ok).toBe(false);
    expect(parsePublicError({ code: "storage-failed", message: "Pixel Pincher could not save this change.", extra: true }).ok).toBe(false);
  });
});
