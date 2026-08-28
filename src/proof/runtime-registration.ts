export const RUNTIME_PROOF_SCRIPT_ID = "pixel-pincher-runtime-proof";

// WXT emits `entrypoints/runtime-proof.content.ts` at this documented content-script path.
export const RUNTIME_PROOF_SCRIPT_PATH = "content-scripts/runtime-proof.js";

type RuntimeProofRegistration = Readonly<{
  allFrames: false;
  id: string;
  js: readonly string[];
  matches: readonly string[];
  persistAcrossSessions: true;
  runAt: "document_idle";
}>;

export type RuntimeProofRequest = Readonly<{
  kind: "register-runtime-proof";
  origin: string;
  tabId: number;
}>;

export function createRuntimeProofRegistration(
  origin: string,
): RuntimeProofRegistration {
  return {
    allFrames: false,
    id: RUNTIME_PROOF_SCRIPT_ID,
    js: [RUNTIME_PROOF_SCRIPT_PATH],
    matches: [origin],
    persistAcrossSessions: true,
    runAt: "document_idle",
  };
}

export function getExactOriginMatchPattern(url: string): string | undefined {
  let parsedUrl: URL;

  try {
    parsedUrl = new URL(url);
  } catch {
    return undefined;
  }

  if (parsedUrl.protocol !== "http:" && parsedUrl.protocol !== "https:") {
    return undefined;
  }

  return `${parsedUrl.origin}/*`;
}

export function isRuntimeProofRequest(value: unknown): value is RuntimeProofRequest {
  if (typeof value !== "object" || value === null) {
    return false;
  }

  const kind = Object.getOwnPropertyDescriptor(value, "kind")?.value;
  const origin = Object.getOwnPropertyDescriptor(value, "origin")?.value;
  const tabId = Object.getOwnPropertyDescriptor(value, "tabId")?.value;

  return (
    kind === "register-runtime-proof" &&
    typeof origin === "string" &&
    isExactOriginMatchPattern(origin) &&
    typeof tabId === "number" &&
    Number.isInteger(tabId) &&
    tabId >= 0
  );
}

function isExactOriginMatchPattern(value: string): boolean {
  if (!value.endsWith("/*")) {
    return false;
  }

  const origin = value.slice(0, -2);
  return getExactOriginMatchPattern(origin) === value;
}
