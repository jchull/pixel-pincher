import { describe, expect, it } from "vitest";

import { MAX_PANEL_POSITION, MIN_PANEL_POSITION } from "../../src/shared/contracts";
import {
  parseContentPanelRequest,
  parseContentPanelResponse,
  parseContentRequestWithPanelPosition,
  parseOriginRecordWithPanelPosition,
  parseOverlaySnapshotWithPanelPosition,
  parsePanelPosition,
} from "../../src/shared/panel-position";

const originRecord = {
  schemaVersion: 1,
  revision: 2,
  origin: "https://example.com",
  settings: {
    visible: true,
    opacity: 0.5,
    inverted: false,
    sizing: { kind: "fit-width", lastScalePercent: 100 },
    interactionMode: "click-through",
  },
  reference: null,
};

const snapshot = {
  revision: 2,
  origin: "https://example.com",
  pageKey: "https://example.com/page",
  settings: {
    ...originRecord.settings,
    placement: { x: 0, y: 0 },
  },
  reference: null,
};

describe("panel position boundaries", () => {
  it("accepts only safe integer coordinates within the documented bounds", () => {
    expect(parsePanelPosition({ x: MIN_PANEL_POSITION, y: MAX_PANEL_POSITION }).ok).toBe(true);
    expect(parsePanelPosition({ x: MIN_PANEL_POSITION - 1, y: 0 }).ok).toBe(false);
    expect(parsePanelPosition({ x: 0, y: MAX_PANEL_POSITION + 1 }).ok).toBe(false);
    expect(parsePanelPosition({ x: 1.5, y: 0 }).ok).toBe(false);
    expect(parsePanelPosition({ x: 0, y: 0, extra: true }).ok).toBe(false);
  });

  it("parses legacy V1 origin records and optional panel positions without widening their schemas", () => {
    expect(parseOriginRecordWithPanelPosition(originRecord)).toEqual({ ok: true, value: originRecord });
    expect(parseOriginRecordWithPanelPosition({ ...originRecord, panelPosition: { x: 12, y: 34 } })).toEqual({
      ok: true,
      value: { ...originRecord, panelPosition: { x: 12, y: 34 } },
    });
    expect(parseOriginRecordWithPanelPosition({ ...originRecord, panelPosition: { x: -1, y: 0 } }).ok).toBe(false);
    expect(parseOriginRecordWithPanelPosition({ ...originRecord, extra: true }).ok).toBe(false);
  });

  it("keeps panel position optional in snapshots and parses correlated sender-bound requests", () => {
    expect(parseOverlaySnapshotWithPanelPosition(snapshot)).toEqual({ ok: true, value: snapshot });
    expect(parseOverlaySnapshotWithPanelPosition({ ...snapshot, panelPosition: { x: 7, y: 9 } })).toEqual({
      ok: true,
      value: { ...snapshot, panelPosition: { x: 7, y: 9 } },
    });
    expect(parseContentPanelRequest({
      kind: "update-panel-position",
      requestId: "panel-1",
      panelPosition: { x: 7, y: 9 },
    })).toMatchObject({ ok: true, value: { requestId: "panel-1" } });
    const dataUrl = "data:image/png;base64,AQID";
    const reference = {
      metadata: {
        id: "123e4567-e89b-42d3-a456-426614174000",
        name: "reference.png",
        mimeType: "image/png",
        width: 2,
        height: 2,
        encodedBytes: dataUrl.length,
        importedAt: 1,
      },
      dataUrl,
    };
    expect(parseContentPanelRequest({ kind: "get-panel-state", requestId: "get" })).toMatchObject({ ok: true });
    expect(parseContentPanelRequest({ kind: "replace-reference", requestId: "replace", reference })).toMatchObject({ ok: true });
    expect(parseContentPanelRequest({ kind: "update-settings", requestId: "setting", patch: { kind: "opacity", opacity: 0.5 } })).toMatchObject({ ok: true });
    expect(parseContentPanelRequest({ kind: "clear-site", requestId: "clear" })).toMatchObject({ ok: true });
    expect(parseContentPanelRequest({
      kind: "update-panel-position",
      requestId: "",
      panelPosition: { x: 7, y: 9 },
    }).ok).toBe(false);
    expect(parseContentPanelRequest({ kind: "update-settings", requestId: "bad", patch: { kind: "opacity", opacity: 2 } }).ok).toBe(false);
    expect(parseContentPanelResponse({
      requestId: "response",
      ok: true,
      value: { ...snapshot, panelPosition: { x: 7, y: 9 } },
    })).toMatchObject({ ok: true, value: { requestId: "response", ok: true } });
    expect(parseContentRequestWithPanelPosition({
      kind: "apply-settings",
      snapshot: { ...snapshot, panelPosition: { x: 7, y: 9 } },
    })).toMatchObject({ ok: true, value: { snapshot: { panelPosition: { x: 7, y: 9 } } } });
  });
});
