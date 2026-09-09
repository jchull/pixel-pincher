import controlPanelStyles from "./control-panel.css?inline";
import { lucideIcon } from "./lucide-icons";
import { readBoundedResponse } from "./read-bounded-response";

import {
  createImportReference,
  type ImportDependencies,
} from "../shared/image-import";
import {
  MAX_IMAGE_RAW_BYTES,
  MAX_PLACEMENT,
  MAX_SCALE_PERCENT,
  MIN_PLACEMENT,
  MIN_SCALE_PERCENT,
  type ContentPanelRequest,
  type Hydration,
  type ImportedReference,
  type OverlaySnapshot,
  type PanelPosition,
  type Placement,
  type PublicError,
  type SettingsPatch,
  type Sizing,
  publicError,
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
type PanelMutationResult =
  | Readonly<{ ok: true; snapshot?: OverlaySnapshot }>
  | Readonly<{ ok: false }>;

type PanelElements = Readonly<{
  close: HTMLButtonElement;
  handle: HTMLButtonElement;
  collapse: HTMLButtonElement;
  live: HTMLElement;
  file: HTMLInputElement;
  fileDropTarget: HTMLElement;
  uploadImage: HTMLAnchorElement;
  referenceUrlForm: HTMLFormElement;
  referenceUrl: HTMLInputElement;
  hide: HTMLButtonElement;
  opacity: HTMLInputElement;
  opacityNumber: HTMLInputElement;
  fitWidth: HTMLButtonElement;
  scale: HTMLInputElement;
  scaleNumber: HTMLInputElement;
  inverted: HTMLButtonElement;
  lock: HTMLButtonElement;
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
  #placementIntent: Placement | undefined;
  #confirmingClear = false;
  #collapsed = false;
  #referenceDataUrl: string | undefined;

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
    e.close.addEventListener("click", this.#closePanel);
    e.collapse.addEventListener("click", this.#toggleCollapsed);
    e.file.addEventListener("change", this.#handleFile);
    e.uploadImage.addEventListener("click", this.#openFilePicker);
    e.fileDropTarget.addEventListener("dragenter", this.#handleDragEnter);
    e.fileDropTarget.addEventListener("dragover", this.#handleDragOver);
    e.fileDropTarget.addEventListener("dragleave", this.#handleDragLeave);
    e.fileDropTarget.addEventListener("drop", this.#handleDrop);
    e.fileDropTarget.addEventListener("paste", this.#handlePaste);
    e.referenceUrlForm.addEventListener("submit", this.#handleUrlSubmit);
    e.referenceUrl.addEventListener("keydown", this.#handleUrlKey);
    e.hide.addEventListener("click", this.#handleVisibility);
    e.opacity.addEventListener("input", this.#handleOpacity);
    e.opacityNumber.addEventListener("input", this.#handleOpacityNumber);
    e.opacityNumber.addEventListener("keydown", this.#handleNumberKey);
    e.fitWidth.addEventListener("click", this.#handleFitWidth);
    e.scale.addEventListener("input", this.#handleScale);
    e.scaleNumber.addEventListener("input", this.#handleScaleNumber);
    e.scaleNumber.addEventListener("keydown", this.#handleNumberKey);
    e.inverted.addEventListener("click", this.#handleInversion);
    e.lock.addEventListener("click", this.#handleInteraction);
    e.x.addEventListener("input", this.#handlePlacement);
    e.y.addEventListener("input", this.#handlePlacement);
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
    this.#referenceDataUrl = hydration.reference?.dataUrl;
    this.apply(hydration.snapshot);
  }

  apply(snapshot: OverlaySnapshot): void {
    if (this.#destroyed || snapshot.revision < this.#revision) return;
    this.#revision = snapshot.revision;
    this.#cancelDrag();
    this.#snapshot = snapshot;
    if (snapshot.reference === null) this.#referenceDataUrl = undefined;
    this.#position = this.#clamp(snapshot.panelPosition ?? this.#position);
    this.#render();
  }

  updatePlacement(placement: Placement): void {
    const snapshot = this.#snapshot;
    if (this.#destroyed || snapshot === undefined) return;
    this.#snapshot = {
      ...snapshot,
      settings: { ...snapshot.settings, placement },
    };
    this.#elements.x.value = String(placement.x);
    this.#elements.y.value = String(placement.y);
  }

  clear(revision: number): void {
    if (this.#destroyed || revision < this.#revision) return;
    this.#revision = revision;
    this.#cancelDrag();
    this.#snapshot = undefined;
    this.#referenceDataUrl = undefined;
    this.#host.style.display = "none";
  }

  destroy(): void {
    if (this.#destroyed) return;
    this.#destroyed = true;
    this.#cancelDrag();
    this.#window.removeEventListener("resize", this.#handleResize);
    this.#window.removeEventListener("keydown", this.#handleKeyDown);
    this.#settingsInFlight = false;
    this.#pendingSettings = [];
    this.#placementIntent = undefined;
    this.#referenceDataUrl = undefined;
    this.#snapshot = undefined;
    this.#host.remove();
  }

  #render(): void {
    if (this.#destroyed) return;
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
    e.fileDropTarget.style.setProperty(
      "--reference-image",
      this.#referenceDataUrl === undefined
        ? "none"
        : `url("${this.#referenceDataUrl}")`,
    );
    setHideToggleState(e.hide, !settings.visible);
    e.opacity.value = String(Math.round(settings.opacity * 100));
    e.opacityNumber.value = e.opacity.value;
    setFitWidthToggleState(e.fitWidth, settings.sizing.kind === "fit-width");
    const scale = manualScale(settings.sizing);
    e.scale.value = String(scale);
    e.scaleNumber.value = String(scale);
    e.scale.disabled = disabled || settings.sizing.kind === "fit-width";
    e.scaleNumber.disabled = disabled || settings.sizing.kind === "fit-width";
    setInversionToggleState(e.inverted, settings.inverted);
    setLockToggleState(e.lock, settings.interactionMode === "click-through");
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

  #closePanel = (): void => {
    void this.#hideOverlayAndPanel();
  };
  async #hideOverlayAndPanel(): Promise<void> {
    const result = await this.#send({
      kind: "update-settings",
      patch: { kind: "visibility", visible: false },
    });
    if (result.ok && !this.#destroyed) this.#host.style.display = "none";
  }
  #toggleCollapsed = (): void => {
    this.#collapsed = !this.#collapsed;
    this.#render();
  };
  #openFilePicker = (event: MouseEvent): void => {
    event.preventDefault();
    this.#elements.file.click();
  };
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
    const clipboard = event.clipboardData;
    const files = clipboard?.files ?? null;
    if (files !== null && files.length > 0) {
      event.preventDefault();
      this.#importFirstFile(files);
      return;
    }
    const url = parseImageUrl(clipboard?.getData("text/plain") ?? "");
    if (url === undefined) return;
    event.preventDefault();
    void this.#importImageUrl(url);
  };
  #importFirstFile(files: FileList | null): void {
    const file = files?.[0];
    if (file !== undefined && this.#importReference !== undefined)
      void this.#importFile(file);
  }
  #handleUrlKey = (event: KeyboardEvent): void => {
    if (event.key !== "Enter") return;
    event.preventDefault();
    this.#elements.referenceUrlForm.requestSubmit();
  };
  #handleUrlSubmit = (event: SubmitEvent): void => {
    event.preventDefault();
    const url = parseImageUrl(this.#elements.referenceUrl.value);
    if (url === undefined) {
      this.#showError({
        code: "invalid-image-type",
        message: "Paste a valid http, https, or page blob image URL.",
      });
      return;
    }
    this.#elements.referenceUrl.value = "";
    void this.#importImageUrl(url);
  };

  async #importImageUrl(url: URL): Promise<void> {
    try {
      const response = await fetch(url, {
        credentials: "omit",
        referrerPolicy: "no-referrer",
      });
      if (!response.ok)
        throw new Error(`Image request failed: ${response.status}`);
      const bounded = await readBoundedResponse(response, MAX_IMAGE_RAW_BYTES);
      if (!bounded.ok) {
        if (bounded.reason === "too-large") {
          this.#showError(publicError("image-too-large"));
          return;
        }
        throw new Error("Image response could not be read.");
      }
      const mimeType =
        response.headers.get("content-type")?.split(";", 1)[0]?.trim() ?? "";
      await this.#importFile(
        new File([bounded.bytes], urlImportFileName(), { type: mimeType }),
      );
    } catch {
      console.error("[Pixel Pincher] Could not load an image URL.", {
        source: urlImportSourceLabel(url),
      });
      this.#showError({
        code: "image-decode-failed",
        message:
          "Pixel Pincher could not load that image URL. It must be a publicly accessible image.",
      });
    }
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
      const result = await this.#send({
        kind: "replace-reference",
        reference: imported.value,
      });
      if (result.ok && result.snapshot !== undefined && !this.#destroyed) {
        this.#referenceDataUrl = imported.value.dataUrl;
        this.#render();
      }
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

  #handleVisibility = (): void => {
    const hidden = !isTogglePressed(this.#elements.hide);
    setHideToggleState(this.#elements.hide, hidden);
    this.#queueSetting({ kind: "visibility", visible: !hidden });
  };
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
        sizing: !isTogglePressed(this.#elements.fitWidth)
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
  #handleInversion = (): void => {
    const inverted = !isTogglePressed(this.#elements.inverted);
    setInversionToggleState(this.#elements.inverted, inverted);
    this.#queueSetting({ kind: "inversion", inverted });
  };
  #handleInteraction = (): void => {
    const locked = !isTogglePressed(this.#elements.lock);
    setLockToggleState(this.#elements.lock, locked);
    this.#queueSetting({
      kind: "interaction-mode",
      interactionMode: locked ? "click-through" : "drag",
    });
  };
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
    if (this.#snapshot === undefined) return;
    const placement = {
      ...this.#currentPlacement(),
      [input === this.#elements.x ? "x" : "y"]: clampPlacement(value),
    };
    this.#placementIntent = placement;
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
    if (
      this.#destroyed ||
      this.#snapshot?.reference === null ||
      this.#request === undefined
    )
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
    if (this.#destroyed) return;
    this.#settingsInFlight = true;
    const result = await this.#send({
      kind: "update-settings",
      patch: pending.patch,
    });
    this.#settingsInFlight = false;
    if (this.#destroyed) return;
    if (!result.ok) {
      this.#pendingSettings = [];
      this.#placementIntent = undefined;
      this.#render();
      return;
    }
    const next = this.#pendingSettings.shift();
    if (next !== undefined) {
      void this.#dispatchSetting(next);
      return;
    }
    this.#clearPlacementIntentIfConfirmed(result.snapshot);
  }

  #currentPlacement(): Placement {
    const placement =
      this.#placementIntent ?? this.#snapshot?.settings.placement;
    if (placement === undefined)
      throw new Error(
        "Cannot update placement before the panel has a snapshot.",
      );
    return placement;
  }

  #clearPlacementIntentIfConfirmed(
    snapshot: OverlaySnapshot | undefined,
  ): void {
    const intent = this.#placementIntent;
    if (
      snapshot !== undefined &&
      intent !== undefined &&
      snapshot.settings.placement.x === intent.x &&
      snapshot.settings.placement.y === intent.y
    )
      this.#placementIntent = undefined;
  }

  async #send(request: PanelRequest): Promise<PanelMutationResult> {
    if (this.#destroyed) return { ok: false };
    if (this.#request === undefined) {
      if (request.kind === "update-panel-position")
        this.#onPositionCommitted?.(request.panelPosition);
      return { ok: true };
    }
    const requestId = `panel-${this.#nextRequestId++}`;
    try {
      const parsed = parseContentPanelResponse(
        await this.#request({ ...request, requestId }),
      );
      if (this.#destroyed) return { ok: false };
      if (!parsed.ok || parsed.value.requestId !== requestId) {
        this.#showError({
          code: "invalid-request",
          message: "Pixel Pincher received an invalid request.",
        });
        return { ok: false };
      }
      if (!parsed.value.ok) {
        this.#showError(parsed.value.error);
        return { ok: false };
      }
      if (parsed.value.value !== undefined) {
        this.apply(parsed.value.value);
        return { ok: true, snapshot: parsed.value.value };
      }
      return { ok: true };
    } catch {
      this.#showError({
        code: "content-unavailable",
        message:
          "The page overlay is unavailable. Reload the page and try again.",
      });
      return { ok: false };
    }
  }

  #showError(error: PublicError): void {
    if (!this.#destroyed) this.#elements.live.textContent = error.message;
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
    this.#elements.handle.classList.add("dragging");
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
    this.#elements.handle.classList.remove("dragging");
    if (this.#elements.handle.hasPointerCapture(pointerId))
      this.#elements.handle.releasePointerCapture(pointerId);
    this.#commitPosition();
  }
  #restoreDrag(): void {
    const drag = this.#dragState;
    if (drag === undefined) return;
    this.#dragState = undefined;
    this.#elements.handle.classList.remove("dragging");
    this.#position = drag.position;
    if (this.#elements.handle.hasPointerCapture(drag.pointerId))
      this.#elements.handle.releasePointerCapture(drag.pointerId);
    this.#render();
    this.#elements.live.textContent = "Panel move cancelled.";
  }
  #cancelDrag(): void {
    const drag = this.#dragState;
    this.#dragState = undefined;
    this.#elements.handle.classList.remove("dragging");
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
  const close = button(
    document,
    "close-panel",
    "Hide overlay and control panel",
  );
  close.className = "close";
  close.textContent = "×";
  const handle = button(document, "handle", "Drag control panel");
  handle.innerHTML =
    '<span>Pixel Pincher</span><span class="grip" aria-hidden="true">⠿</span>';
  const collapse = button(document, "collapse-panel", "Collapse control panel");
  collapse.className = "collapse";
  header.append(close, handle, collapse);
  const content = document.createElement("div");
  content.className = "content";
  const file = document.createElement("input");
  file.id = "reference-file";
  file.type = "file";
  file.accept = "image/png,image/jpeg,image/webp,image/svg+xml";
  file.hidden = true;
  const fileDropTarget = document.createElement("div");
  fileDropTarget.id = "reference-drop-target";
  fileDropTarget.className = "file-drop-target button";
  fileDropTarget.tabIndex = 0;
  fileDropTarget.setAttribute(
    "aria-label",
    "Drop or paste image or click to choose",
  );
  fileDropTarget.append("Drop or paste image or \n");
  const uploadImage = document.createElement("a");
  uploadImage.id = "upload-image";
  uploadImage.href = "#";
  uploadImage.textContent = "click to choose";
  const uploadLine = document.createElement("span");
  uploadLine.className = "upload-line";
  uploadLine.append(uploadImage);
  fileDropTarget.append(uploadLine);
  const referenceUrlForm = document.createElement("form");
  referenceUrlForm.id = "reference-url-form";
  const referenceUrl = document.createElement("input");
  referenceUrl.id = "reference-url";
  referenceUrl.type = "url";
  referenceUrl.inputMode = "url";
  referenceUrl.placeholder = "Paste image URL or data URI";
  referenceUrl.setAttribute("autocomplete", "url");
  referenceUrl.setAttribute("aria-label", "Image URL");
  const importUrl = button(document, "import-url", "Import URL");
  importUrl.type = "submit";
  referenceUrlForm.append(referenceUrl, importUrl);
  const controls = document.createElement("fieldset");
  controls.className = "controls";
  const legend = document.createElement("legend");
  legend.textContent = "Overlay controls";
  controls.append(legend);
  const hide = toggleButton(document, "overlay-hide", "Hide");
  const opacity = range(document, "opacity", 0, 100);
  const opacityNumber = number(document, "opacity-number", 0, 100);
  const fitWidth = toggleButton(document, "fit-width", "Fit to viewport width");
  const scale = range(document, "scale", MIN_SCALE_PERCENT, MAX_SCALE_PERCENT);
  const scaleNumber = number(
    document,
    "scale-number",
    MIN_SCALE_PERCENT,
    MAX_SCALE_PERCENT,
  );
  const inverted = toggleButton(document, "inverted", "Invert colors");
  const lock = toggleButton(document, "overlay-lock", "Lock");
  const x = number(document, "x", MIN_PLACEMENT, MAX_PLACEMENT);
  const y = number(document, "y", MIN_PLACEMENT, MAX_PLACEMENT);
  const quickControls = document.createElement("div");
  quickControls.className = "quick-controls";
  quickControls.append(hide, lock, fitWidth, inverted);
  appendRangeControl(controls, "Opacity", opacity, opacityNumber);
  appendRangeControl(controls, "Scale", scale, scaleNumber);
  appendPositionControls(controls, x, y);

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
  expanded.append(
    file,
    fileDropTarget,
    referenceUrlForm,
    controls,
    clear,
    confirm,
    live,
  );
  content.append(quickControls, expanded);
  panel.append(header, content);
  root.append(style, panel);
  return {
    close,
    handle,
    collapse,
    live,
    file,
    fileDropTarget,
    uploadImage,
    referenceUrlForm,
    referenceUrl,
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
function toggleButton(
  document: Document,
  id: string,
  label: string,
): HTMLButtonElement {
  const toggle = button(document, id, label);
  toggle.classList.add("toggle-button");
  toggle.setAttribute("aria-pressed", "false");
  return toggle;
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
function isTogglePressed(toggle: HTMLButtonElement): boolean {
  return toggle.getAttribute("aria-pressed") === "true";
}

function setToggleState(toggle: HTMLButtonElement, pressed: boolean): void {
  toggle.setAttribute("aria-pressed", String(pressed));
}

function setHideToggleState(toggle: HTMLButtonElement, hidden: boolean): void {
  setToggleState(toggle, hidden);
  setToggleLabel(toggle, hidden ? "eye" : "eye-off", hidden ? "Show" : "Hide");
}

function setLockToggleState(toggle: HTMLButtonElement, locked: boolean): void {
  setToggleState(toggle, locked);
  setToggleLabel(
    toggle,
    locked ? "lock-keyhole-open" : "lock",
    locked ? "Unlock" : "Lock",
  );
}

function setFitWidthToggleState(toggle: HTMLButtonElement, enabled: boolean): void {
  setToggleState(toggle, enabled);
  setToggleLabel(toggle, "maximize", "Fit to viewport width");
}

function setInversionToggleState(toggle: HTMLButtonElement, inverted: boolean): void {
  setToggleState(toggle, inverted);
  setToggleLabel(toggle, "contrast", "Invert colors");
}

function setToggleLabel(
  toggle: HTMLButtonElement,
  icon: "eye" | "eye-off" | "lock" | "lock-keyhole-open" | "maximize" | "contrast",
  label: string,
): void {
  const accessibleLabel = `${label} overlay`;
  toggle.replaceChildren(lucideIcon(toggle.ownerDocument, icon));
  toggle.setAttribute("aria-label", accessibleLabel);
  toggle.title = accessibleLabel;
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
function parseImageUrl(value: string): URL | undefined {
  try {
    const url = new URL(value.trim());
    return url.protocol === "http:" ||
      url.protocol === "https:" ||
      url.protocol === "blob:" ||
      url.protocol === "data:"
      ? url
      : undefined;
  } catch {
    return undefined;
  }
}

function urlImportSourceLabel(url: URL): "blob" | "data" | string {
  if (url.protocol === "blob:") return "blob";
  if (url.protocol === "data:") return "data";
  return `${url.protocol}//${url.host}`;
}

function urlImportFileName(): string {
  return "pasted-image";
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
