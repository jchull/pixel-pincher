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

export type PopupRequest =
  | Readonly<{ kind: "get-tab-state"; requestId: string }>
  | Readonly<{ kind: "register-site"; requestId: string; url: string }>
  | Readonly<{ kind: "replace-reference"; requestId: string; url: string; reference: ImportedReference }>
  | Readonly<{ kind: "update-settings"; requestId: string; url: string; patch: SettingsPatch }>
  | Readonly<{ kind: "clear-site"; requestId: string; url: string }>;

export type PopupResponse<T> =
  | Readonly<{ requestId: string; ok: true; value: T }>
  | Readonly<{ requestId: string; ok: false; error: PublicError }>;

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
  "image-too-large": "The image is too large. Choose an image up to 8 MiB.",
  "image-too-many-pixels": "The image has too many pixels. Choose an image with at most 40 million pixels.",
  "image-decode-failed": "Pixel Pincher could not decode that image.",
  "invalid-request": "Pixel Pincher received an invalid request.",
  "invalid-stored-data": "Stored Pixel Pincher data is invalid. Clear this site's data and try again.",
  "storage-failed": "Pixel Pincher could not save this change.",
  "image-render-failed": "Pixel Pincher could not render the reference image.",
} as const;

export type PublicErrorCode = keyof typeof PUBLIC_ERROR_MESSAGES;
export type PublicError = Readonly<{ code: PublicErrorCode; message: string }>;

export function publicError(code: PublicErrorCode): PublicError {
  return { code, message: PUBLIC_ERROR_MESSAGES[code] };
}

export const MAX_IMAGE_ENCODED_BYTES = 8 * 1024 * 1024;
export const MAX_IMAGE_PIXELS = 40_000_000;
export const MIN_SCALE_PERCENT = 10;
export const MAX_SCALE_PERCENT = 400;
export const MIN_PLACEMENT = -1_000_000;
export const MAX_PLACEMENT = 1_000_000;

export const DEFAULT_SETTINGS: OverlaySettings = {
  visible: true,
  opacity: 0.5,
  inverted: false,
  placement: { x: 0, y: 0 },
  sizing: { kind: "fit-width", lastScalePercent: 100 },
  interactionMode: "click-through",
};
