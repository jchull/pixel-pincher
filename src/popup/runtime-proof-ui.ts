import {
  getExactOriginMatchPattern,
  isRuntimeProofRegistrationForOrigin,
  RUNTIME_PROOF_SCRIPT_ID,
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

let statusRevision = 0;

function setStatus(message: string): void {
  statusRevision += 1;
  statusElement.textContent = message;
}

type ActiveHttpTab = Readonly<{
  origin: string;
  tabId: number;
}>;

async function getActiveHttpTab(): Promise<ActiveHttpTab | undefined> {
  const activeTabs = await chrome.tabs.query({ active: true, currentWindow: true });
  const activeTab = activeTabs[0];
  const origin = activeTab?.url ? getExactOriginMatchPattern(activeTab.url) : undefined;

  if (origin === undefined || activeTab?.id === undefined) {
    return undefined;
  }

  return { origin, tabId: activeTab.id };
}

async function refreshRegistrationStatus(): Promise<void> {
  const revisionBeforeCheck = statusRevision;

  try {
    const activeTab = await getActiveHttpTab();
    if (activeTab === undefined) {
      if (statusRevision === revisionBeforeCheck) {
        setStatus("Open an HTTP or HTTPS page to inspect the runtime-proof registration.");
      }
      return;
    }

    const registrations = await chrome.scripting.getRegisteredContentScripts({
      ids: [RUNTIME_PROOF_SCRIPT_ID],
    });
    const hasMatchingRegistration = registrations.some((registration) =>
      isRuntimeProofRegistrationForOrigin(registration, activeTab.origin),
    );

    if (statusRevision !== revisionBeforeCheck) {
      return;
    }

    setStatus(
      hasMatchingRegistration
        ? `A runtime proof is registered for ${activeTab.origin}. Reload to run it, or run the proof to inject into this open tab.`
        : `No runtime proof is registered for ${activeTab.origin}.`,
    );
  } catch (error: unknown) {
    if (statusRevision !== revisionBeforeCheck) {
      return;
    }

    const message = error instanceof Error ? error.message : "Unknown registration-status error.";
    setStatus(`Could not inspect runtime-proof registration: ${message}`);
  }
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
    const activeTab = await getActiveHttpTab();

    if (activeTab === undefined) {
      setStatus("Open an HTTP or HTTPS page before running this proof.");
      return;
    }

    const granted = await chrome.permissions.request({ origins: [activeTab.origin] });
    if (!granted) {
      setStatus(`Access was not granted for ${activeTab.origin}.`);
      return;
    }

    const request: RuntimeProofRequest = {
      kind: "register-runtime-proof",
      origin: activeTab.origin,
      tabId: activeTab.tabId,
    };
    const response: unknown = await chrome.runtime.sendMessage(request);
    const error = getResponseError(response);

    setStatus(
      error === undefined
        ? `Registered and injected the top-frame proof for ${activeTab.origin}. Check the page badge.`
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

void refreshRegistrationStatus();
