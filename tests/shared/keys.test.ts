import { describe, expect, it } from "vitest";

import {
  deriveOrigin,
  derivePageKey,
  imageRecordKey,
  isImageRecordKey,
  ORIGIN_INDEX_KEY,
  originRecordKey,
} from "../../src/shared/keys";
import { parseOrigin, parseReferenceId } from "../../src/shared/parse";

function parsed<T>(
  result: { readonly ok: true; readonly value: T } | { readonly ok: false },
): T {
  if (!result.ok) throw new Error("Expected valid fixture.");
  return result.value;
}

describe("storage keys", () => {
  it("derives canonical HTTP(S) origins and hashless delivery page keys from URLs", () => {
    const url = new URL("https://example.com/path?tab=one#section");
    expect(deriveOrigin(url)).toBe("https://example.com");
    expect(derivePageKey(url)).toBe("https://example.com/path?tab=one");
    expect(deriveOrigin(new URL("ftp://example.com/path"))).toBeUndefined();
    expect(derivePageKey(new URL("ftp://example.com/path"))).toBeUndefined();
  });

  it("uses stable keys only for origin metadata and image payloads", () => {
    const origin = parsed(parseOrigin("https://example.com:8443"));
    const referenceId = parsed(
      parseReferenceId("123e4567-e89b-42d3-a456-426614174000"),
    );

    expect(ORIGIN_INDEX_KEY).toBe("pixel-pincher:origins");
    expect(originRecordKey(origin)).toBe(
      "pixel-pincher:origin:https%3A%2F%2Fexample.com%3A8443",
    );
    expect(imageRecordKey(referenceId)).toBe(
      "pixel-pincher:image:123e4567-e89b-42d3-a456-426614174000",
    );
    expect(isImageRecordKey(imageRecordKey(referenceId))).toBe(true);
    expect(isImageRecordKey("pixel-pincher:origin:not-an-image")).toBe(false);
  });
});
