import {
  getExactOriginMatchPattern,
  type RuntimeProofRequest,
} from "../proof/runtime-registration";

function requireElement<T extends Element>(selector: string, constructor: {
  new (): T;
}): T {
  const element = document.querySelector(selector);
  if (!(element instanceof constructor)) {
    throw new Error(`Required element is missing: ${selector}`);
  }

  return element;
}

const requestButton = requireElement("#run-runtime-proof", HTMLButtonElement);
const statusElement = requireElement("#runtime-proof-status", HTMLElement);

function setStatus(message: string): void {
  statusElement.textContent = message;
}

function getResponseError(response: unknown): string | undefined {
  if (typeof response !== "object" || response === null) {
    return "The background did not return a proof result.";
  }

  const ok = Object.getOwnPropertyDescriptor(response, "ok")?.value;
  const error = Object.getOwnPropertyDescriptor(response, "error")?.value;

  if (ok === true) {
    return undefined;
  }

  return typeof error === "string" ? error : "The background rejected the proof request.";
}

async function runRuntimeProof(): Promise<void> {
  requestButton.disabled = true;
  setStatus("Requesting access to the active tab origin…");

  try {
    const activeTabs = await chrome.tabs.query({ active: true, currentWindow: true });
    const activeTab = activeTabs[0];
    const origin = activeTab?.url ? getExactOriginMatchPattern(activeTab.url) : undefined;

    if (origin === undefined || activeTab?.id === undefined) {
      setStatus("Open an HTTP or HTTPS page before running this proof.");
      return;
    }

    const granted = await chrome.permissions.request({ origins: [origin] });
    if (!granted) {
      setStatus(`Access was not granted for ${origin}.`);
      return;
    }

    const request: RuntimeProofRequest = {
      kind: "register-runtime-proof",
      origin,
      tabId: activeTab.id,
    };
    const response: unknown = await chrome.runtime.sendMessage(request);
    const error = getResponseError(response);

    setStatus(
      error === undefined
        ? `Registered and injected the top-frame proof for ${origin}. Check the page badge.`
        : `Proof registration failed: ${error}`,
    );
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : "Unknown popup proof error.";
    setStatus(`Proof request failed: ${message}`);
  } finally {
    requestButton.disabled = false;
  }
}

requestButton.addEventListener("click", () => {
  void runRuntimeProof();
});
