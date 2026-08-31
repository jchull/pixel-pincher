import {
  publicError,
  type ContentPanelRequest,
  type ContentPanelResponse,
  type OverlaySnapshot,
  type PublicError,
  type Result,
} from "./contracts";
import {
  hasExactKeys,
  isOwnDataRecord,
  parseImportedReference,
  parseOverlaySnapshot,
  parsePanelPosition,
  parsePublicError,
  parseSettingsPatch,
} from "./parse";

function failure<T>(): Result<T, PublicError> {
  return { ok: false, error: publicError("invalid-request") };
}

/** Parses only the correlated requests allowed from a top-frame content panel. */
export function parseContentPanelRequest(
  value: unknown,
): Result<ContentPanelRequest, PublicError> {
  if (
    !isOwnDataRecord(value) ||
    typeof value.kind !== "string" ||
    typeof value.requestId !== "string" ||
    value.requestId.length === 0
  ) {
    return failure();
  }
  switch (value.kind) {
    case "get-panel-state":
    case "clear-site":
      return hasExactKeys(value, ["kind", "requestId"])
        ? { ok: true, value: { kind: value.kind, requestId: value.requestId } }
        : failure();
    case "replace-reference": {
      const reference = parseImportedReference(value.reference);
      return hasExactKeys(value, ["kind", "requestId", "reference"]) &&
        reference.ok
        ? {
            ok: true,
            value: {
              kind: "replace-reference",
              requestId: value.requestId,
              reference: reference.value,
            },
          }
        : failure();
    }
    case "update-settings": {
      const patch = parseSettingsPatch(value.patch);
      return hasExactKeys(value, ["kind", "requestId", "patch"]) && patch.ok
        ? {
            ok: true,
            value: {
              kind: "update-settings",
              requestId: value.requestId,
              patch: patch.value,
            },
          }
        : failure();
    }
    case "update-panel-position": {
      const panelPosition = parsePanelPosition(value.panelPosition);
      return hasExactKeys(value, ["kind", "requestId", "panelPosition"]) &&
        panelPosition.ok
        ? {
            ok: true,
            value: {
              kind: "update-panel-position",
              requestId: value.requestId,
              panelPosition: panelPosition.value,
            },
          }
        : failure();
    }
    default:
      return failure();
  }
}

/** Parses correlated in-page panel responses. */
export function parseContentPanelResponse(
  value: unknown,
): Result<ContentPanelResponse<OverlaySnapshot | undefined>, PublicError> {
  if (
    !isOwnDataRecord(value) ||
    typeof value.requestId !== "string" ||
    value.requestId.length === 0 ||
    typeof value.ok !== "boolean"
  ) {
    return failure();
  }
  if (!value.ok) {
    const error = parsePublicError(value.error);
    return hasExactKeys(value, ["requestId", "ok", "error"]) && error.ok
      ? {
          ok: true,
          value: { requestId: value.requestId, ok: false, error: error.value },
        }
      : failure();
  }
  if (!hasExactKeys(value, ["requestId", "ok", "value"])) return failure();
  if (value.value === undefined) {
    return {
      ok: true,
      value: { requestId: value.requestId, ok: true, value: undefined },
    };
  }
  const snapshot = parseOverlaySnapshot(value.value);
  return snapshot.ok
    ? {
        ok: true,
        value: { requestId: value.requestId, ok: true, value: snapshot.value },
      }
    : failure();
}
