import {
  MAX_PANEL_POSITION,
  MIN_PANEL_POSITION,
  publicError,
  type ContentPanelRequest,
  type ContentRequest,
  type Hydration,
  type OriginRecordV1,
  type OverlaySnapshot,
  type PanelPosition,
  type PublicError,
  type Result,
} from "./contracts";
import {
  parseContentRequest,
  parseHydration,
  parseOriginRecordV1,
  parseOverlaySnapshot,
} from "./parse";

type UnknownRecord = Record<string, unknown>;

function failure<T>(code: "invalid-request" | "invalid-stored-data"): Result<T, PublicError> {
  return { ok: false, error: publicError(code) };
}

function isOwnDataRecord(value: unknown): value is UnknownRecord {
  if (typeof value !== "object" || value === null) return false;
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) return false;
  return Reflect.ownKeys(value).every((key) => {
    if (typeof key !== "string") return false;
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    return descriptor !== undefined && descriptor.enumerable && "value" in descriptor;
  });
}

function hasExactKeys(value: UnknownRecord, keys: readonly string[]): boolean {
  const ownKeys = Reflect.ownKeys(value);
  return ownKeys.length === keys.length && keys.every((key) => Object.hasOwn(value, key));
}

function parsePanelPositionValue(
  value: unknown,
  code: "invalid-request" | "invalid-stored-data",
): Result<PanelPosition, PublicError> {
  if (!isOwnDataRecord(value) || !hasExactKeys(value, ["x", "y"])) return failure(code);
  const { x, y } = value;
  if (
    typeof x !== "number" ||
    !Number.isSafeInteger(x) ||
    x < MIN_PANEL_POSITION ||
    x > MAX_PANEL_POSITION ||
    typeof y !== "number" ||
    !Number.isSafeInteger(y) ||
    y < MIN_PANEL_POSITION ||
    y > MAX_PANEL_POSITION
  ) {
    return failure(code);
  }
  return { ok: true, value: { x, y } };
}

/** Validates the persisted, viewport-relative control-panel coordinates. */
export function parsePanelPosition(value: unknown): Result<PanelPosition, PublicError> {
  return parsePanelPositionValue(value, "invalid-request");
}

/** Accepts both legacy V1 records and V1 records extended with an optional panel position. */
export function parseOriginRecordWithPanelPosition(
  value: unknown,
): Result<OriginRecordV1, PublicError> {
  if (!isOwnDataRecord(value) || !Object.hasOwn(value, "panelPosition")) {
    return parseOriginRecordV1(value);
  }
  if (!hasExactKeys(value, ["schemaVersion", "revision", "origin", "settings", "reference", "panelPosition"])) {
    return failure("invalid-stored-data");
  }
  const panelPosition = parsePanelPositionValue(value.panelPosition, "invalid-stored-data");
  if (!panelPosition.ok) return panelPosition;
  const legacyRecord = { ...value };
  delete legacyRecord.panelPosition;
  const parsed = parseOriginRecordV1(legacyRecord);
  if (!parsed.ok) return parsed;
  return { ok: true, value: { ...parsed.value, panelPosition: panelPosition.value } };
}

/** Accepts snapshots with or without the optional panel position. */
export function parseOverlaySnapshotWithPanelPosition(
  value: unknown,
): Result<OverlaySnapshot, PublicError> {
  if (!isOwnDataRecord(value) || !Object.hasOwn(value, "panelPosition")) {
    return parseOverlaySnapshot(value);
  }
  if (!hasExactKeys(value, ["revision", "origin", "pageKey", "settings", "reference", "panelPosition"])) {
    return failure("invalid-request");
  }
  const panelPosition = parsePanelPosition(value.panelPosition);
  if (!panelPosition.ok) return panelPosition;
  const legacySnapshot = { ...value };
  delete legacySnapshot.panelPosition;
  const parsed = parseOverlaySnapshot(legacySnapshot);
  if (!parsed.ok) return parsed;
  return { ok: true, value: { ...parsed.value, panelPosition: panelPosition.value } };
}

/** Parses only the correlated mutation request allowed from a top-frame content panel. */
function parseHydrationWithPanelPosition(value: unknown): Result<Hydration, PublicError> {
  if (!isOwnDataRecord(value) || !hasExactKeys(value, ["snapshot", "reference"])) {
    return failure("invalid-request");
  }
  const snapshot = parseOverlaySnapshotWithPanelPosition(value.snapshot);
  if (!snapshot.ok) return snapshot;
  if (!isOwnDataRecord(value.snapshot) || !Object.hasOwn(value.snapshot, "panelPosition")) {
    return parseHydration(value);
  }
  const legacySnapshot = { ...value.snapshot };
  delete legacySnapshot.panelPosition;
  const legacyHydration = { ...value, snapshot: legacySnapshot };
  const parsed = parseHydration(legacyHydration);
  if (!parsed.ok) return parsed;
  if (parsed.value.reference === null) {
    return { ok: true, value: { snapshot: { ...snapshot.value, reference: null }, reference: null } };
  }
  return {
    ok: true,
    value: {
      snapshot: { ...snapshot.value, reference: parsed.value.reference.metadata },
      reference: parsed.value.reference,
    },
  };
}

/** Parses background-to-content messages whose snapshots may include a panel position. */
export function parseContentRequestWithPanelPosition(
  value: unknown,
): Result<ContentRequest, PublicError> {
  const standard = parseContentRequest(value);
  if (standard.ok) return standard;
  if (!isOwnDataRecord(value) || typeof value.kind !== "string") return standard;
  switch (value.kind) {
    case "hydrate-overlay": {
      const hydration = parseHydrationWithPanelPosition(value.hydration);
      return hasExactKeys(value, ["kind", "hydration"]) && hydration.ok
        ? { ok: true, value: { kind: "hydrate-overlay", hydration: hydration.value } }
        : failure("invalid-request");
    }
    case "apply-settings": {
      const snapshot = parseOverlaySnapshotWithPanelPosition(value.snapshot);
      return hasExactKeys(value, ["kind", "snapshot"]) && snapshot.ok
        ? { ok: true, value: { kind: "apply-settings", snapshot: snapshot.value } }
        : failure("invalid-request");
    }
    default:
      return standard;
  }
}

export function parseContentPanelRequest(value: unknown): Result<ContentPanelRequest, PublicError> {
  if (!isOwnDataRecord(value) || !hasExactKeys(value, ["kind", "requestId", "panelPosition"])) {
    return failure("invalid-request");
  }
  const panelPosition = parsePanelPosition(value.panelPosition);
  if (
    value.kind !== "update-panel-position" ||
    typeof value.requestId !== "string" ||
    value.requestId.length === 0 ||
    !panelPosition.ok
  ) {
    return failure("invalid-request");
  }
  return {
    ok: true,
    value: {
      kind: "update-panel-position",
      requestId: value.requestId,
      panelPosition: panelPosition.value,
    },
  };
}
