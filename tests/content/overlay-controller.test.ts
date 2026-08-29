import { beforeEach, describe, expect, it, vi } from "vitest";

import { OverlayController } from "../../src/content/overlay-controller";
import type { Hydration, OverlaySnapshot } from "../../src/shared/contracts";
import { parseHydration, parseOverlaySnapshot } from "../../src/shared/parse";

const dataUrl = "data:image/png;base64,AQID";
const metadata = {
  id: "123e4567-e89b-42d3-a456-426614174000",
  name: "reference.png",
  mimeType: "image/png",
  width: 200,
  height: 100,
  encodedBytes: new TextEncoder().encode(dataUrl).byteLength,
  importedAt: 1,
};

function parse<T>(
  value: { readonly ok: true; readonly value: T } | { readonly ok: false },
): T {
  if (!value.ok) throw new Error("Fixture failed validation.");
  return value.value;
}

function snapshot(
  revision: number,
  settings: Record<string, unknown> = {},
): OverlaySnapshot {
  return parse(
    parseOverlaySnapshot({
      revision,
      origin: "https://example.test",
      pageKey: "https://example.test/page",
      reference: metadata,
      settings: {
        visible: true,
        opacity: 0.5,
        inverted: false,
        placement: { x: 10, y: 20 },
        sizing: { kind: "scale", percent: 100 },
        interactionMode: "click-through",
        ...settings,
      },
    }),
  );
}

function hydration(revision = 1): Hydration {
  const current = snapshot(revision);
  return parse(
    parseHydration({ snapshot: current, reference: { metadata, dataUrl } }),
  );
}

function pointer(
  type: string,
  values: Readonly<{
    button?: number;
    pointerId: number;
    clientX: number;
    clientY: number;
  }>,
): Event {
  const event = new Event(type, { bubbles: true, cancelable: true });
  Object.defineProperties(event, {
    button: { value: values.button ?? 0 },
    pointerId: { value: values.pointerId },
    clientX: { value: values.clientX },
    clientY: { value: values.clientY },
  });
  return event;
}

describe("OverlayController", () => {
  let frame: FrameRequestCallback | undefined;
  let controller: OverlayController;
  let commits: ReturnType<typeof vi.fn>;
  let failures: ReturnType<typeof vi.fn>;
  let overlayImage: HTMLImageElement | undefined;

  const paint = (): void => {
    if (frame === undefined) throw new Error("No frame scheduled.");
    const pending = frame;
    frame = undefined;
    pending(0);
  };

  const image = (): HTMLImageElement => {
    if (overlayImage === undefined) throw new Error("Expected overlay image.");
    return overlayImage;
  };

  beforeEach(() => {
    document.getElementById("pixel-pincher-overlay")?.remove();
    document.body.replaceChildren();
    overlayImage = undefined;
    const createElement = document.createElement.bind(document);
    vi.spyOn(document, "createElement").mockImplementation(
      (tagName: string) => {
        const created = createElement(tagName);
        if (tagName === "img" && created instanceof HTMLImageElement)
          overlayImage = created;
        return created;
      },
    );
    frame = undefined;
    commits = vi.fn();
    failures = vi.fn();
    controller = new OverlayController({
      window,
      document,
      requestAnimationFrame: vi.fn((callback: FrameRequestCallback) => {
        frame = callback;
        return 1;
      }),
      cancelAnimationFrame: vi.fn(),
      onPlacementCommitted: commits,
      onImageLoadFailed: failures,
    });
  });

  it("renders one isolated host with scale, opacity, inversion, and scroll-adjusted coordinates", () => {
    controller.hydrate(hydration());
    paint();
    const overlay = image();
    expect(document.querySelectorAll("#pixel-pincher-overlay")).toHaveLength(1);
    expect(
      document.querySelector("#pixel-pincher-overlay")?.shadowRoot,
    ).toBeNull();
    expect(overlay.src).toBe(dataUrl);
    expect(overlay.style.width).toBe("200px");
    expect(overlay.style.opacity).toBe("0.5");
    expect(overlay.style.filter).toBe("none");
    expect(overlay.style.transform).toBe("translate3d(10px, 20px, 0)");

    Object.defineProperty(window, "scrollX", { configurable: true, value: 4 });
    Object.defineProperty(window, "scrollY", { configurable: true, value: 6 });
    controller.apply(snapshot(2, { inverted: true }));
    paint();
    expect(overlay.style.filter).toBe("invert(1)");
    expect(overlay.style.transform).toBe("translate3d(6px, 14px, 0)");
  });

  it("coalesces repaints, handles fit width and visibility without losing its image", () => {
    Object.defineProperty(window, "innerWidth", {
      configurable: true,
      value: 777,
    });
    controller.hydrate(hydration());
    controller.apply(
      snapshot(2, { sizing: { kind: "fit-width", lastScalePercent: 100 } }),
    );
    expect(frame).toBeDefined();
    paint();
    expect(image().style.width).toBe("777px");

    controller.apply(snapshot(3, { visible: false }));
    paint();
    expect(
      document.querySelector("#pixel-pincher-overlay")?.getAttribute("style"),
    ).toContain("display: none");
    controller.apply(snapshot(4));
    paint();
    expect(image().getAttribute("src")).toBe(dataUrl);
  });

  it("ignores stale snapshots and stale image errors, but permits equal revisions", () => {
    controller.hydrate(hydration(3));
    paint();
    const staleImage = image();
    controller.clear(4);
    paint();
    staleImage.dispatchEvent(new Event("error"));
    expect(failures).not.toHaveBeenCalled();

    controller.apply(snapshot(3, { opacity: 0 }));
    expect(frame).toBeUndefined();
    controller.hydrate(hydration(4));
    paint();
    controller.apply(snapshot(4, { opacity: 1 }));
    paint();
    expect(image().style.opacity).toBe("1");
  });

  it("commits one rounded document-space placement for an image-only drag and cancels with Escape", () => {
    controller.hydrate(hydration());
    controller.apply(snapshot(2, { interactionMode: "drag" }));
    paint();
    const overlay = image();
    Object.defineProperties(overlay, {
      hasPointerCapture: { configurable: true, value: vi.fn(() => false) },
      releasePointerCapture: { configurable: true, value: vi.fn() },
      setPointerCapture: { configurable: true, value: vi.fn() },
    });
    overlay.dispatchEvent(
      pointer("pointerdown", { pointerId: 1, clientX: 10, clientY: 20 }),
    );
    overlay.dispatchEvent(
      pointer("pointermove", { pointerId: 1, clientX: 13.6, clientY: 15.2 }),
    );
    overlay.dispatchEvent(
      pointer("pointerup", { pointerId: 1, clientX: 13.6, clientY: 15.2 }),
    );
    expect(commits).toHaveBeenCalledWith({ x: 14, y: 15 });

    overlay.dispatchEvent(
      pointer("pointerdown", { pointerId: 2, clientX: 0, clientY: 0 }),
    );
    overlay.dispatchEvent(
      pointer("pointermove", { pointerId: 2, clientX: 40, clientY: 40 }),
    );
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
    expect(commits).toHaveBeenCalledTimes(1);
  });

  it("removes listeners, cancels a pending frame, and removes the host when destroyed", () => {
    const cancel = vi.fn();
    controller.destroy();
    controller.destroy();
    expect(document.querySelector("#pixel-pincher-overlay")).toBeNull();
    expect(cancel).not.toHaveBeenCalled();
  });
});
