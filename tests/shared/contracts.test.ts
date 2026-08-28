import { describe, expect, it } from "vitest";

import {
  DEFAULT_SETTINGS,
  MAX_IMAGE_ENCODED_BYTES,
  MAX_IMAGE_PIXELS,
  PUBLIC_ERROR_MESSAGES,
  publicError,
} from "../../src/shared/contracts";

describe("shared contracts", () => {
  it("provides the documented defaults and limits", () => {
    expect(DEFAULT_SETTINGS).toEqual({
      visible: true,
      opacity: 0.5,
      inverted: false,
      placement: { x: 0, y: 0 },
      sizing: { kind: "fit-width", lastScalePercent: 100 },
      interactionMode: "click-through",
    });
    expect(MAX_IMAGE_ENCODED_BYTES).toBe(8 * 1024 * 1024);
    expect(MAX_IMAGE_PIXELS).toBe(40_000_000);
  });

  it("maps all stable public errors to user-safe messages", () => {
    const codes = [
      "unsupported-url", "site-access-denied", "site-access-revoked", "content-unavailable",
      "invalid-image-type", "image-too-large", "image-too-many-pixels", "image-decode-failed",
      "invalid-request", "invalid-stored-data", "storage-failed", "image-render-failed",
    ] satisfies readonly (keyof typeof PUBLIC_ERROR_MESSAGES)[];
    expect(codes).toHaveLength(12);
    for (const code of codes) {
      const error = publicError(code);
      expect(error.code).toBe(code);
      expect(error.message).toBe(PUBLIC_ERROR_MESSAGES[error.code]);
    }
  });
});
