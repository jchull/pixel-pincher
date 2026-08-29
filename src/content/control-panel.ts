import controlPanelStyles from "./control-panel.css?inline";

import type {
  Hydration,
  OverlaySnapshot,
  PanelPosition,
} from "../shared/contracts";

const HOST_ID = "pixel-pincher-control-panel";
const DEFAULT_POSITION: PanelPosition = { x: 24, y: 24 };
const KEYBOARD_STEP = 16;
const MIN_REACHABLE_WIDTH = 48;
const MIN_REACHABLE_HEIGHT = 40;
const roots = new WeakMap<HTMLElement, ShadowRoot>();

export type ControlPanelOptions = Readonly<{
  window: Window;
  document: Document;
  onPositionCommitted: (position: PanelPosition) => void;
}>;

type DragState = Readonly<{
  pointerId: number;
  clientX: number;
  clientY: number;
  position: PanelPosition;
}>;

type MoveDirection = "up" | "down" | "left" | "right";

export class ControlPanel {
  readonly #window: Window;
  readonly #onPositionCommitted: ControlPanelOptions["onPositionCommitted"];
  readonly #host: HTMLElement;
  readonly #handle: HTMLButtonElement;
  readonly #reference: HTMLElement;
  readonly #visibility: HTMLElement;
  readonly #live: HTMLElement;
  #snapshot: OverlaySnapshot | undefined;
  #revision = -1;
  #position: PanelPosition = DEFAULT_POSITION;
  #drag: DragState | undefined;
  #destroyed = false;

  constructor(options: ControlPanelOptions) {
    this.#window = options.window;
    this.#onPositionCommitted = options.onPositionCommitted;
    this.#host = findOrCreateHost(options.document);
    const root = rootFor(this.#host);
    const elements = findOrCreatePanel(root, options.document);
    this.#handle = elements.handle;
    this.#reference = elements.reference;
    this.#visibility = elements.visibility;
    this.#live = elements.live;
    this.#handle.addEventListener("pointerdown", this.#handlePointerDown);
    this.#handle.addEventListener("pointermove", this.#handlePointerMove);
    this.#handle.addEventListener("pointerup", this.#handlePointerUp);
    this.#handle.addEventListener("pointercancel", this.#handlePointerCancel);
    this.#handle.addEventListener("lostpointercapture", this.#handleLostPointerCapture);
    this.#handle.addEventListener("dragstart", preventDefault);
    for (const button of elements.moves) {
      button.addEventListener("click", this.#handleMoveButton);
    }
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
    this.#handle.removeEventListener("pointerdown", this.#handlePointerDown);
    this.#handle.removeEventListener("pointermove", this.#handlePointerMove);
    this.#handle.removeEventListener("pointerup", this.#handlePointerUp);
    this.#handle.removeEventListener("pointercancel", this.#handlePointerCancel);
    this.#handle.removeEventListener("lostpointercapture", this.#handleLostPointerCapture);
    this.#handle.removeEventListener("dragstart", preventDefault);
    for (const button of this.#host.querySelectorAll<HTMLButtonElement>(".move")) {
      button.removeEventListener("click", this.#handleMoveButton);
    }
    this.#window.removeEventListener("resize", this.#handleResize);
    this.#window.removeEventListener("keydown", this.#handleKeyDown);
    this.#host.remove();
  }

  #render(): void {
    const snapshot = this.#snapshot;
    if (snapshot === undefined) return;
    this.#host.style.display = "block";
    this.#host.style.left = `${this.#position.x}px`;
    this.#host.style.top = `${this.#position.y}px`;
    if (snapshot.reference === null) {
      this.#reference.textContent = "No reference image";
      this.#reference.classList.add("none");
    } else {
      this.#reference.textContent = `${snapshot.reference.name} · ${snapshot.reference.width} × ${snapshot.reference.height}`;
      this.#reference.classList.remove("none");
    }
    const visible = snapshot.settings.visible;
    this.#visibility.textContent = visible ? "Overlay visible" : "Overlay hidden";
    this.#visibility.classList.toggle("hidden", !visible);
  }

  #handlePointerDown = (event: PointerEvent): void => {
    if (event.button !== 0 || this.#snapshot === undefined) return;
    this.#drag = {
      pointerId: event.pointerId,
      clientX: event.clientX,
      clientY: event.clientY,
      position: this.#position,
    };
    this.#handle.setPointerCapture(event.pointerId);
    event.preventDefault();
  };

  #handlePointerMove = (event: PointerEvent): void => {
    const drag = this.#drag;
    if (drag === undefined || drag.pointerId !== event.pointerId) return;
    this.#position = this.#clamp({
      x: drag.position.x + event.clientX - drag.clientX,
      y: drag.position.y + event.clientY - drag.clientY,
    });
    this.#render();
    event.preventDefault();
  };

  #handlePointerUp = (event: PointerEvent): void => {
    if (this.#drag?.pointerId !== event.pointerId) return;
    this.#handlePointerMove(event);
    this.#commitDrag(event.pointerId);
  };

  #handlePointerCancel = (event: PointerEvent): void => {
    if (this.#drag?.pointerId !== event.pointerId) return;
    this.#restoreDrag();
  };

  #handleLostPointerCapture = (event: PointerEvent): void => {
    if (this.#drag?.pointerId !== event.pointerId) return;
    this.#commitDrag(event.pointerId);
  };

  #handleKeyDown = (event: KeyboardEvent): void => {
    if (event.key !== "Escape" || this.#drag === undefined) return;
    this.#restoreDrag();
    event.preventDefault();
  };

  #handleResize = (): void => {
    if (this.#snapshot === undefined) return;
    this.#position = this.#clamp(this.#position);
    this.#render();
  };

  #handleMoveButton = (event: Event): void => {
    const button = event.currentTarget;
    if (!(button instanceof HTMLButtonElement)) return;
    const direction = button.dataset.direction;
    if (!isMoveDirection(direction)) return;
    this.#move(direction);
  };

  #move(direction: MoveDirection): void {
    const delta = directionDelta(direction);
    this.#position = this.#clamp({
      x: this.#position.x + delta.x,
      y: this.#position.y + delta.y,
    });
    this.#render();
    this.#commitPosition("Panel position saved.");
  }

  #commitDrag(pointerId: number): void {
    this.#drag = undefined;
    if (this.#handle.hasPointerCapture(pointerId))
      this.#handle.releasePointerCapture(pointerId);
    this.#commitPosition("Panel position saved.");
  }

  #restoreDrag(): void {
    const drag = this.#drag;
    if (drag === undefined) return;
    this.#drag = undefined;
    this.#position = drag.position;
    if (this.#handle.hasPointerCapture(drag.pointerId))
      this.#handle.releasePointerCapture(drag.pointerId);
    this.#render();
    this.#live.textContent = "Panel move cancelled.";
  }

  #cancelDrag(): void {
    const drag = this.#drag;
    this.#drag = undefined;
    if (drag !== undefined && this.#handle.hasPointerCapture(drag.pointerId))
      this.#handle.releasePointerCapture(drag.pointerId);
  }

  #commitPosition(message: string): void {
    this.#onPositionCommitted(this.#position);
    this.#live.textContent = message;
  }

  #clamp(position: PanelPosition): PanelPosition {
    const bounds = this.#host.getBoundingClientRect();
    const width = Math.max(bounds.width, MIN_REACHABLE_WIDTH);
    const height = Math.max(bounds.height, MIN_REACHABLE_HEIGHT);
    return {
      x: Math.max(0, Math.min(Math.max(0, this.#window.innerWidth - Math.min(width, MIN_REACHABLE_WIDTH)), Math.round(position.x))),
      y: Math.max(0, Math.min(Math.max(0, this.#window.innerHeight - Math.min(height, MIN_REACHABLE_HEIGHT)), Math.round(position.y))),
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

type PanelElements = Readonly<{
  handle: HTMLButtonElement;
  reference: HTMLElement;
  visibility: HTMLElement;
  live: HTMLElement;
  moves: readonly HTMLButtonElement[];
}>;

function findOrCreatePanel(root: ShadowRoot, document: Document): PanelElements {
  const existingHandle = root.querySelector<HTMLButtonElement>(".handle");
  const existingReference = root.querySelector<HTMLElement>(".reference");
  const existingVisibility = root.querySelector<HTMLElement>(".visibility");
  const existingLive = root.querySelector<HTMLElement>(".live");
  const existingMoves = [...root.querySelectorAll<HTMLButtonElement>(".move")];
  if (
    existingHandle !== null &&
    existingReference !== null &&
    existingVisibility !== null &&
    existingLive !== null &&
    existingMoves.length === 4
  ) {
    return {
      handle: existingHandle,
      reference: existingReference,
      visibility: existingVisibility,
      live: existingLive,
      moves: existingMoves,
    };
  }

  root.replaceChildren();
  const style = document.createElement("style");
  style.textContent = controlPanelStyles;
  const panel = document.createElement("section");
  panel.className = "panel";
  panel.setAttribute("aria-label", "Pixel Pincher control panel");
  const handle = document.createElement("button");
  handle.className = "handle";
  handle.type = "button";
  handle.setAttribute("aria-label", "Drag control panel");
  handle.innerHTML = "<span>Pixel Pincher</span><span class=\"grip\" aria-hidden=\"true\">⠿</span>";
  const content = document.createElement("div");
  content.className = "content";
  const reference = document.createElement("div");
  reference.className = "reference";
  const visibility = document.createElement("div");
  visibility.className = "visibility";
  const dot = document.createElement("span");
  dot.className = "dot";
  dot.setAttribute("aria-hidden", "true");
  visibility.append(dot);
  const moves = createMoveControls(document);
  const live = document.createElement("p");
  live.className = "live";
  live.setAttribute("role", "status");
  live.setAttribute("aria-live", "polite");
  content.append(reference, visibility, moves.container, live);
  panel.append(handle, content);
  root.append(style, panel);
  return { handle, reference, visibility, live, moves: moves.buttons };
}

function createMoveControls(document: Document): Readonly<{
  container: HTMLElement;
  buttons: readonly HTMLButtonElement[];
}> {
  const container = document.createElement("div");
  container.className = "moves";
  container.setAttribute("aria-label", "Move panel");
  const descriptors: readonly Readonly<{ direction: MoveDirection; label: string; symbol: string }>[] = [
    { direction: "up", label: "Move panel up", symbol: "↑" },
    { direction: "left", label: "Move panel left", symbol: "←" },
    { direction: "down", label: "Move panel down", symbol: "↓" },
    { direction: "right", label: "Move panel right", symbol: "→" },
  ];
  const buttons = descriptors.map((descriptor) => {
    const button = document.createElement("button");
    button.type = "button";
    button.className = `move move-${descriptor.direction}`;
    button.dataset.direction = descriptor.direction;
    button.setAttribute("aria-label", descriptor.label);
    button.textContent = descriptor.symbol;
    return button;
  });
  container.append(...buttons);
  return { container, buttons };
}

function directionDelta(direction: MoveDirection): PanelPosition {
  switch (direction) {
    case "up":
      return { x: 0, y: -KEYBOARD_STEP };
    case "down":
      return { x: 0, y: KEYBOARD_STEP };
    case "left":
      return { x: -KEYBOARD_STEP, y: 0 };
    case "right":
      return { x: KEYBOARD_STEP, y: 0 };
  }
}

function isMoveDirection(value: string | undefined): value is MoveDirection {
  return value === "up" || value === "down" || value === "left" || value === "right";
}

function preventDefault(event: Event): void {
  event.preventDefault();
}
