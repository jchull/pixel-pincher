import overlayStyles from "./overlay.css?inline";

import {
  MAX_PLACEMENT,
  MIN_PLACEMENT,
  type Hydration,
  type OverlaySnapshot,
  type Placement,
  type ReferenceId,
  type RenderError,
  type Result,
} from "../shared/contracts";

const HOST_ID = "pixel-pincher-overlay";
const roots = new WeakMap<HTMLElement, ShadowRoot>();

export type OverlayControllerOptions = Readonly<{
  window: Window;
  document: Document;
  requestAnimationFrame: (callback: FrameRequestCallback) => number;
  cancelAnimationFrame: (handle: number) => void;
  onPlacementCommitted: (placement: Placement) => void;
  onImageLoadFailed: (referenceId: ReferenceId) => void;
}>;

type DragState = Readonly<{
  pointerId: number;
  clientX: number;
  clientY: number;
  placement: Placement;
}>;

export class OverlayController {
  readonly #window: Window;
  readonly #requestAnimationFrame: OverlayControllerOptions["requestAnimationFrame"];
  readonly #cancelAnimationFrame: OverlayControllerOptions["cancelAnimationFrame"];
  readonly #onPlacementCommitted: OverlayControllerOptions["onPlacementCommitted"];
  readonly #onImageLoadFailed: OverlayControllerOptions["onImageLoadFailed"];
  readonly #host: HTMLElement;
  readonly #image: HTMLImageElement;
  #snapshot: OverlaySnapshot | undefined;
  #revision = -1;
  #referenceId: ReferenceId | undefined;
  #imageGeneration = 0;
  #imageFailed = false;
  #frame: number | undefined;
  #drag: DragState | undefined;
  #destroyed = false;

  constructor(options: OverlayControllerOptions) {
    this.#window = options.window;
    this.#requestAnimationFrame = options.requestAnimationFrame;
    this.#cancelAnimationFrame = options.cancelAnimationFrame;
    this.#onPlacementCommitted = options.onPlacementCommitted;
    this.#onImageLoadFailed = options.onImageLoadFailed;
    this.#host = findOrCreateHost(options.document);
    const root = rootFor(this.#host);
    this.#image = findOrCreateImage(root, options.document);
    this.#image.addEventListener("pointerdown", this.#handlePointerDown);
    this.#image.addEventListener("pointermove", this.#handlePointerMove);
    this.#image.addEventListener("pointerup", this.#handlePointerUp);
    this.#image.addEventListener("pointercancel", this.#handlePointerCancel);
    this.#image.addEventListener(
      "lostpointercapture",
      this.#handlePointerCancel,
    );
    this.#image.addEventListener("dragstart", preventDefault);
    this.#window.addEventListener("scroll", this.#schedulePaint, {
      passive: true,
    });
    this.#window.addEventListener("resize", this.#schedulePaint);
    this.#window.addEventListener("keydown", this.#handleKeyDown);
    this.#host.style.display = "none";
  }

  hydrate(hydration: Hydration): Promise<Result<void, RenderError>> {
    if (this.#destroyed || this.#isStale(hydration.snapshot.revision))
      return Promise.resolve({ ok: true, value: undefined });
    this.#revision = hydration.snapshot.revision;
    this.#cancelDrag();
    this.#snapshot = hydration.snapshot;
    if (hydration.reference === null) {
      this.#clearImage();
      this.#schedulePaint();
      return Promise.resolve({ ok: true, value: undefined });
    }
    const referenceId = hydration.reference.metadata.id;
    if (
      this.#referenceId !== referenceId ||
      this.#image.getAttribute("src") !== hydration.reference.dataUrl
    ) {
      this.#imageGeneration += 1;
      this.#imageFailed = false;
      this.#referenceId = referenceId;
      const generation = this.#imageGeneration;
      this.#image.onload = () => {
        if (
          !this.#destroyed &&
          this.#imageGeneration === generation &&
          this.#referenceId === referenceId
        )
          this.#schedulePaint();
      };
      this.#image.onerror = () => {
        if (
          !this.#destroyed &&
          this.#imageGeneration === generation &&
          this.#referenceId === referenceId &&
          !this.#imageFailed
        ) {
          this.#imageFailed = true;
          this.#schedulePaint();
          this.#onImageLoadFailed(referenceId);
        }
      };
      this.#image.src = hydration.reference.dataUrl;
    }
    this.#schedulePaint();
    return Promise.resolve({ ok: true, value: undefined });
  }

  apply(snapshot: OverlaySnapshot): void {
    if (this.#destroyed || this.#isStale(snapshot.revision)) return;
    this.#revision = snapshot.revision;
    this.#cancelDrag();
    this.#snapshot = snapshot;
    if (
      snapshot.reference === null ||
      snapshot.reference.id !== this.#referenceId
    )
      this.#clearImage();
    this.#schedulePaint();
  }

  clear(revision: number): void {
    if (this.#destroyed || this.#isStale(revision)) return;
    this.#revision = revision;
    this.#cancelDrag();
    this.#snapshot = undefined;
    this.#clearImage();
    this.#schedulePaint();
  }

  destroy(): void {
    if (this.#destroyed) return;
    this.#destroyed = true;
    if (this.#frame !== undefined) this.#cancelAnimationFrame(this.#frame);
    this.#window.removeEventListener("scroll", this.#schedulePaint);
    this.#window.removeEventListener("resize", this.#schedulePaint);
    this.#window.removeEventListener("keydown", this.#handleKeyDown);
    this.#image.removeEventListener("pointerdown", this.#handlePointerDown);
    this.#image.removeEventListener("pointermove", this.#handlePointerMove);
    this.#image.removeEventListener("pointerup", this.#handlePointerUp);
    this.#image.removeEventListener("pointercancel", this.#handlePointerCancel);
    this.#image.removeEventListener(
      "lostpointercapture",
      this.#handlePointerCancel,
    );
    this.#image.removeEventListener("dragstart", preventDefault);
    this.#host.remove();
  }

  #isStale(revision: number): boolean {
    return revision < this.#revision;
  }

  #clearImage(): void {
    this.#imageGeneration += 1;
    this.#referenceId = undefined;
    this.#imageFailed = false;
    this.#image.removeAttribute("src");
  }

  #schedulePaint = (): void => {
    if (this.#destroyed || this.#frame !== undefined) return;
    this.#frame = this.#requestAnimationFrame(() => {
      this.#frame = undefined;
      this.#paint();
    });
  };

  #paint(): void {
    const snapshot = this.#snapshot;
    if (
      snapshot === undefined ||
      snapshot.reference === null ||
      this.#referenceId !== snapshot.reference.id ||
      this.#imageFailed
    ) {
      this.#host.style.display = "none";
      return;
    }
    const { reference, settings } = snapshot;
    this.#host.style.display = settings.visible ? "block" : "none";
    this.#host.style.pointerEvents = "none";
    const dragMode = settings.interactionMode === "drag";
    this.#image.style.pointerEvents = dragMode ? "auto" : "none";
    this.#image.classList.toggle("drag-mode", dragMode);
    this.#image.style.opacity = String(settings.opacity);
    this.#image.style.filter = settings.inverted ? "invert(1)" : "none";
    const width =
      settings.sizing.kind === "fit-width"
        ? this.#window.innerWidth
        : (reference.width * settings.sizing.percent) / 100;
    this.#image.style.width = `${width}px`;
    this.#image.style.height = "auto";
    this.#image.style.transform = `translate3d(${settings.placement.x - this.#window.scrollX}px, ${settings.placement.y - this.#window.scrollY}px, 0)`;
  }

  #handlePointerDown = (event: PointerEvent): void => {
    const snapshot = this.#snapshot;
    if (
      snapshot === undefined ||
      snapshot.settings.interactionMode !== "drag" ||
      event.button !== 0
    )
      return;
    this.#drag = {
      pointerId: event.pointerId,
      clientX: event.clientX,
      clientY: event.clientY,
      placement: snapshot.settings.placement,
    };
    this.#image.setPointerCapture(event.pointerId);
    event.preventDefault();
  };

  #handlePointerMove = (event: PointerEvent): void => {
    const drag = this.#drag;
    if (
      drag === undefined ||
      drag.pointerId !== event.pointerId ||
      this.#snapshot === undefined
    )
      return;
    this.#snapshot = {
      ...this.#snapshot,
      settings: {
        ...this.#snapshot.settings,
        placement: {
          x: drag.placement.x + event.clientX - drag.clientX,
          y: drag.placement.y + event.clientY - drag.clientY,
        },
      },
    };
    event.preventDefault();
    this.#schedulePaint();
  };

  #handlePointerUp = (event: PointerEvent): void => {
    const drag = this.#drag;
    if (
      drag === undefined ||
      drag.pointerId !== event.pointerId ||
      this.#snapshot === undefined
    )
      return;
    this.#handlePointerMove(event);
    this.#commitDrag(event.pointerId);
  };

  #handlePointerCancel = (event: PointerEvent): void => {
    if (this.#drag?.pointerId !== event.pointerId) return;
    this.#commitDrag(event.pointerId);
  };

  #handleKeyDown = (event: KeyboardEvent): void => {
    const drag = this.#drag;
    if (
      drag === undefined ||
      event.key !== "Escape" ||
      this.#snapshot === undefined
    )
      return;
    this.#snapshot = {
      ...this.#snapshot,
      settings: { ...this.#snapshot.settings, placement: drag.placement },
    };
    this.#cancelDrag();
    this.#schedulePaint();
  };

  #commitDrag(pointerId: number): void {
    if (this.#snapshot === undefined) return;
    const placement = {
      x: clampPlacement(this.#snapshot.settings.placement.x),
      y: clampPlacement(this.#snapshot.settings.placement.y),
    };
    this.#snapshot = {
      ...this.#snapshot,
      settings: { ...this.#snapshot.settings, placement },
    };
    this.#drag = undefined;
    if (this.#image.hasPointerCapture(pointerId))
      this.#image.releasePointerCapture(pointerId);
    this.#schedulePaint();
    this.#onPlacementCommitted(placement);
  }

  #cancelDrag(): void {
    const drag = this.#drag;
    this.#drag = undefined;
    if (drag !== undefined && this.#image.hasPointerCapture(drag.pointerId))
      this.#image.releasePointerCapture(drag.pointerId);
  }
}

function findOrCreateHost(document: Document): HTMLElement {
  const existing = document.getElementById(HOST_ID);
  if (existing?.tagName === "PIXEL-PINCHER-OVERLAY") return existing;
  existing?.remove();
  const host = document.createElement("pixel-pincher-overlay");
  host.id = HOST_ID;
  Object.assign(host.style, {
    position: "fixed",
    top: "0",
    left: "0",
    zIndex: "2147483647",
    width: "0",
    height: "0",
    margin: "0",
    padding: "0",
    pointerEvents: "none",
    overflow: "visible",
  });
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

function findOrCreateImage(
  root: ShadowRoot,
  document: Document,
): HTMLImageElement {
  const existing = root.querySelector("img");
  if (existing instanceof HTMLImageElement) return existing;
  const style = document.createElement("style");
  style.textContent = overlayStyles;
  const image = document.createElement("img");
  image.draggable = false;
  image.alt = "";
  root.append(style, image);
  return image;
}

function clampPlacement(value: number): number {
  return Math.max(MIN_PLACEMENT, Math.min(MAX_PLACEMENT, Math.round(value)));
}

function preventDefault(event: Event): void {
  event.preventDefault();
}
