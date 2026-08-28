import {
  type ContentEvent,
  type ContentRequest,
  type Hydration,
  type ImageRecordV1,
  type ImportedReference,
  type InteractionMode,
  type MimeType,
  type Origin,
  type OriginIndexV1,
  type OriginRecordV1,
  type OverlaySettings,
  type OverlaySnapshot,
  type PageKey,
  type PageRecordV1,
  type Placement,
  type PopupRequest,
  type PublicError,
  type ReferenceId,
  type ReferenceMetadata,
  type Result,
  type SettingsPatch,
  type Sizing,
  MAX_IMAGE_ENCODED_BYTES,
  MAX_IMAGE_PIXELS,
  MAX_PLACEMENT,
  MAX_SCALE_PERCENT,
  MIN_PLACEMENT,
  MIN_SCALE_PERCENT,
  publicError,
} from "./contracts";

const MIME_TYPES = new Set<string>([
  "image/png",
  "image/jpeg",
  "image/webp",
  "image/svg+xml",
]);
const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const BASE64 = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;

type UnknownRecord = Record<string, unknown>;
type ParseErrorCode = "invalid-request" | "invalid-stored-data";

function failure<T>(code: ParseErrorCode): Result<T, PublicError> {
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

function readString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function readFiniteInteger(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && Number.isInteger(value)
    ? value
    : undefined;
}

function isMimeType(value: unknown): value is MimeType {
  return typeof value === "string" && MIME_TYPES.has(value);
}

function isInteractionMode(value: unknown): value is InteractionMode {
  return value === "click-through" || value === "drag";
}

function isSupportedUrl(url: URL): boolean {
  return url.protocol === "http:" || url.protocol === "https:";
}

function brandOrigin(value: string): Origin {
  return value as Origin;
}

function brandPageKey(value: string): PageKey {
  return value as PageKey;
}

function brandReferenceId(value: string): ReferenceId {
  return value as ReferenceId;
}

export function parseSupportedUrl(value: unknown): Result<URL, PublicError> {
  const raw = readString(value);
  if (raw === undefined) return { ok: false, error: publicError("unsupported-url") };
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return { ok: false, error: publicError("unsupported-url") };
  }
  if (!isSupportedUrl(url) || raw !== url.toString()) {
    return { ok: false, error: publicError("unsupported-url") };
  }
  return { ok: true, value: url };
}

export function parseOrigin(value: unknown): Result<Origin, PublicError> {
  const raw = readString(value);
  if (raw === undefined) return { ok: false, error: publicError("unsupported-url") };
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return { ok: false, error: publicError("unsupported-url") };
  }
  if (!isSupportedUrl(url) || raw !== url.origin) {
    return { ok: false, error: publicError("unsupported-url") };
  }
  return { ok: true, value: brandOrigin(raw) };
}

export function parsePageKey(value: unknown): Result<PageKey, PublicError> {
  const parsed = parseSupportedUrl(value);
  if (!parsed.ok || typeof value !== "string") {
    return { ok: false, error: publicError("unsupported-url") };
  }
  parsed.value.hash = "";
  if (value !== parsed.value.toString()) {
    return { ok: false, error: publicError("unsupported-url") };
  }
  return { ok: true, value: brandPageKey(value) };
}

export function parseReferenceId(value: unknown): Result<ReferenceId, PublicError> {
  const raw = readString(value);
  if (raw === undefined || !UUID_V4.test(raw)) return failure("invalid-request");
  return { ok: true, value: brandReferenceId(raw) };
}

function parsePlacementValue(value: unknown, code: ParseErrorCode): Result<Placement, PublicError> {
  if (!isOwnDataRecord(value) || !hasExactKeys(value, ["x", "y"])) return failure(code);
  const x = readFiniteInteger(value.x);
  const y = readFiniteInteger(value.y);
  if (
    x === undefined ||
    y === undefined ||
    x < MIN_PLACEMENT ||
    x > MAX_PLACEMENT ||
    y < MIN_PLACEMENT ||
    y > MAX_PLACEMENT
  ) {
    return failure(code);
  }
  return { ok: true, value: { x, y } };
}

export function parsePlacement(value: unknown): Result<Placement, PublicError> {
  return parsePlacementValue(value, "invalid-request");
}

function parseSizingValue(value: unknown, code: ParseErrorCode): Result<Sizing, PublicError> {
  if (!isOwnDataRecord(value) || typeof value.kind !== "string") return failure(code);
  if (value.kind === "fit-width") {
    if (!hasExactKeys(value, ["kind", "lastScalePercent"])) return failure(code);
    const lastScalePercent = readFiniteInteger(value.lastScalePercent);
    if (
      lastScalePercent === undefined ||
      lastScalePercent < MIN_SCALE_PERCENT ||
      lastScalePercent > MAX_SCALE_PERCENT
    ) return failure(code);
    return { ok: true, value: { kind: "fit-width", lastScalePercent } };
  }
  if (value.kind === "scale") {
    if (!hasExactKeys(value, ["kind", "percent"])) return failure(code);
    const percent = readFiniteInteger(value.percent);
    if (percent === undefined || percent < MIN_SCALE_PERCENT || percent > MAX_SCALE_PERCENT) {
      return failure(code);
    }
    return { ok: true, value: { kind: "scale", percent } };
  }
  return failure(code);
}

export function parseSizing(value: unknown): Result<Sizing, PublicError> {
  return parseSizingValue(value, "invalid-request");
}

function parseSettingsValue(value: unknown, code: ParseErrorCode): Result<OverlaySettings, PublicError> {
  if (!isOwnDataRecord(value) || !hasExactKeys(value, ["visible", "opacity", "inverted", "placement", "sizing", "interactionMode"])) {
    return failure(code);
  }
  const placement = parsePlacementValue(value.placement, code);
  const sizing = parseSizingValue(value.sizing, code);
  const interactionMode = value.interactionMode;
  if (
    typeof value.visible !== "boolean" ||
    typeof value.opacity !== "number" ||
    !Number.isFinite(value.opacity) ||
    value.opacity < 0 ||
    value.opacity > 1 ||
    typeof value.inverted !== "boolean" ||
    !isInteractionMode(interactionMode) ||
    !placement.ok ||
    !sizing.ok
  ) return failure(code);
  return {
    ok: true,
    value: {
      visible: value.visible,
      opacity: value.opacity,
      inverted: value.inverted,
      placement: placement.value,
      sizing: sizing.value,
      interactionMode,
    },
  };
}

export function parseOverlaySettings(value: unknown): Result<OverlaySettings, PublicError> {
  return parseSettingsValue(value, "invalid-request");
}

function parseMetadataValue(value: unknown, code: ParseErrorCode): Result<ReferenceMetadata, PublicError> {
  if (!isOwnDataRecord(value) || !hasExactKeys(value, ["id", "name", "mimeType", "width", "height", "encodedBytes", "importedAt"])) return failure(code);
  const id = parseReferenceId(value.id);
  const name = readString(value.name);
  const mimeType = value.mimeType;
  const width = readFiniteInteger(value.width);
  const height = readFiniteInteger(value.height);
  const encodedBytes = readFiniteInteger(value.encodedBytes);
  const importedAt = readFiniteInteger(value.importedAt);
  if (
    !id.ok ||
    name === undefined ||
    name.length === 0 ||
    !isMimeType(mimeType) ||
    width === undefined ||
    height === undefined ||
    width <= 0 ||
    height <= 0 ||
    width * height > MAX_IMAGE_PIXELS ||
    encodedBytes === undefined ||
    encodedBytes < 0 ||
    encodedBytes > MAX_IMAGE_ENCODED_BYTES ||
    importedAt === undefined ||
    importedAt < 0
  ) return failure(code);
  return { ok: true, value: { id: id.value, name, mimeType, width, height, encodedBytes, importedAt } };
}

export function parseReferenceMetadata(value: unknown): Result<ReferenceMetadata, PublicError> {
  return parseMetadataValue(value, "invalid-request");
}

function decodedBase64Bytes(payload: string): number | undefined {
  if (!BASE64.test(payload)) return undefined;
  const padding = payload.endsWith("==") ? 2 : payload.endsWith("=") ? 1 : 0;
  return (payload.length / 4) * 3 - padding;
}

function parseImportedReferenceValue(value: unknown, code: ParseErrorCode): Result<ImportedReference, PublicError> {
  if (!isOwnDataRecord(value) || !hasExactKeys(value, ["metadata", "dataUrl"])) return failure(code);
  const metadata = parseMetadataValue(value.metadata, code);
  const dataUrl = readString(value.dataUrl);
  if (!metadata.ok || dataUrl === undefined) return failure(code);
  const prefix = `data:${metadata.value.mimeType};base64,`;
  if (!dataUrl.startsWith(prefix)) return failure(code);
  const encodedBytes = decodedBase64Bytes(dataUrl.slice(prefix.length));
  if (encodedBytes === undefined || encodedBytes !== metadata.value.encodedBytes || encodedBytes > MAX_IMAGE_ENCODED_BYTES) return failure(code);
  return { ok: true, value: { metadata: metadata.value, dataUrl } };
}

export function parseImportedReference(value: unknown): Result<ImportedReference, PublicError> {
  return parseImportedReferenceValue(value, "invalid-request");
}

function parseSnapshotValue(value: unknown, code: ParseErrorCode): Result<OverlaySnapshot, PublicError> {
  if (!isOwnDataRecord(value) || !hasExactKeys(value, ["revision", "origin", "pageKey", "settings", "reference"])) return failure(code);
  const revision = readFiniteInteger(value.revision);
  const origin = parseOrigin(value.origin);
  const pageKey = parsePageKey(value.pageKey);
  const settings = parseSettingsValue(value.settings, code);
  const reference = value.reference === null ? { ok: true as const, value: null } : parseMetadataValue(value.reference, code);
  if (!origin.ok || !pageKey.ok || !settings.ok || !reference.ok || revision === undefined || revision < 0) return failure(code);
  if (!pageKey.value.startsWith(`${origin.value}/`)) return failure(code);
  return { ok: true, value: { revision, origin: origin.value, pageKey: pageKey.value, settings: settings.value, reference: reference.value } };
}

export function parseOverlaySnapshot(value: unknown): Result<OverlaySnapshot, PublicError> {
  return parseSnapshotValue(value, "invalid-request");
}

export function parseHydration(value: unknown): Result<Hydration, PublicError> {
  if (!isOwnDataRecord(value) || !hasExactKeys(value, ["snapshot", "reference"])) return failure("invalid-request");
  const snapshot = parseSnapshotValue(value.snapshot, "invalid-request");
  if (!snapshot.ok) return snapshot;
  if (snapshot.value.reference === null) {
    if (value.reference !== null) return failure("invalid-request");
    return { ok: true, value: { snapshot: { ...snapshot.value, reference: null }, reference: null } };
  }
  const reference = parseImportedReferenceValue(value.reference, "invalid-request");
  if (!reference.ok || reference.value.metadata.id !== snapshot.value.reference.id) return failure("invalid-request");
  return { ok: true, value: { snapshot: { ...snapshot.value, reference: snapshot.value.reference }, reference: reference.value } };
}

export function parseSettingsPatch(value: unknown): Result<SettingsPatch, PublicError> {
  if (!isOwnDataRecord(value) || typeof value.kind !== "string") return failure("invalid-request");
  switch (value.kind) {
    case "visibility":
      return hasExactKeys(value, ["kind", "visible"]) && typeof value.visible === "boolean"
        ? { ok: true, value: { kind: "visibility", visible: value.visible } }
        : failure("invalid-request");
    case "opacity":
      return hasExactKeys(value, ["kind", "opacity"]) && typeof value.opacity === "number" && Number.isFinite(value.opacity) && value.opacity >= 0 && value.opacity <= 1
        ? { ok: true, value: { kind: "opacity", opacity: value.opacity } }
        : failure("invalid-request");
    case "inversion":
      return hasExactKeys(value, ["kind", "inverted"]) && typeof value.inverted === "boolean"
        ? { ok: true, value: { kind: "inversion", inverted: value.inverted } }
        : failure("invalid-request");
    case "sizing": {
      const sizing = parseSizingValue(value.sizing, "invalid-request");
      return hasExactKeys(value, ["kind", "sizing"]) && sizing.ok ? { ok: true, value: { kind: "sizing", sizing: sizing.value } } : failure("invalid-request");
    }
    case "interaction-mode":
      return hasExactKeys(value, ["kind", "interactionMode"]) && (value.interactionMode === "click-through" || value.interactionMode === "drag")
        ? { ok: true, value: { kind: "interaction-mode", interactionMode: value.interactionMode } }
        : failure("invalid-request");
    case "placement": {
      const placement = parsePlacementValue(value.placement, "invalid-request");
      return hasExactKeys(value, ["kind", "placement"]) && placement.ok ? { ok: true, value: { kind: "placement", placement: placement.value } } : failure("invalid-request");
    }
    default:
      return failure("invalid-request");
  }
}

export function parsePopupRequest(value: unknown): Result<PopupRequest, PublicError> {
  if (!isOwnDataRecord(value) || typeof value.kind !== "string" || typeof value.requestId !== "string" || value.requestId.length === 0) return failure("invalid-request");
  const url = value.url === undefined ? undefined : parseSupportedUrl(value.url);
  switch (value.kind) {
    case "get-tab-state": return hasExactKeys(value, ["kind", "requestId"]) ? { ok: true, value: { kind: "get-tab-state", requestId: value.requestId } } : failure("invalid-request");
    case "register-site": return hasExactKeys(value, ["kind", "requestId", "url"]) && url?.ok ? { ok: true, value: { kind: "register-site", requestId: value.requestId, url: url.value.toString() } } : failure("invalid-request");
    case "clear-site": return hasExactKeys(value, ["kind", "requestId", "url"]) && url?.ok ? { ok: true, value: { kind: "clear-site", requestId: value.requestId, url: url.value.toString() } } : failure("invalid-request");
    case "replace-reference": {
      const reference = parseImportedReference(value.reference);
      return hasExactKeys(value, ["kind", "requestId", "url", "reference"]) && url?.ok && reference.ok ? { ok: true, value: { kind: "replace-reference", requestId: value.requestId, url: url.value.toString(), reference: reference.value } } : failure("invalid-request");
    }
    case "update-settings": {
      const patch = parseSettingsPatch(value.patch);
      return hasExactKeys(value, ["kind", "requestId", "url", "patch"]) && url?.ok && patch.ok ? { ok: true, value: { kind: "update-settings", requestId: value.requestId, url: url.value.toString(), patch: patch.value } } : failure("invalid-request");
    }
    default: return failure("invalid-request");
  }
}

export function parseContentRequest(value: unknown): Result<ContentRequest, PublicError> {
  if (!isOwnDataRecord(value) || typeof value.kind !== "string") return failure("invalid-request");
  switch (value.kind) {
    case "hydrate-overlay": { const hydration = parseHydration(value.hydration); return hasExactKeys(value, ["kind", "hydration"]) && hydration.ok ? { ok: true, value: { kind: "hydrate-overlay", hydration: hydration.value } } : failure("invalid-request"); }
    case "apply-settings": { const snapshot = parseOverlaySnapshot(value.snapshot); return hasExactKeys(value, ["kind", "snapshot"]) && snapshot.ok ? { ok: true, value: { kind: "apply-settings", snapshot: snapshot.value } } : failure("invalid-request"); }
    case "clear-overlay": { const revision = readFiniteInteger(value.revision); return hasExactKeys(value, ["kind", "revision"]) && revision !== undefined && revision >= 0 ? { ok: true, value: { kind: "clear-overlay", revision } } : failure("invalid-request"); }
    default: return failure("invalid-request");
  }
}

export function parseContentEvent(value: unknown): Result<ContentEvent, PublicError> {
  if (!isOwnDataRecord(value) || typeof value.kind !== "string") return failure("invalid-request");
  const url = value.url === undefined ? undefined : parseSupportedUrl(value.url);
  switch (value.kind) {
    case "content-ready": return hasExactKeys(value, ["kind", "url"]) && url?.ok ? { ok: true, value: { kind: "content-ready", url: url.value.toString() } } : failure("invalid-request");
    case "placement-committed": { const placement = parsePlacement(value.placement); return hasExactKeys(value, ["kind", "url", "placement"]) && url?.ok && placement.ok ? { ok: true, value: { kind: "placement-committed", url: url.value.toString(), placement: placement.value } } : failure("invalid-request"); }
    case "image-load-failed": { const referenceId = parseReferenceId(value.referenceId); return hasExactKeys(value, ["kind", "url", "referenceId"]) && url?.ok && referenceId.ok ? { ok: true, value: { kind: "image-load-failed", url: url.value.toString(), referenceId: referenceId.value } } : failure("invalid-request"); }
    default: return failure("invalid-request");
  }
}

export function parseOriginRecordV1(value: unknown): Result<OriginRecordV1, PublicError> {
  if (!isOwnDataRecord(value) || !hasExactKeys(value, ["schemaVersion", "revision", "origin", "settings", "reference"]) || value.schemaVersion !== 1) return failure("invalid-stored-data");
  const revision = readFiniteInteger(value.revision);
  const origin = parseOrigin(value.origin);
  if (!isOwnDataRecord(value.settings) || !hasExactKeys(value.settings, ["visible", "opacity", "inverted", "sizing", "interactionMode"])) return failure("invalid-stored-data");
  const settings = parseSettingsValue({ ...value.settings, placement: { x: 0, y: 0 } }, "invalid-stored-data");
  const reference = value.reference === null ? { ok: true as const, value: null } : parseMetadataValue(value.reference, "invalid-stored-data");
  if (revision === undefined || revision < 0 || !origin.ok || !settings.ok || !reference.ok) return failure("invalid-stored-data");
  const originSettings = {
    visible: settings.value.visible,
    opacity: settings.value.opacity,
    inverted: settings.value.inverted,
    sizing: settings.value.sizing,
    interactionMode: settings.value.interactionMode,
  };
  return { ok: true, value: { schemaVersion: 1, revision, origin: origin.value, settings: originSettings, reference: reference.value } };
}

export function parsePageRecordV1(value: unknown): Result<PageRecordV1, PublicError> {
  if (!isOwnDataRecord(value) || !hasExactKeys(value, ["schemaVersion", "revision", "origin", "pageKey", "placement"]) || value.schemaVersion !== 1) return failure("invalid-stored-data");
  const revision = readFiniteInteger(value.revision); const origin = parseOrigin(value.origin); const pageKey = parsePageKey(value.pageKey); const placement = parsePlacementValue(value.placement, "invalid-stored-data");
  if (revision === undefined || revision < 0 || !origin.ok || !pageKey.ok || !placement.ok || !pageKey.value.startsWith(`${origin.value}/`)) return failure("invalid-stored-data");
  return { ok: true, value: { schemaVersion: 1, revision, origin: origin.value, pageKey: pageKey.value, placement: placement.value } };
}

export function parseImageRecordV1(value: unknown): Result<ImageRecordV1, PublicError> {
  if (!isOwnDataRecord(value) || !hasExactKeys(value, ["schemaVersion", "referenceId", "dataUrl"]) || value.schemaVersion !== 1) return failure("invalid-stored-data");
  const referenceId = parseReferenceId(value.referenceId); const dataUrl = readString(value.dataUrl);
  if (!referenceId.ok || dataUrl === undefined || !dataUrl.startsWith("data:")) return failure("invalid-stored-data");
  return { ok: true, value: { schemaVersion: 1, referenceId: referenceId.value, dataUrl } };
}

export function parseOriginIndexV1(value: unknown): Result<OriginIndexV1, PublicError> {
  if (!isOwnDataRecord(value) || !hasExactKeys(value, ["schemaVersion", "origins"]) || value.schemaVersion !== 1 || !Array.isArray(value.origins)) return failure("invalid-stored-data");
  const origins: Origin[] = [];
  for (const originValue of value.origins) { const origin = parseOrigin(originValue); if (!origin.ok || origins.includes(origin.value)) return failure("invalid-stored-data"); origins.push(origin.value); }
  return { ok: true, value: { schemaVersion: 1, origins } };
}
