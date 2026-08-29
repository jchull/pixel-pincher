import { createImportReference } from "../../src/popup/import-reference";
import { PopupController, type PopupRuntimeAdapter, type PopupState, type PopupView } from "../../src/popup/popup-controller";
import { MAX_PLACEMENT, MIN_PLACEMENT, type TabState } from "../../src/shared/contracts";
import "./style.css";

function escapeHtml(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;").replaceAll("'", "&#039;");
}

function recovery(state: PopupState): Exclude<PopupState, { kind: "error" }> {
  return state.kind === "error" ? state.recovery : state;
}

export function controls(tab: TabState, confirmingClear: boolean): string {
  const reference = tab.snapshot.reference;
  const settings = tab.snapshot.settings;
  const disabled = reference === null ? " disabled" : "";
  const opacity = Math.round(settings.opacity * 100);
  const manualScale = settings.sizing.kind === "fit-width" ? settings.sizing.lastScalePercent : settings.sizing.percent;
  const diagnostic = tab.diagnostic === null ? "" : `<p class="diagnostic">${escapeHtml(tab.diagnostic.error.message)}</p>`;
  return `
    <section aria-labelledby="reference-heading">
      <h2 id="reference-heading">Reference</h2>
      <label for="reference-file">Choose image</label>
      <input id="reference-file" type="file" accept="image/png,image/jpeg,image/webp,image/svg+xml" />
      <button id="replace-reference" type="button" disabled>Replace reference</button>
      ${reference === null ? "<p>No reference selected.</p>" : `<p>${escapeHtml(reference.name)} (${reference.width} × ${reference.height})</p>`}
      ${diagnostic}
    </section>
    <fieldset${disabled}>
      <legend>Overlay controls</legend>
      <label><input id="visible" type="checkbox" ${settings.visible ? "checked" : ""} /> Show overlay</label>
      <label for="opacity">Transparency <output id="opacity-output">${opacity}%</output></label>
      <input id="opacity" type="range" min="0" max="100" value="${opacity}" />
      <label><input id="fit-width" type="checkbox" ${settings.sizing.kind === "fit-width" ? "checked" : ""} /> Fit to viewport width</label>
      <label for="scale">Scale percentage</label>
      <input id="scale" type="range" min="10" max="400" value="${manualScale}" ${settings.sizing.kind === "fit-width" ? "disabled" : ""} />
      <label for="scale-number">Manual scale percentage</label>
      <input id="scale-number" type="number" min="10" max="400" value="${manualScale}" ${settings.sizing.kind === "fit-width" ? "disabled" : ""} />
      <button id="reset-scale" type="button">Reset to 100%</button>
      <label><input id="inverted" type="checkbox" ${settings.inverted ? "checked" : ""} /> Invert colors</label>
      <fieldset><legend>Interaction</legend>
        <label><input id="interaction-click-through" name="interaction" value="click-through" type="radio" ${settings.interactionMode === "click-through" ? "checked" : ""} /> Click-through</label>
        <label><input id="interaction-drag" name="interaction" value="drag" type="radio" ${settings.interactionMode === "drag" ? "checked" : ""} /> Drag</label>
      </fieldset>
      <label for="x">X position</label><input id="x" type="number" min="${MIN_PLACEMENT}" max="${MAX_PLACEMENT}" value="${settings.placement.x}" step="1" />
      <label for="y">Y position</label><input id="y" type="number" min="${MIN_PLACEMENT}" max="${MAX_PLACEMENT}" value="${settings.placement.y}" step="1" />
    </fieldset>
    <section aria-labelledby="clear-heading"><h2 id="clear-heading">Site data</h2>
      ${confirmingClear ? '<p>Clear this site’s image and settings?</p><button id="confirm-clear" type="button">Confirm clear</button><button id="cancel-clear" type="button">Cancel</button>' : '<button id="clear-site" type="button">Clear site data</button>'}
    </section>`;
}

/** The only live region in the popup: status and error announcements go here. */
function statusRegion(state: PopupState): string {
  const message = state.kind === "error" ? `<span class="error">${escapeHtml(state.error.message)}</span>` : "";
  return `<div id="popup-status" role="status" aria-live="polite">${message}</div>`;
}

function markup(state: PopupState): string {
  const current = recovery(state);
  const status = statusRegion(state);
  if (current.kind === "loading") return `<h1>Pixel Pincher</h1>${status}<p>Loading…</p>`;
  if (current.kind === "unsupported") return `<h1>Pixel Pincher</h1>${status}<p>This page cannot use Pixel Pincher.</p>`;
  if (current.kind === "access-required") {
    const corruptDataClear = state.kind === "error" && state.error.code === "invalid-stored-data";
    return `<h1>Pixel Pincher</h1>${status}<p>Enable Pixel Pincher on this site to import and restore a reference.</p><button id="enable-site" type="button">Enable on this site</button>${corruptDataClear ? '<button id="clear-corrupt-site" type="button">Clear site data</button>' : ""}${state.kind === "error" ? '<button id="retry" type="button">Retry</button>' : ""}`;
  }
  // The in-page panel owns every enabled-site control. The popup remains only
  // for the user-gesture permission bootstrap until its legacy UI is removed.
  return `<h1>Pixel Pincher</h1>${status}<p>Pixel Pincher is enabled for this site. Use the in-page control panel to manage the reference and overlay.</p>${state.kind === "error" ? '<button id="retry" type="button">Retry</button>' : ""}`;
}

function input(root: HTMLElement, id: string): HTMLInputElement | undefined {
  const element = root.querySelector(`#${id}`);
  return element instanceof HTMLInputElement ? element : undefined;
}

let selectedFile: File | undefined;

function attach(root: HTMLElement, controller: PopupController): void {
  root.querySelector("#enable-site")?.addEventListener("click", () => { void controller.enable(); });
  root.querySelector("#retry")?.addEventListener("click", () => { void controller.retry(); });
  root.querySelector("#reference-file")?.addEventListener("change", (event) => {
    const target = event.currentTarget;
    if (target instanceof HTMLInputElement && target.files?.[0] !== undefined) {
      selectedFile = target.files[0];
      const replace = root.querySelector<HTMLButtonElement>("#replace-reference");
      if (replace !== null) replace.disabled = false;
    }
  });
  root.querySelector("#replace-reference")?.addEventListener("click", () => {
    if (selectedFile !== undefined) void controller.importFile(selectedFile, "replace-reference");
  });
  input(root, "visible")?.addEventListener("change", (event) => {
    const target = event.currentTarget;
    if (target instanceof HTMLInputElement) controller.updateSettings({ kind: "visibility", visible: target.checked }, "visible");
  });
  input(root, "opacity")?.addEventListener("input", (event) => {
    const target = event.currentTarget;
    if (target instanceof HTMLInputElement) controller.setOpacity(Number(target.value));
  });
  input(root, "fit-width")?.addEventListener("change", (event) => {
    const target = event.currentTarget;
    if (target instanceof HTMLInputElement) controller.setFitWidth(target.checked);
  });
  input(root, "scale")?.addEventListener("input", (event) => {
    const target = event.currentTarget;
    if (target instanceof HTMLInputElement) controller.setSizingPercent(Number(target.value));
  });
  input(root, "scale-number")?.addEventListener("blur", (event) => {
    const target = event.currentTarget;
    if (target instanceof HTMLInputElement) controller.commitNumber("scale", target.value, "scale-number");
  });
  root.querySelector("#reset-scale")?.addEventListener("click", () => controller.resetScale());
  input(root, "inverted")?.addEventListener("change", (event) => {
    const target = event.currentTarget;
    if (target instanceof HTMLInputElement) controller.updateSettings({ kind: "inversion", inverted: target.checked }, "inverted");
  });
  for (const button of root.querySelectorAll<HTMLInputElement>('input[name="interaction"]')) {
    button.addEventListener("change", () => controller.updateSettings({ kind: "interaction-mode", interactionMode: button.value === "drag" ? "drag" : "click-through" }, button.id));
  }
  const placementInputs: readonly ("x" | "y")[] = ["x", "y"];
  for (const kind of placementInputs) {
    const field = input(root, kind);
    field?.addEventListener("blur", () => controller.commitNumber(kind, field.value, kind));
    field?.addEventListener("keydown", (event) => handleNumberKey(event, controller, kind, field));
  }
  const scale = input(root, "scale-number");
  scale?.addEventListener("keydown", (event) => handleNumberKey(event, controller, "scale", scale));
  root.querySelector("#clear-site")?.addEventListener("click", () => controller.toggleClearConfirmation());
  root.querySelector("#cancel-clear")?.addEventListener("click", () => controller.toggleClearConfirmation());
  root.querySelector("#confirm-clear")?.addEventListener("click", () => { void controller.clearSite(); });
  root.querySelector("#clear-corrupt-site")?.addEventListener("click", () => { void controller.clearSite("clear-corrupt-site"); });
}

function handleNumberKey(event: KeyboardEvent, controller: PopupController, kind: "x" | "y" | "scale", field: HTMLInputElement): void {
  const direction = event.key === "ArrowUp" ? 1 : event.key === "ArrowDown" ? -1 : undefined;
  if (direction !== undefined) {
    event.preventDefault();
    controller.stepNumber(kind, direction, event.shiftKey, field.id);
  } else if (event.key === "Enter") controller.commitNumber(kind, field.value, field.id);
}

function createChromeAdapter(): PopupRuntimeAdapter {
  return {
    async getActiveUrl() {
      const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
      return tabs[0]?.url ?? null;
    },
    async requestOrigin(origin) { return chrome.permissions.request({ origins: [origin] }); },
    async send(request) { return chrome.runtime.sendMessage(request); },
  };
}

const importer = createImportReference({
  async readFile(file) {
    if (!(file instanceof File)) throw new Error("Expected a browser File.");
    return new Uint8Array(await file.arrayBuffer());
  },
  async decodeImage(bytes, mimeType) {
    const copy = new ArrayBuffer(bytes.byteLength);
    new Uint8Array(copy).set(bytes);
    const url = URL.createObjectURL(new Blob([copy], { type: mimeType }));
    try {
      const image = new Image();
      const loaded = await new Promise<HTMLImageElement>((resolve, reject) => {
        image.onload = () => resolve(image);
        image.onerror = () => reject(new Error("Image decoding failed."));
        image.src = url;
      });
      return { width: loaded.naturalWidth, height: loaded.naturalHeight };
    } finally { URL.revokeObjectURL(url); }
  },
  randomReferenceId() { return crypto.randomUUID(); },
  currentTimestamp() { return Date.now(); },
});

const root = document.querySelector<HTMLElement>("#popup-root");
if (root === null) throw new Error("Popup root is missing.");
const view: PopupView = {
  render(state) {
    if (state.kind === "error") selectedFile = undefined;
    root.toggleAttribute("aria-busy", recovery(state).kind === "loading");
    root.replaceChildren(document.createRange().createContextualFragment(markup(state)));
    attach(root, controller);
  },
  restoreFocus(controlId) { root.querySelector<HTMLElement>(`#${controlId}`)?.focus(); },
};
const controller = new PopupController({ adapter: createChromeAdapter(), view, importer });
void controller.start();
