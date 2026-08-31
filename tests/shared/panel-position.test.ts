import { describe, expect, it } from "vitest";

import {
  MAX_PANEL_POSITION,
  MIN_PANEL_POSITION,
} from "../../src/shared/contracts";
import {
  parseContentPanelRequest,
  parseContentPanelResponse,
} from "../../src/shared/panel-position";
import {
  parseContentRequest,
  parseHydration,
  parseOriginRecordV1,
  parseOverlaySnapshot,
  parsePanelPosition,
} from "../../src/shared/parse";

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
    expect(
      parsePanelPosition({ x: MIN_PANEL_POSITION, y: MAX_PANEL_POSITION }).ok,
    ).toBe(true);
    expect(parsePanelPosition({ x: MIN_PANEL_POSITION - 1, y: 0 }).ok).toBe(
      false,
    );
    expect(parsePanelPosition({ x: 0, y: MAX_PANEL_POSITION + 1 }).ok).toBe(
      false,
    );
    expect(parsePanelPosition({ x: 1.5, y: 0 }).ok).toBe(false);
    expect(parsePanelPosition({ x: 0, y: 0, extra: true }).ok).toBe(false);
  });

  it("parses every valid optional-key combination in V1 origin records", () => {
    const optionalFields = [
      {},
      { placement: { x: 12, y: 34 } },
      { panelPosition: { x: 12, y: 34 } },
      {
        placement: { x: 12, y: 34 },
        panelPosition: { x: 12, y: 34 },
      },
    ];
    for (const fields of optionalFields) {
      expect(parseOriginRecordV1({ ...originRecord, ...fields }).ok).toBe(true);
    }
    expect(
      parseOriginRecordV1({
        ...originRecord,
        panelPosition: { x: -1, y: 0 },
      }).ok,
    ).toBe(false);
    expect(parseOriginRecordV1({ ...originRecord, extra: true }).ok).toBe(
      false,
    );
  });

  it("keeps panel position optional in canonical snapshots and nested messages", () => {
    const positionedSnapshot = { ...snapshot, panelPosition: { x: 7, y: 9 } };
    expect(parseOverlaySnapshot(snapshot)).toEqual({ ok: true, value: snapshot });
    expect(parseOverlaySnapshot(positionedSnapshot)).toEqual({
      ok: true,
      value: positionedSnapshot,
    });
    expect(parseOverlaySnapshot({ ...positionedSnapshot, extra: true }).ok).toBe(
      false,
    );
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
    const positionedSnapshotWithReference = {
      ...positionedSnapshot,
      reference: reference.metadata,
    };
    expect(
      parseHydration({
        snapshot: positionedSnapshotWithReference,
        reference,
      }).ok,
    ).toBe(true);
    expect(
      parseContentRequest({
        kind: "hydrate-overlay",
        hydration: { snapshot: positionedSnapshotWithReference, reference },
      }).ok,
    ).toBe(true);
    expect(
      parseContentRequest({
        kind: "apply-settings",
        snapshot: positionedSnapshot,
      }).ok,
    ).toBe(true);
    expect(
      parseContentPanelRequest({
        kind: "update-panel-position",
        requestId: "panel-1",
        panelPosition: { x: 7, y: 9 },
      }),
    ).toMatchObject({ ok: true, value: { requestId: "panel-1" } });
    expect(
      parseContentPanelRequest({ kind: "get-panel-state", requestId: "get" }),
    ).toMatchObject({ ok: true });
    expect(
      parseContentPanelRequest({
        kind: "replace-reference",
        requestId: "replace",
        reference,
      }),
    ).toMatchObject({ ok: true });
    expect(
      parseContentPanelRequest({
        kind: "update-settings",
        requestId: "setting",
        patch: { kind: "opacity", opacity: 0.5 },
      }),
    ).toMatchObject({ ok: true });
    expect(
      parseContentPanelRequest({ kind: "clear-site", requestId: "clear" }),
    ).toMatchObject({ ok: true });
    expect(
      parseContentPanelRequest({
        kind: "update-panel-position",
        requestId: "",
        panelPosition: { x: 7, y: 9 },
      }).ok,
    ).toBe(false);
    expect(
      parseContentPanelRequest({
        kind: "update-settings",
        requestId: "bad",
        patch: { kind: "opacity", opacity: 2 },
      }).ok,
    ).toBe(false);
    expect(
      parseContentPanelResponse({
        requestId: "response",
        ok: true,
        value: positionedSnapshot,
      }),
    ).toMatchObject({ ok: true, value: { requestId: "response", ok: true } });
    expect(
      parseContentRequest({
        kind: "apply-settings",
        snapshot: positionedSnapshot,
      }),
    ).toMatchObject({
      ok: true,
      value: { snapshot: { panelPosition: { x: 7, y: 9 } } },
    });
  });
});
