declare const originBrand: unique symbol;
declare const pageKeyBrand: unique symbol;
declare const referenceIdBrand: unique symbol;

export type Origin = string & { readonly [originBrand]: "Origin" };
export type PageKey = string & { readonly [pageKeyBrand]: "PageKey" };
export type ReferenceId = string & { readonly [referenceIdBrand]: "ReferenceId" };

export type Result<T, E> =
  | Readonly<{ ok: true; value: T }>
  | Readonly<{ ok: false; error: E }>;

export type InteractionMode = "click-through" | "drag";
export type MimeType = "image/png" | "image/jpeg" | "image/webp" | "image/svg+xml";

export type Placement = Readonly<{ x: number; y: number }>;
/** Viewport-relative top-left position for the future in-page control panel. */
export type PanelPosition = Readonly<{ x: number; y: number }>;
export type Sizing =
  | Readonly<{ kind: "fit-width"; lastScalePercent: number }>
  | Readonly<{ kind: "scale"; percent: number }>;

export type OverlaySettings = Readonly<{
  visible: boolean;
  opacity: number;
  inverted: boolean;
  placement: Placement;
  sizing: Sizing;
  interactionMode: InteractionMode;
}>;

export type ReferenceMetadata = Readonly<{
  id: ReferenceId;
  name: string;
  mimeType: MimeType;
  width: number;
  height: number;
  encodedBytes: number;
  importedAt: number;
}>;

export type ImportedReference = Readonly<{
  metadata: ReferenceMetadata;
  dataUrl: string;
}>;

export type OverlaySnapshot = Readonly<{
  revision: number;
  origin: Origin;
  pageKey: PageKey;
  settings: OverlaySettings;
  reference: ReferenceMetadata | null;
  /** Absent until the in-page control panel has been positioned. */
  panelPosition?: PanelPosition;
}>;

export type SnapshotWithReference = OverlaySnapshot &
  Readonly<{ reference: ReferenceMetadata }>;

export type Hydration =
  | Readonly<{ snapshot: OverlaySnapshot & Readonly<{ reference: null }>; reference: null }>
  | Readonly<{ snapshot: SnapshotWithReference; reference: ImportedReference }>;

export type OriginRecordV1 = Readonly<{
  schemaVersion: 1;
  revision: number;
  origin: Origin;
  settings: Omit<OverlaySettings, "placement">;
  reference: ReferenceMetadata | null;
  /** Optional so stored schema-version-1 records created before panel support remain valid. */
  panelPosition?: PanelPosition;
}>;

export type PageRecordV1 = Readonly<{
  schemaVersion: 1;
  revision: number;
  origin: Origin;
  pageKey: PageKey;
  placement: Placement;
}>;

export type ImageRecordV1 = Readonly<{
  schemaVersion: 1;
  referenceId: ReferenceId;
  dataUrl: string;
}>;

export type OriginIndexV1 = Readonly<{
  schemaVersion: 1;
  origins: readonly Origin[];
}>;

export type SettingsPatch =
  | Readonly<{ kind: "visibility"; visible: boolean }>
  | Readonly<{ kind: "opacity"; opacity: number }>
  | Readonly<{ kind: "inversion"; inverted: boolean }>
  | Readonly<{ kind: "sizing"; sizing: Sizing }>
  | Readonly<{ kind: "interaction-mode"; interactionMode: InteractionMode }>
  | Readonly<{ kind: "placement"; placement: Placement }>;

export type ReplaceReferenceInput = Readonly<{
  url: URL;
  reference: ImportedReference;
}>;

export type UpdateSettingsInput = Readonly<{
  url: URL;
  patch: SettingsPatch;
}>;

export type UpdatePlacementInput = Readonly<{
  url: URL;
  placement: Placement;
}>;

export type UpdatePanelPositionInput = Readonly<{
  url: URL;
  panelPosition: PanelPosition;
}>;

/**
 * A top-frame in-page panel request. Its URL is deliberately omitted: the
 * coordinator derives it from the authenticated runtime sender instead.
 */
export type ContentPanelRequest =
  | Readonly<{ kind: "get-panel-state"; requestId: string }>
  | Readonly<{
      kind: "replace-reference";
      requestId: string;
      reference: ImportedReference;
    }>
  | Readonly<{ kind: "update-settings"; requestId: string; patch: SettingsPatch }>
  | Readonly<{ kind: "clear-site"; requestId: string }>
  | Readonly<{
      kind: "update-panel-position";
      requestId: string;
      panelPosition: PanelPosition;
    }>;

export type PopupRequest =
  | Readonly<{ kind: "get-tab-state"; requestId: string }>
  | Readonly<{ kind: "register-site"; requestId: string; url: string }>
  | Readonly<{ kind: "replace-reference"; requestId: string; url: string; reference: ImportedReference }>
  | Readonly<{ kind: "update-settings"; requestId: string; url: string; patch: SettingsPatch }>
  | Readonly<{ kind: "clear-site"; requestId: string; url: string }>;

export type RenderDiagnostic = Readonly<{
  referenceId: ReferenceId;
  error: PublicError;
}>;

export type TabState = Readonly<{
  tabId: number;
  url: string;
  origin: Origin;
  enabled: boolean;
  snapshot: OverlaySnapshot;
  diagnostic: RenderDiagnostic | null;
}>;

export type PopupResponse<T> =
  | Readonly<{ requestId: string; ok: true; value: T }>
  | Readonly<{ requestId: string; ok: false; error: PublicError }>;

/** Correlated response to a sender-bound content-panel request. */
export type ContentPanelResponse<T> = PopupResponse<T>;

export type ContentRequest =
  | Readonly<{ kind: "hydrate-overlay"; hydration: Hydration }>
  | Readonly<{ kind: "apply-settings"; snapshot: OverlaySnapshot }>
  | Readonly<{ kind: "clear-overlay"; revision: number }>;

export type ContentEvent =
  | Readonly<{ kind: "content-ready"; url: string }>
  | Readonly<{ kind: "placement-committed"; url: string; placement: Placement }>
  | Readonly<{ kind: "image-load-failed"; url: string; referenceId: ReferenceId }>;

export const PUBLIC_ERROR_MESSAGES = {
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
} as const;

export type PublicErrorCode = keyof typeof PUBLIC_ERROR_MESSAGES;
export type PublicError = Readonly<{ code: PublicErrorCode; message: string }>;

export class AppError<Code extends PublicErrorCode = PublicErrorCode> extends Error {
  readonly code: Code;

  constructor(code: Code, options?: Readonly<{ cause?: unknown }>) {
    super(PUBLIC_ERROR_MESSAGES[code], options);
    this.name = "AppError";
    this.code = code;
  }
}

type ErrorFor<Code extends PublicErrorCode> = AppError<Code>;

export type UnsupportedUrlError = ErrorFor<"unsupported-url">;
export type SiteAccessDeniedError = ErrorFor<"site-access-denied">;
export type SiteAccessRevokedError = ErrorFor<"site-access-revoked">;
export type ContentUnavailableError = ErrorFor<"content-unavailable">;
export type InvalidImageTypeError = ErrorFor<"invalid-image-type">;
export type ImageTooLargeError = ErrorFor<"image-too-large">;
export type ImageTooManyPixelsError = ErrorFor<"image-too-many-pixels">;
export type ImageDecodeFailedError = ErrorFor<"image-decode-failed">;
export type InvalidRequestError = ErrorFor<"invalid-request">;
export type InvalidStoredDataError = ErrorFor<"invalid-stored-data">;
export type StorageFailedError = ErrorFor<"storage-failed">;
export type ImageRenderFailedError = ErrorFor<"image-render-failed">;

export type ValidationError = ErrorFor<"unsupported-url" | "invalid-request">;
export type RepositoryError = ErrorFor<"invalid-stored-data" | "storage-failed">;
export type AccessError = ErrorFor<
  "site-access-denied" | "site-access-revoked" | "content-unavailable"
>;
export type DeliveryError = ErrorFor<"content-unavailable">;
export type ImportError = ErrorFor<
  | "invalid-image-type"
  | "image-too-large"
  | "image-too-many-pixels"
  | "image-decode-failed"
>;
export type RenderError = ErrorFor<"image-render-failed">;

export function publicError(code: PublicErrorCode): PublicError {
  return { code, message: PUBLIC_ERROR_MESSAGES[code] };
}

/** Convert an internal AppError to its stable, cause-free wire representation. */
export function toPublicError(error: AppError): PublicError {
  switch (error.code) {
    case "unsupported-url":
    case "site-access-denied":
    case "site-access-revoked":
    case "content-unavailable":
    case "invalid-image-type":
    case "image-too-large":
    case "image-too-many-pixels":
    case "image-decode-failed":
    case "invalid-request":
    case "invalid-stored-data":
    case "storage-failed":
    case "image-render-failed":
      return publicError(error.code);
    default: {
      const exhaustive: never = error.code;
      return exhaustive;
    }
  }
}

/** Maximum selected source file size; base64 storage needs additional space. */
export const MAX_IMAGE_RAW_BYTES = 10 * 1024 * 1024;
/** Maximum data-URL record size, sufficient for a 10 MiB source file plus its MIME prefix. */
export const MAX_IMAGE_ENCODED_BYTES = 14 * 1024 * 1024;
export const MAX_IMAGE_PIXELS = 40_000_000;
export const MIN_SCALE_PERCENT = 10;
export const MAX_SCALE_PERCENT = 400;
export const MIN_PLACEMENT = -1_000_000;
export const MAX_PLACEMENT = 1_000_000;
export const MIN_PANEL_POSITION = 0;
export const MAX_PANEL_POSITION = 1_000_000;

function deepFreeze<T extends object>(value: T): T {
  Object.freeze(value);
  for (const child of Object.values(value)) {
    if (typeof child === "object" && child !== null && !Object.isFrozen(child)) {
      deepFreeze(child);
    }
  }
  return value;
}

export const DEFAULT_ORIGIN_SETTINGS: OriginRecordV1["settings"] = deepFreeze({
  visible: true,
  opacity: 0.5,
  inverted: false,
  sizing: { kind: "fit-width", lastScalePercent: 100 },
  interactionMode: "click-through",
});

export const DEFAULT_SETTINGS: OverlaySettings = deepFreeze({
  ...DEFAULT_ORIGIN_SETTINGS,
  placement: { x: 0, y: 0 },
});
