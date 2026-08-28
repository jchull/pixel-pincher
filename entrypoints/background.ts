import { defineBackground } from "wxt/utils/define-background";

import {
  createRuntimeProofRegistration,
  isRuntimeProofRequest,
  RUNTIME_PROOF_SCRIPT_ID,
} from "../src/proof/runtime-registration";

async function registerAndInjectRuntimeProof(request: {
  origin: string;
  tabId: number;
}): Promise<void> {
  const registration = createRuntimeProofRegistration(request.origin);
  const registeredScripts = await chrome.scripting.getRegisteredContentScripts();
  const existingScript = registeredScripts.find(
    (script) => script.id === RUNTIME_PROOF_SCRIPT_ID,
  );

  const scriptDefinition = {
    ...registration,
    js: [...registration.js],
    matches: [...registration.matches],
  };

  if (existingScript === undefined) {
    await chrome.scripting.registerContentScripts([scriptDefinition]);
  } else {
    await chrome.scripting.updateContentScripts([scriptDefinition]);
  }

  await chrome.scripting.executeScript({
    files: [...registration.js],
    target: { tabId: request.tabId },
  });
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "Unknown runtime proof error.";
}

export default defineBackground(() => {
  chrome.runtime.onMessage.addListener((message: unknown, _sender, sendResponse) => {
    if (!isRuntimeProofRequest(message)) {
      return undefined;
    }

    void registerAndInjectRuntimeProof(message)
      .then(() => {
        sendResponse({ ok: true });
      })
      .catch((error: unknown) => {
        sendResponse({ error: errorMessage(error), ok: false });
      });

    return true;
  });
});
