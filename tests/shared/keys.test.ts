import { describe, expect, it } from "vitest";

import {
  deriveOrigin,
  derivePageKey,
  imageRecordKey,
  ORIGIN_INDEX_KEY,
  originRecordKey,
  pageRecordKey,
} from "../../src/shared/keys";
import { parseOrigin, parsePageKey, parseReferenceId } from "../../src/shared/parse";

function parsed<T>(result: { readonly ok: true; readonly value: T } | { readonly ok: false }): T {
  if (!result.ok) throw new Error("Expected valid fixture.");
  return result.value;
}

describe("storage keys", () => {
  it("derives canonical HTTP(S) origins and hashless page keys", () => {
    expect(parsed(deriveOrigin("https://example.com/path#section"))).toBe("https://example.com");
    expect(parsed(derivePageKey("https://example.com/path?tab=one#section"))).toBe("https://example.com/path?tab=one");
    expect(deriveOrigin("ftp://example.com/path").ok).toBe(false);
    expect(derivePageKey("https://example.com/path with spaces").ok).toBe(false);
  });

  it("uses stable prefixes and encodes every variable segment", () => {
    const origin = parsed(parseOrigin("https://example.com:8443"));
    const pageKey = parsed(parsePageKey("https://example.com:8443/path?q=a&x=b"));
    const referenceId = parsed(parseReferenceId("123e4567-e89b-42d3-a456-426614174000"));

    expect(ORIGIN_INDEX_KEY).toBe("pixel-pincher:origins");
    expect(originRecordKey(origin)).toBe("pixel-pincher:origin:https%3A%2F%2Fexample.com%3A8443");
    expect(pageRecordKey(pageKey)).toBe("pixel-pincher:page:https%3A%2F%2Fexample.com%3A8443%2Fpath%3Fq%3Da%26x%3Db");
    expect(imageRecordKey(referenceId)).toBe("pixel-pincher:image:123e4567-e89b-42d3-a456-426614174000");
  });
});
