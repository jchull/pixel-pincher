/// <reference types="chrome" />

import {
  PopupController,
  type PopupRuntimeAdapter,
  type PopupState,
  type PopupView,
} from "../../src/popup/popup-controller";
import "./style.css";

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function recovery(state: PopupState): Exclude<PopupState, { kind: "error" }> {
  return state.kind === "error" ? state.recovery : state;
}

/** The only live region in the popup: status and error announcements go here. */
function statusRegion(state: PopupState): string {
  const message =
    state.kind === "error"
      ? `<span class="error">${escapeHtml(state.error.message)}</span>`
      : "";
  return `<div id="popup-status" role="status" aria-live="polite">${message}</div>`;
}

function markup(state: PopupState): string {
  const current = recovery(state);
  const status = statusRegion(state);
  if (current.kind === "loading")
    return `<h1>Pixel Pincher</h1>${status}<p>Loading…</p>`;
  if (current.kind === "unsupported")
    return `<h1>Pixel Pincher</h1>${status}<p>This page cannot use Pixel Pincher.</p>`;
  if (current.kind === "access-required") {
    const corruptDataClear =
      state.kind === "error" && state.error.code === "invalid-stored-data";
    return `<h1>Pixel Pincher</h1>${status}<p>Enable Pixel Pincher on this site to use the in-page controls.</p><button id="enable-site" type="button">Enable on this site</button>${corruptDataClear ? '<button id="clear-corrupt-site" type="button">Clear site data</button>' : ""}${state.kind === "error" ? '<button id="retry" type="button">Retry</button>' : ""}`;
  }
  return `<h1>Pixel Pincher</h1>${status}<p>Use the in-page control panel to manage the reference and overlay.</p><button id="toggle-panel" type="button">Hide in-page controls</button>${state.kind === "error" ? '<button id="retry" type="button">Retry</button>' : ""}`;
}

async function panelIsVisible(): Promise<boolean> {
  const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
  const tabId = tabs[0]?.id;
  if (tabId === undefined) return false;
  const result = await chrome.scripting.executeScript({
    target: { frameIds: [0], tabId },
    func: () =>
      document.getElementById("pixel-pincher-control-panel")?.style.display !==
      "none",
  });
  return result[0]?.result === true;
}

function attach(root: HTMLElement, controller: PopupController): void {
  root.querySelector("#enable-site")?.addEventListener("click", () => {
    void controller.enable();
  });
  root.querySelector("#retry")?.addEventListener("click", () => {
    void controller.retry();
  });
  root.querySelector("#clear-corrupt-site")?.addEventListener("click", () => {
    void controller.clearCorruptSite();
  });
  const togglePanel = root.querySelector<HTMLButtonElement>("#toggle-panel");
  if (togglePanel === null) return;
  void panelIsVisible().then((visible) => {
    togglePanel.textContent = visible
      ? "Hide in-page controls"
      : "Show in-page controls";
  });
  togglePanel.addEventListener("click", async () => {
    const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
    const tabId = tabs[0]?.id;
    if (tabId === undefined) return;
    const result = await chrome.scripting.executeScript({
      target: { frameIds: [0], tabId },
      func: () => {
        const panel = document.getElementById("pixel-pincher-control-panel");
        if (panel === null) return false;
        const visible = panel.style.display === "none";
        panel.style.display = visible ? "block" : "none";
        panel.setAttribute("aria-hidden", String(!visible));
        return visible;
      },
    });
    const visible = result[0]?.result;
    if (typeof visible === "boolean")
      togglePanel.textContent = visible
        ? "Hide in-page controls"
        : "Show in-page controls";
  });
}

function createChromeAdapter(): PopupRuntimeAdapter {
  return {
    async getActiveUrl() {
      const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
      return tabs[0]?.url ?? null;
    },
    async requestOrigin(origin) {
      return chrome.permissions.request({ origins: [origin] });
    },
    async send(request) {
      return chrome.runtime.sendMessage(request);
    },
  };
}

const root = document.querySelector<HTMLElement>("#popup-root");
if (root === null) throw new Error("Popup root is missing.");
const view: PopupView = {
  render(state) {
    root.toggleAttribute("aria-busy", recovery(state).kind === "loading");
    root.replaceChildren(
      document.createRange().createContextualFragment(markup(state)),
    );
    attach(root, controller);
  },
  restoreFocus(controlId) {
    root.querySelector<HTMLElement>(`#${controlId}`)?.focus();
  },
};
const controller = new PopupController({ adapter: createChromeAdapter(), view });
void controller.start();
