import { describe, expect, it } from "vitest";

import {
  createRuntimeProofRegistration,
  getExactOriginMatchPattern,
  isRuntimeProofRequest,
  RUNTIME_PROOF_SCRIPT_ID,
  RUNTIME_PROOF_SCRIPT_PATH,
} from "../src/proof/runtime-registration";

describe("runtime proof registration", () => {
  it("derives one exact HTTP(S) origin match pattern", () => {
    expect(getExactOriginMatchPattern("https://example.com/path?x=1#fragment")).toBe(
      "https://example.com/*",
    );
    expect(getExactOriginMatchPattern("http://localhost:8080/fixture")).toBe(
      "http://localhost:8080/*",
    );
    expect(getExactOriginMatchPattern("file:///tmp/fixture.html")).toBeUndefined();
    expect(getExactOriginMatchPattern("not a URL")).toBeUndefined();
  });

  it("creates a top-frame registration that persists across browser sessions", () => {
    expect(createRuntimeProofRegistration("https://example.com/*")).toEqual({
      allFrames: false,
      id: RUNTIME_PROOF_SCRIPT_ID,
      js: [RUNTIME_PROOF_SCRIPT_PATH],
      matches: ["https://example.com/*"],
      persistAcrossSessions: true,
      runAt: "document_idle",
    });
  });

  it("accepts only valid runtime-proof message boundaries", () => {
    expect(
      isRuntimeProofRequest({
        kind: "register-runtime-proof",
        origin: "https://example.com/*",
        tabId: 7,
      }),
    ).toBe(true);
    expect(
      isRuntimeProofRequest({
        kind: "register-runtime-proof",
        origin: "https://other.example/*",
        tabId: 7,
      }),
    ).toBe(true);
    expect(
      isRuntimeProofRequest({
        kind: "register-runtime-proof",
        origin: "https://example.com/path/*",
        tabId: 7,
      }),
    ).toBe(false);
    expect(
      isRuntimeProofRequest({
        kind: "register-runtime-proof",
        origin: "https://example.com/*",
        tabId: -1,
      }),
    ).toBe(false);
    expect(isRuntimeProofRequest(null)).toBe(false);
  });
});
