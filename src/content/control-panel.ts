import controlPanelStyles from "./control-panel.css?inline";

import {
  createImportReference,
  type ImportDependencies,
} from "../popup/import-reference";
import {
  MAX_PLACEMENT,
  MAX_SCALE_PERCENT,
  MIN_PLACEMENT,
  MIN_SCALE_PERCENT,
  type ContentPanelRequest,
  type Hydration,
  type ImportedReference,
  type OverlaySnapshot,
  type PanelPosition,
  type PublicError,
  type SettingsPatch,
  type Sizing,
} from "../shared/contracts";
import { parseContentPanelResponse } from "../shared/panel-position";

const HOST_ID = "pixel-pincher-control-panel";
const DEFAULT_POSITION: PanelPosition = { x: 24, y: 24 };
const MIN_REACHABLE_WIDTH = 48;
const MIN_REACHABLE_HEIGHT = 40;
const roots = new WeakMap<HTMLElement, ShadowRoot>();

type PanelRequest =
  | Readonly<{ kind: "get-panel-state" }>
  | Readonly<{ kind: "replace-reference"; reference: ImportedReference }>
  | Readonly<{ kind: "update-settings"; patch: SettingsPatch }>
  | Readonly<{ kind: "clear-site" }>
  | Readonly<{ kind: "update-panel-position"; panelPosition: PanelPosition }>;
type Importer = (
  file: File,
) => Promise<
  | Readonly<{ ok: true; value: ImportedReference }>
  | Readonly<{ ok: false; error: PublicError }>
>;

export type ControlPanelOptions = Readonly<{
  window: Window;
  document: Document;
  /** Retained for position-only consumers and tests. */
  onPositionCommitted?: (position: PanelPosition) => void;
  /** Runtime requests are sender-bound by the background coordinator. */
  request?: (request: ContentPanelRequest) => Promise<unknown>;
  importReference?: Importer;
}>;

type DragState = Readonly<{
  pointerId: number;
  clientX: number;
  clientY: number;
  position: PanelPosition;
}>;
type PendingSetting = Readonly<{ patch: SettingsPatch; coalesce: boolean }>;

type PanelElements = Readonly<{
  handle: HTMLButtonElement;
  collapse: HTMLButtonElement;
  live: HTMLElement;
  file: HTMLInputElement;
  fileDropTarget: HTMLButtonElement;
  hide: HTMLInputElement;
  opacity: HTMLInputElement;
  opacityNumber: HTMLInputElement;
  fitWidth: HTMLInputElement;
  scale: HTMLInputElement;
  scaleNumber: HTMLInputElement;
  inverted: HTMLInputElement;
  lock: HTMLInputElement;
  x: HTMLInputElement;
  y: HTMLInputElement;
  clear: HTMLButtonElement;
  confirm: HTMLElement;
}>;

export class ControlPanel {
  readonly #window: Window;
  readonly #onPositionCommitted: ControlPanelOptions["onPositionCommitted"];
  readonly #request: ControlPanelOptions["request"];
  readonly #importReference: Importer | undefined;
  readonly #host: HTMLElement;
  readonly #elements: PanelElements;
  #snapshot: OverlaySnapshot | undefined;
  #revision = -1;
  #position: PanelPosition = DEFAULT_POSITION;
  #dragState: DragState | undefined;
  #destroyed = false;
  #nextRequestId = 1;
  #settingsInFlight = false;
  #pendingSettings: PendingSetting[] = [];
  #confirmingClear = false;
  #collapsed = false;

  constructor(options: ControlPanelOptions) {
    this.#window = options.window;
    this.#onPositionCommitted = options.onPositionCommitted;
    this.#request = options.request;
    this.#importReference = options.importReference;
    this.#host = findOrCreateHost(options.document);
    this.#elements = findOrCreatePanel(rootFor(this.#host), options.document);
    const e = this.#elements;
    e.handle.addEventListener("pointerdown", this.#handlePointerDown);
    e.handle.addEventListener("pointermove", this.#handlePointerMove);
    e.handle.addEventListener("pointerup", this.#handlePointerUp);
    e.handle.addEventListener("pointercancel", this.#handlePointerCancel);
    e.handle.addEventListener(
      "lostpointercapture",
      this.#handleLostPointerCapture,
    );
    e.handle.addEventListener("dragstart", preventDefault);
    e.collapse.addEventListener("click", this.#toggleCollapsed);
    e.file.addEventListener("change", this.#handleFile);
    e.fileDropTarget.addEventListener("click", this.#openFilePicker);
    e.fileDropTarget.addEventListener("dragenter", this.#handleDragEnter);
    e.fileDropTarget.addEventListener("dragover", this.#handleDragOver);
    e.fileDropTarget.addEventListener("dragleave", this.#handleDragLeave);
    e.fileDropTarget.addEventListener("drop", this.#handleDrop);
    e.fileDropTarget.addEventListener("paste", this.#handlePaste);
    e.hide.addEventListener("change", this.#handleVisibility);
    e.opacity.addEventListener("input", this.#handleOpacity);
    e.opacityNumber.addEventListener("input", this.#handleOpacityNumber);
    e.opacityNumber.addEventListener("keydown", this.#handleNumberKey);
    e.fitWidth.addEventListener("change", this.#handleFitWidth);
    e.scale.addEventListener("input", this.#handleScale);
    e.scaleNumber.addEventListener("input", this.#handleScaleNumber);
    e.scaleNumber.addEventListener("keydown", this.#handleNumberKey);
    e.inverted.addEventListener("change", this.#handleInversion);
    e.lock.addEventListener("change", this.#handleInteraction);
    e.x.addEventListener("blur", this.#handlePlacement);
    e.y.addEventListener("blur", this.#handlePlacement);
    e.x.addEventListener("keydown", this.#handleNumberKey);
    e.y.addEventListener("keydown", this.#handleNumberKey);
    e.clear.addEventListener("click", this.#toggleClear);
    this.#window.addEventListener("resize", this.#handleResize);
    this.#window.addEventListener("keydown", this.#handleKeyDown);
    this.#host.style.display = "none";
  }

  hydrate(hydration: Hydration): void {
    this.apply(hydration.snapshot);
  }

  apply(snapshot: OverlaySnapshot): void {
    if (this.#destroyed || snapshot.revision < this.#revision) return;
    this.#revision = snapshot.revision;
    this.#cancelDrag();
    this.#snapshot = snapshot;
    this.#position = this.#clamp(snapshot.panelPosition ?? this.#position);
    this.#render();
  }

  clear(revision: number): void {
    if (this.#destroyed || revision < this.#revision) return;
    this.#revision = revision;
    this.#cancelDrag();
    this.#snapshot = undefined;
    this.#host.style.display = "none";
  }

  destroy(): void {
    if (this.#destroyed) return;
    this.#destroyed = true;
    this.#cancelDrag();
    this.#host.remove();
  }

  #render(): void {
    const snapshot = this.#snapshot;
    if (snapshot === undefined) return;
    const e = this.#elements;
    this.#host.style.display = "block";
    this.#host.style.left = `${this.#position.x}px`;
    this.#host.style.top = `${this.#position.y}px`;
    const settings = snapshot.settings;
    const disabled = snapshot.reference === null;
    const panel = this.#elements.collapse.parentElement?.parentElement;
    panel?.classList.toggle("collapsed", this.#collapsed);
    e.collapse.setAttribute("aria-expanded", String(!this.#collapsed));
    e.collapse.setAttribute(
      "aria-label",
      this.#collapsed ? "Expand control panel" : "Collapse control panel",
    );
    e.collapse.textContent = this.#collapsed ? "▸" : "▾";
    e.file.disabled = false;
    e.hide.checked = !settings.visible;
    e.opacity.value = String(Math.round(settings.opacity * 100));
    e.opacityNumber.value = e.opacity.value;
    e.fitWidth.checked = settings.sizing.kind === "fit-width";
    const scale = manualScale(settings.sizing);
    e.scale.value = String(scale);
    e.scaleNumber.value = String(scale);
    e.scale.disabled = disabled || settings.sizing.kind === "fit-width";
    e.scaleNumber.disabled = disabled || settings.sizing.kind === "fit-width";
    e.inverted.checked = settings.inverted;
    e.lock.checked = settings.interactionMode === "click-through";
    e.x.value = String(settings.placement.x);
    e.y.value = String(settings.placement.y);
    for (const control of [
      e.hide,
      e.opacity,
      e.opacityNumber,
      e.fitWidth,
      e.inverted,
      e.lock,
      e.x,
      e.y,
    ])
      control.disabled = disabled;
    e.clear.disabled = disabled;
    e.confirm.hidden = !this.#confirmingClear;
    e.clear.textContent = this.#confirmingClear
      ? "Confirm clear site data"
      : "Clear site data";
  }

  #toggleCollapsed = (): void => {
    this.#collapsed = !this.#collapsed;
    this.#render();
  };
  #openFilePicker = (): void => this.#elements.file.click();
  #handleFile = (): void => this.#importFirstFile(this.#elements.file.files);
  #handleDragEnter = (event: DragEvent): void => {
    event.preventDefault();
    this.#elements.fileDropTarget.classList.add("dragging");
  };
  #handleDragOver = (event: DragEvent): void => event.preventDefault();
  #handleDragLeave = (): void =>
    this.#elements.fileDropTarget.classList.remove("dragging");
  #handleDrop = (event: DragEvent): void => {
    event.preventDefault();
    this.#elements.fileDropTarget.classList.remove("dragging");
    this.#importFirstFile(event.dataTransfer?.files ?? null);
  };
  #handlePaste = (event: ClipboardEvent): void => {
    const files = event.clipboardData?.files ?? null;
    if (files === null || files.length === 0) return;
    event.preventDefault();
    this.#importFirstFile(files);
  };
  #importFirstFile(files: FileList | null): void {
    const file = files?.[0];
    if (file !== undefined && this.#importReference !== undefined)
      void this.#importFile(file);
  }

  async #importFile(file: File): Promise<void> {
    try {
      const imported = await this.#importReference?.(file);
      if (imported === undefined) return;
      if (!imported.ok) {
        console.error("[Pixel Pincher] Reference import failed.", {
          code: imported.error.code,
          fileName: file.name,
          fileSize: file.size,
          fileType: file.type,
        });
        this.#showError({
          ...imported.error,
          message: `${imported.error.message} See the page console for details.`,
        });
        return;
      }
      await this.#send({
        kind: "replace-reference",
        reference: imported.value,
      });
    } catch (error) {
      console.error("[Pixel Pincher] Reference import threw unexpectedly.", {
        error,
        fileName: file.name,
        fileSize: file.size,
        fileType: file.type,
      });
      this.#showError({
        code: "image-decode-failed",
        message:
          "Pixel Pincher could not decode that image. See the page console for details.",
      });
    }
  }

  #handleVisibility = (): void =>
    this.#queueSetting({
      kind: "visibility",
      visible: !this.#elements.hide.checked,
    });
  #handleOpacity = (): void => {
    const percent = clampPercent(Number(this.#elements.opacity.value));
    this.#elements.opacityNumber.value = String(percent);
    this.#queueSetting({ kind: "opacity", opacity: percent / 100 }, true);
  };
  #handleOpacityNumber = (): void => {
    const percent = Number(this.#elements.opacityNumber.value);
    if (!Number.isSafeInteger(percent) || percent < 0 || percent > 100) return;
    this.#elements.opacity.value = String(percent);
    this.#queueSetting({ kind: "opacity", opacity: percent / 100 }, true);
  };
  #handleFitWidth = (): void => {
    const sizing = this.#snapshot?.settings.sizing;
    if (sizing === undefined) return;
    const current = manualScale(sizing);
    this.#queueSetting(
      {
        kind: "sizing",
        sizing: this.#elements.fitWidth.checked
          ? { kind: "fit-width", lastScalePercent: current }
          : { kind: "scale", percent: current },
      },
      true,
    );
  };
  #handleScale = (): void => {
    const percent = clampScale(Number(this.#elements.scale.value));
    this.#elements.scaleNumber.value = String(percent);
    this.#queueSetting(
      { kind: "sizing", sizing: { kind: "scale", percent } },
      true,
    );
  };
  #handleScaleNumber = (): void => {
    const percent = Number(this.#elements.scaleNumber.value);
    if (
      !Number.isSafeInteger(percent) ||
      percent < MIN_SCALE_PERCENT ||
      percent > MAX_SCALE_PERCENT
    )
      return;
    this.#elements.scale.value = String(percent);
    this.#queueSetting(
      { kind: "sizing", sizing: { kind: "scale", percent } },
      true,
    );
  };
  #handleInversion = (): void =>
    this.#queueSetting({
      kind: "inversion",
      inverted: this.#elements.inverted.checked,
    });
  #handleInteraction = (): void =>
    this.#queueSetting({
      kind: "interaction-mode",
      interactionMode: this.#elements.lock.checked ? "click-through" : "drag",
    });
  #handlePlacement = (event: Event): void => {
    const input = event.currentTarget;
    if (input instanceof HTMLInputElement) this.#commitNumber(input);
  };
  #handleNumberKey = (event: KeyboardEvent): void => {
    const input = event.currentTarget;
    if (!(input instanceof HTMLInputElement)) return;
    if (event.key === "Enter") {
      this.#commitNumber(input);
      return;
    }
    const direction =
      event.key === "ArrowUp" ? 1 : event.key === "ArrowDown" ? -1 : 0;
    if (direction === 0) return;
    event.preventDefault();
    const step = event.shiftKey ? 10 : 1;
    const value = Number(input.value) + direction * step;
    input.value = String(value);
    this.#commitNumber(input);
  };

  #commitNumber(input: HTMLInputElement): void {
    if (!/^-?\d+$/.test(input.value.trim())) {
      this.#render();
      return;
    }
    const value = Number(input.value);
    if (!Number.isSafeInteger(value)) {
      this.#render();
      return;
    }
    if (input === this.#elements.opacityNumber) {
      const percent = clampPercent(value);
      this.#elements.opacity.value = String(percent);
      this.#elements.opacityNumber.value = String(percent);
      this.#queueSetting({ kind: "opacity", opacity: percent / 100 }, true);
      return;
    }
    if (input === this.#elements.scaleNumber) {
      const percent = clampScale(value);
      this.#elements.scale.value = String(percent);
      this.#elements.scaleNumber.value = String(percent);
      this.#queueSetting(
        { kind: "sizing", sizing: { kind: "scale", percent } },
        true,
      );
      return;
    }
    const snapshot = this.#snapshot;
    if (snapshot === undefined) return;
    const placement = {
      ...snapshot.settings.placement,
      [input === this.#elements.x ? "x" : "y"]: clampPlacement(value),
    };
    this.#queueSetting({ kind: "placement", placement });
  }

  #toggleClear = (): void => {
    if (!this.#confirmingClear) {
      this.#confirmingClear = true;
      this.#elements.confirm.hidden = false;
      this.#elements.clear.textContent = "Confirm clear site data";
      return;
    }
    this.#confirmingClear = false;
    this.#elements.confirm.hidden = true;
    this.#elements.clear.textContent = "Clear site data";
    void this.#send({ kind: "clear-site" });
  };

  #queueSetting(patch: SettingsPatch, coalesce = false): void {
    if (this.#snapshot?.reference === null || this.#request === undefined)
      return;
    const pending = { patch, coalesce };
    if (this.#settingsInFlight) {
      const existing = coalesce
        ? this.#pendingSettings.findIndex(
            (item) => item.coalesce && item.patch.kind === patch.kind,
          )
        : -1;
      if (existing === -1) this.#pendingSettings.push(pending);
      else this.#pendingSettings[existing] = pending;
      return;
    }
    void this.#dispatchSetting(pending);
  }

  async #dispatchSetting(pending: PendingSetting): Promise<void> {
    this.#settingsInFlight = true;
    await this.#send({ kind: "update-settings", patch: pending.patch });
    this.#settingsInFlight = false;
    const next = this.#pendingSettings.shift();
    if (next !== undefined) void this.#dispatchSetting(next);
  }

  async #send(request: PanelRequest): Promise<void> {
    if (this.#request === undefined) {
      if (request.kind === "update-panel-position")
        this.#onPositionCommitted?.(request.panelPosition);
      return;
    }
    const requestId = `panel-${this.#nextRequestId++}`;
    try {
      const parsed = parseContentPanelResponse(
        await this.#request({ ...request, requestId }),
      );
      if (!parsed.ok || parsed.value.requestId !== requestId) {
        this.#showError({
          code: "invalid-request",
          message: "Pixel Pincher received an invalid request.",
        });
        return;
      }
      if (!parsed.value.ok) {
        this.#showError(parsed.value.error);
        return;
      }
      if (parsed.value.value !== undefined) this.apply(parsed.value.value);
    } catch {
      this.#showError({
        code: "content-unavailable",
        message:
          "The page overlay is unavailable. Reload the page and try again.",
      });
    }
  }

  #showError(error: PublicError): void {
    this.#elements.live.textContent = error.message;
  }
  #handlePointerDown = (event: PointerEvent): void => {
    if (event.button !== 0 || this.#snapshot === undefined) return;
    this.#dragState = {
      pointerId: event.pointerId,
      clientX: event.clientX,
      clientY: event.clientY,
      position: this.#position,
    };
    this.#elements.handle.setPointerCapture(event.pointerId);
    event.preventDefault();
  };
  #handlePointerMove = (event: PointerEvent): void => {
    const drag = this.#dragState;
    if (drag === undefined || drag.pointerId !== event.pointerId) return;
    this.#position = this.#clamp({
      x: drag.position.x + event.clientX - drag.clientX,
      y: drag.position.y + event.clientY - drag.clientY,
    });
    this.#render();
    event.preventDefault();
  };
  #handlePointerUp = (event: PointerEvent): void => {
    if (this.#dragState?.pointerId === event.pointerId) {
      this.#handlePointerMove(event);
      this.#commitDrag(event.pointerId);
    }
  };
  #handlePointerCancel = (event: PointerEvent): void => {
    if (this.#dragState?.pointerId === event.pointerId) this.#restoreDrag();
  };
  #handleLostPointerCapture = (event: PointerEvent): void => {
    if (this.#dragState?.pointerId === event.pointerId)
      this.#commitDrag(event.pointerId);
  };
  #handleKeyDown = (event: KeyboardEvent): void => {
    if (event.key === "Escape" && this.#dragState !== undefined) {
      this.#restoreDrag();
      event.preventDefault();
    }
  };
  #handleResize = (): void => {
    if (this.#snapshot !== undefined) {
      this.#position = this.#clamp(this.#position);
      this.#render();
    }
  };
  #commitDrag(pointerId: number): void {
    this.#dragState = undefined;
    if (this.#elements.handle.hasPointerCapture(pointerId))
      this.#elements.handle.releasePointerCapture(pointerId);
    this.#commitPosition();
  }
  #restoreDrag(): void {
    const drag = this.#dragState;
    if (drag === undefined) return;
    this.#dragState = undefined;
    this.#position = drag.position;
    if (this.#elements.handle.hasPointerCapture(drag.pointerId))
      this.#elements.handle.releasePointerCapture(drag.pointerId);
    this.#render();
    this.#elements.live.textContent = "Panel move cancelled.";
  }
  #cancelDrag(): void {
    const drag = this.#dragState;
    this.#dragState = undefined;
    if (
      drag !== undefined &&
      this.#elements.handle.hasPointerCapture(drag.pointerId)
    )
      this.#elements.handle.releasePointerCapture(drag.pointerId);
  }
  #commitPosition(): void {
    if (this.#request === undefined)
      this.#onPositionCommitted?.(this.#position);
    else
      void this.#send({
        kind: "update-panel-position",
        panelPosition: this.#position,
      });
    this.#elements.live.textContent = "Panel position saved.";
  }
  #clamp(position: PanelPosition): PanelPosition {
    const bounds = this.#host.getBoundingClientRect();
    const width = Math.max(bounds.width, MIN_REACHABLE_WIDTH);
    const height = Math.max(bounds.height, MIN_REACHABLE_HEIGHT);
    return {
      x: Math.max(
        0,
        Math.min(
          Math.max(
            0,
            this.#window.innerWidth - Math.min(width, MIN_REACHABLE_WIDTH),
          ),
          Math.round(position.x),
        ),
      ),
      y: Math.max(
        0,
        Math.min(
          Math.max(
            0,
            this.#window.innerHeight - Math.min(height, MIN_REACHABLE_HEIGHT),
          ),
          Math.round(position.y),
        ),
      ),
    };
  }
}

function findOrCreateHost(document: Document): HTMLElement {
  const existing = document.getElementById(HOST_ID);
  if (existing?.tagName === "PIXEL-PINCHER-CONTROL-PANEL") return existing;
  existing?.remove();
  const host = document.createElement("pixel-pincher-control-panel");
  host.id = HOST_ID;
  document.documentElement.append(host);
  return host;
}
function rootFor(host: HTMLElement): ShadowRoot {
  const existing = roots.get(host);
  if (existing !== undefined) return existing;
  const root = host.attachShadow({ mode: "closed" });
  roots.set(host, root);
  return root;
}
function findOrCreatePanel(
  root: ShadowRoot,
  document: Document,
): PanelElements {
  root.replaceChildren();
  const style = document.createElement("style");
  style.textContent = controlPanelStyles;
  const panel = document.createElement("section");
  panel.className = "panel";
  panel.setAttribute("aria-label", "Pixel Pincher control panel");
  const header = document.createElement("div");
  header.className = "header";
  const handle = button(document, "handle", "Drag control panel");
  handle.innerHTML =
    '<span>Pixel Pincher</span><span class="grip" aria-hidden="true">⠿</span>';
  const collapse = button(document, "collapse-panel", "Collapse control panel");
  collapse.className = "collapse";
  header.append(handle, collapse);
  const content = document.createElement("div");
  content.className = "content";
  const file = document.createElement("input");
  file.id = "reference-file";
  file.type = "file";
  file.accept = "image/png,image/jpeg,image/webp,image/svg+xml";
  file.hidden = true;
  const fileDropTarget = button(
    document,
    "reference-drop-target",
    "Drop or paste an image, or click to choose one",
  );
  fileDropTarget.classList.add("file-drop-target");
  const controls = document.createElement("fieldset");
  controls.className = "controls";
  const legend = document.createElement("legend");
  legend.textContent = "Overlay controls";
  controls.append(legend);
  const hide = checkbox(document, "overlay-hide", "👁 Hide");
  const opacity = range(document, "opacity", 0, 100);
  const opacityNumber = number(document, "opacity-number", 0, 100);
  const fitWidth = checkbox(document, "fit-width", "Fit to viewport width");
  const scale = range(document, "scale", MIN_SCALE_PERCENT, MAX_SCALE_PERCENT);
  const scaleNumber = number(
    document,
    "scale-number",
    MIN_SCALE_PERCENT,
    MAX_SCALE_PERCENT,
  );
  const inverted = checkbox(document, "inverted", "Invert colors");
  const lock = checkbox(document, "overlay-lock", "🔒 Lock");
  const x = number(document, "x", MIN_PLACEMENT, MAX_PLACEMENT);
  const y = number(document, "y", MIN_PLACEMENT, MAX_PLACEMENT);
  const quickControls = document.createElement("div");
  quickControls.className = "quick-controls";
  quickControls.append(hide.parentElement!, lock.parentElement!);
  appendRangeControl(controls, "Opacity", opacity, opacityNumber);
  appendRangeControl(controls, "Scale", scale, scaleNumber);
  appendPositionControls(controls, x, y);
  controls.append(fitWidth.parentElement!, inverted.parentElement!);
  const clear = button(document, "clear-site", "Clear site data");
  const confirm = document.createElement("p");
  confirm.textContent =
    "Click clear again to confirm removing this site’s image and settings.";
  confirm.hidden = true;
  const live = document.createElement("p");
  live.className = "live";
  live.setAttribute("role", "status");
  live.setAttribute("aria-live", "polite");
  const expanded = document.createElement("div");
  expanded.className = "expanded";
  expanded.append(file, fileDropTarget, controls, clear, confirm, live);
  content.append(quickControls, expanded);
  panel.append(header, content);
  root.append(style, panel);
  return {
    handle,
    collapse,
    live,
    file,
    fileDropTarget,
    hide,
    opacity,
    opacityNumber,
    fitWidth,
    scale,
    scaleNumber,
    inverted,
    lock,
    x,
    y,
    clear,
    confirm,
  };
}
function button(
  document: Document,
  id: string,
  label: string,
): HTMLButtonElement {
  const element = document.createElement("button");
  element.id = id;
  element.className = id === "handle" ? "handle" : "button";
  element.type = "button";
  element.textContent = label;
  element.setAttribute("aria-label", label);
  return element;
}
function checkbox(
  document: Document,
  id: string,
  label: string,
): HTMLInputElement {
  const input = document.createElement("input");
  input.id = id;
  input.type = "checkbox";
  const wrapper = document.createElement("label");
  wrapper.textContent = label;
  wrapper.prepend(input);
  return input;
}
function range(
  document: Document,
  id: string,
  min: number,
  max: number,
): HTMLInputElement {
  const input = document.createElement("input");
  input.id = id;
  input.type = "range";
  input.min = String(min);
  input.max = String(max);
  return input;
}
function number(
  document: Document,
  id: string,
  min: number,
  max: number,
): HTMLInputElement {
  const input = document.createElement("input");
  input.id = id;
  input.type = "number";
  input.min = String(min);
  input.max = String(max);
  input.step = "1";
  return input;
}
function appendLabeled(
  parent: HTMLElement,
  label: string,
  input: HTMLInputElement,
  extra?: HTMLElement,
): void {
  const wrapper = document.createElement("label");
  wrapper.textContent = label;
  wrapper.append(input);
  if (extra !== undefined) wrapper.append(extra);
  parent.append(wrapper);
}
function appendPositionControls(
  parent: HTMLElement,
  x: HTMLInputElement,
  y: HTMLInputElement,
): void {
  const group = parent.ownerDocument.createElement("div");
  group.className = "position-inputs";
  appendLabeled(group, "X position", x);
  appendLabeled(group, "Y position", y);
  parent.append(group);
}

function appendRangeControl(
  parent: HTMLElement,
  labelText: string,
  range: HTMLInputElement,
  number: HTMLInputElement,
): void {
  const label = parent.ownerDocument.createElement("label");
  label.className = "range-control";
  label.append(labelText);
  const inputs = parent.ownerDocument.createElement("div");
  inputs.className = "range-inputs";
  inputs.append(range, number);
  label.append(inputs);
  parent.append(label);
}
function manualScale(sizing: Sizing): number {
  return sizing.kind === "fit-width" ? sizing.lastScalePercent : sizing.percent;
}
function clampScale(value: number): number {
  return Math.min(
    MAX_SCALE_PERCENT,
    Math.max(MIN_SCALE_PERCENT, Math.round(value)),
  );
}
function clampPercent(value: number): number {
  return Math.min(100, Math.max(0, Math.round(value)));
}
function clampPlacement(value: number): number {
  return Math.min(MAX_PLACEMENT, Math.max(MIN_PLACEMENT, Math.round(value)));
}
function preventDefault(event: Event): void {
  event.preventDefault();
}

function contentReferenceId(): string {
  if (typeof crypto.randomUUID === "function") return crypto.randomUUID();
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = [...bytes].map((byte) => byte.toString(16).padStart(2, "0"));
  return `${hex.slice(0, 4).join("")}-${hex.slice(4, 6).join("")}-${hex.slice(6, 8).join("")}-${hex.slice(8, 10).join("")}-${hex.slice(10).join("")}`;
}

function dataUrlFor(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () =>
      reject(reader.error ?? new Error("Unable to read image."));
    reader.onload = () =>
      typeof reader.result === "string"
        ? resolve(reader.result)
        : reject(new Error("Invalid image URL."));
    reader.readAsDataURL(blob);
  });
}

async function decodeContentImage(
  bytes: Uint8Array,
  mimeType: string,
): Promise<Readonly<{ width: number; height: number }>> {
  const copy = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(copy).set(bytes);
  const blob = new Blob([copy], { type: mimeType });
  try {
    const decoder = new ImageDecoder({
      data: new Uint8Array(copy),
      type: mimeType,
    });
    try {
      const { image } = await decoder.decode();
      try {
        return { width: image.displayWidth, height: image.displayHeight };
      } finally {
        image.close();
      }
    } finally {
      decoder.close();
    }
  } catch (error) {
    console.error("[Pixel Pincher] ImageDecoder could not decode the image.", {
      error,
      mimeType,
      size: bytes.byteLength,
    });
  }
  try {
    const bitmap = await createImageBitmap(blob);
    try {
      return { width: bitmap.width, height: bitmap.height };
    } finally {
      bitmap.close();
    }
  } catch (error) {
    console.error(
      "[Pixel Pincher] createImageBitmap could not decode the image.",
      {
        error,
        mimeType,
        size: bytes.byteLength,
      },
    );
    const image = new Image();
    const dataUrl = await dataUrlFor(blob);
    const loaded = await new Promise<HTMLImageElement>((resolve, reject) => {
      image.onload = () => resolve(image);
      image.onerror = () => reject(new Error("Image decoding failed."));
      image.src = dataUrl;
    });
    return { width: loaded.naturalWidth, height: loaded.naturalHeight };
  }
}

/** Browser adapters for the existing pure import service; no unvalidated file crosses runtime messaging. */
export function createContentImporter(): Importer {
  const deps: ImportDependencies = {
    async readFile(file) {
      if (!(file instanceof File)) throw new Error("Expected File.");
      return new Uint8Array(await file.arrayBuffer());
    },
    decodeImage: decodeContentImage,
    randomReferenceId: contentReferenceId,
    currentTimestamp() {
      return Date.now();
    },
  };
  const importer = createImportReference(deps);
  return async (file) => {
    const result = await importer(file);
    return result.ok
      ? result
      : {
          ok: false,
          error: { code: result.error.code, message: result.error.message },
        };
  };
}
