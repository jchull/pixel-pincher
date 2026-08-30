import { describe, expect, it } from "vitest";

import {
  AppError,
  DEFAULT_ORIGIN_SETTINGS,
  DEFAULT_SETTINGS,
  MAX_IMAGE_ENCODED_BYTES,
  MAX_IMAGE_PIXELS,
  MAX_IMAGE_RAW_BYTES,
  PUBLIC_ERROR_MESSAGES,
  publicError,
  toPublicError,
  type AccessError,
  type DeliveryError,
  type ImportError,
  type RenderError,
  type RepositoryError,
  type ValidationError,
} from "../../src/shared/contracts";

describe("shared contracts", () => {
  it("provides the documented defaults and limits", () => {
    expect(DEFAULT_SETTINGS).toEqual({
      visible: true,
      opacity: 0.5,
      inverted: false,
      placement: { x: 0, y: 0 },
      sizing: { kind: "scale", percent: 100 },
      interactionMode: "drag",
    });
    expect(DEFAULT_ORIGIN_SETTINGS).toEqual({
      visible: true,
      opacity: 0.5,
      inverted: false,
      sizing: { kind: "scale", percent: 100 },
      interactionMode: "drag",
    });
    expect(Object.isFrozen(DEFAULT_SETTINGS)).toBe(true);
    expect(Object.isFrozen(DEFAULT_SETTINGS.placement)).toBe(true);
    expect(Object.isFrozen(DEFAULT_ORIGIN_SETTINGS.sizing)).toBe(true);
    expect(MAX_IMAGE_RAW_BYTES).toBe(10 * 1024 * 1024);
    expect(MAX_IMAGE_ENCODED_BYTES).toBe(14 * 1024 * 1024);
    expect(MAX_IMAGE_PIXELS).toBe(40_000_000);
  });

  it("maps all stable public errors to user-safe messages", () => {
    const codes = [
      "unsupported-url",
      "site-access-denied",
      "site-access-revoked",
      "content-unavailable",
      "invalid-image-type",
      "image-too-large",
      "image-too-many-pixels",
      "image-decode-failed",
      "invalid-request",
      "invalid-stored-data",
      "storage-failed",
      "image-render-failed",
    ] satisfies readonly (keyof typeof PUBLIC_ERROR_MESSAGES)[];
    expect(codes).toHaveLength(12);
    for (const code of codes) {
      const error = publicError(code);
      expect(error.code).toBe(code);
      expect(error.message).toBe(PUBLIC_ERROR_MESSAGES[error.code]);
    }
  });

  it("assigns AppErrors to the documented error categories", () => {
    const errors = {
      validation: new AppError("invalid-request") satisfies ValidationError,
      repository: new AppError("storage-failed") satisfies RepositoryError,
      access: new AppError("site-access-denied") satisfies AccessError,
      accessUnavailable: new AppError(
        "content-unavailable",
      ) satisfies AccessError,
      delivery: new AppError("content-unavailable") satisfies DeliveryError,
      import: new AppError("image-too-large") satisfies ImportError,
      render: new AppError("image-render-failed") satisfies RenderError,
    };

    expect(Object.values(errors).map((error) => error.code)).toEqual([
      "invalid-request",
      "storage-failed",
      "site-access-denied",
      "content-unavailable",
      "content-unavailable",
      "image-too-large",
      "image-render-failed",
    ]);
  });

  it("strips internal causes from every AppError category", () => {
    const codes = [
      "unsupported-url",
      "site-access-denied",
      "site-access-revoked",
      "content-unavailable",
      "invalid-image-type",
      "image-too-large",
      "image-too-many-pixels",
      "image-decode-failed",
      "invalid-request",
      "invalid-stored-data",
      "storage-failed",
      "image-render-failed",
    ] satisfies readonly (keyof typeof PUBLIC_ERROR_MESSAGES)[];
    expect(codes).toHaveLength(12);
    for (const code of codes) {
      const internalCause = new Error(`internal ${code}`);
      const error = new AppError(code, { cause: internalCause });
      expect(toPublicError(error)).toEqual(publicError(code));
      expect(toPublicError(error)).not.toHaveProperty("cause");
    }
  });
});
