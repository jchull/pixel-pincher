import { beforeEach, describe, expect, it, vi } from "vitest";

import { ControlPanel } from "../../src/content/control-panel";
import type { OverlaySnapshot } from "../../src/shared/contracts";
import { parseOverlaySnapshotWithPanelPosition } from "../../src/shared/panel-position";
import { parseImportedReference } from "../../src/shared/parse";

const metadata = {
  id: "123e4567-e89b-42d3-a456-426614174000",
  name: "reference.png",
  mimeType: "image/png",
  width: 200,
  height: 100,
  encodedBytes: 4,
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
  panelPosition: Readonly<{ x: number; y: number }> | undefined = {
    x: 20,
    y: 30,
  },
  settings: Record<string, unknown> = {},
): OverlaySnapshot {
  return parse(
    parseOverlaySnapshotWithPanelPosition({
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
      ...(panelPosition === undefined ? {} : { panelPosition }),
    }),
  );
}

function pointer(
  type: string,
  values: Readonly<{
    pointerId: number;
    clientX: number;
    clientY: number;
    button?: number;
  }>,
): Event {
  const event = new Event(type, { bubbles: true, cancelable: true });
  Object.defineProperties(event, {
    pointerId: { value: values.pointerId },
    clientX: { value: values.clientX },
    clientY: { value: values.clientY },
    button: { value: values.button ?? 0 },
  });
  return event;
}

describe("ControlPanel", () => {
  let panel: ControlPanel;
  let commits: ReturnType<typeof vi.fn>;
  let buttons: HTMLButtonElement[];
  let elements: HTMLElement[];

  const handle = (): HTMLButtonElement => {
    const found = buttons.find((button) => button.classList.contains("handle"));
    if (found === undefined) throw new Error("Expected drag handle.");
    return found;
  };

  beforeEach(() => {
    document.getElementById("pixel-pincher-control-panel")?.remove();
    document.body.replaceChildren();
    buttons = [];
    elements = [];
    const createElement = document.createElement.bind(document);
    vi.spyOn(document, "createElement").mockImplementation(
      (tagName: string) => {
        const created = createElement(tagName);
        if (created instanceof HTMLButtonElement) buttons.push(created);
        if (created instanceof HTMLElement) elements.push(created);
        return created;
      },
    );
    Object.defineProperty(window, "innerWidth", {
      configurable: true,
      value: 400,
    });
    Object.defineProperty(window, "innerHeight", {
      configurable: true,
      value: 300,
    });
    commits = vi.fn();
    panel = new ControlPanel({
      window,
      document,
      onPositionCommitted: commits,
    });
  });

  it("renders hydrated reference metadata and visibility in an isolated closed shadow panel", () => {
    panel.apply(snapshot(1));
    const host = document.querySelector<HTMLElement>(
      "#pixel-pincher-control-panel",
    );
    expect(host?.shadowRoot).toBeNull();
    expect(host?.style.left).toBe("20px");
    expect(host?.style.top).toBe("30px");
    expect(
      elements.find((element) => element.classList.contains("reference"))
        ?.textContent,
    ).toBe("reference.png · 200 × 100");
    expect(
      elements.find((element) => element.classList.contains("visibility"))
        ?.textContent,
    ).toContain("Overlay visible");
    expect(
      elements
        .find((element) => element.getAttribute("role") === "status")
        ?.getAttribute("aria-live"),
    ).toBe("polite");
    expect(buttons.some((button) => button.id.startsWith("move-"))).toBe(false);
    expect(buttons.some((button) => button.id === "reset-scale")).toBe(false);
  });

  it("moves only from its dedicated handle, persists on pointer-up and lost capture, and cancels on Escape", () => {
    panel.apply(snapshot(1));
    const dragHandle = handle();
    Object.defineProperties(dragHandle, {
      hasPointerCapture: { configurable: true, value: vi.fn(() => false) },
      releasePointerCapture: { configurable: true, value: vi.fn() },
      setPointerCapture: { configurable: true, value: vi.fn() },
    });

    dragHandle.dispatchEvent(
      pointer("pointerdown", { pointerId: 1, clientX: 10, clientY: 10 }),
    );
    dragHandle.dispatchEvent(
      pointer("pointermove", { pointerId: 1, clientX: 60, clientY: 40 }),
    );
    dragHandle.dispatchEvent(
      pointer("pointerup", { pointerId: 1, clientX: 60, clientY: 40 }),
    );
    expect(commits).toHaveBeenLastCalledWith({ x: 70, y: 60 });

    dragHandle.dispatchEvent(
      pointer("pointerdown", { pointerId: 2, clientX: 0, clientY: 0 }),
    );
    dragHandle.dispatchEvent(
      pointer("pointermove", { pointerId: 2, clientX: 10, clientY: 10 }),
    );
    dragHandle.dispatchEvent(
      pointer("lostpointercapture", { pointerId: 2, clientX: 10, clientY: 10 }),
    );
    expect(commits).toHaveBeenLastCalledWith({ x: 80, y: 70 });

    dragHandle.dispatchEvent(
      pointer("pointerdown", { pointerId: 3, clientX: 0, clientY: 0 }),
    );
    dragHandle.dispatchEvent(
      pointer("pointermove", { pointerId: 3, clientX: 100, clientY: 100 }),
    );
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
    expect(commits).toHaveBeenCalledTimes(2);
    expect(
      document.querySelector<HTMLElement>("#pixel-pincher-control-panel")?.style
        .left,
    ).toBe("80px");
  });

  it("sends correlated panel mutations for the complete enabled-site surface and coalesces opacity", async () => {
    const send = vi.fn(async (request: { requestId: string }) => ({
      requestId: request.requestId,
      ok: true,
      value: snapshot(2),
    }));
    const dataUrl = "data:image/png;base64,AQID";
    const imported = parse(
      parseImportedReference({
        metadata: { ...metadata, encodedBytes: dataUrl.length },
        dataUrl,
      }),
    );
    const importer = vi.fn(async () => ({
      ok: true as const,
      value: imported,
    }));
    panel.destroy();
    panel = new ControlPanel({
      window,
      document,
      request: send,
      importReference: importer,
    });
    panel.apply(snapshot(1));
    const byId = <T extends HTMLElement>(id: string): T => {
      const found = [...elements]
        .reverse()
        .find((element) => element.id === id);
      if (found === undefined) throw new Error(`Expected ${id}.`);
      return found as T;
    };
    const file = byId<HTMLInputElement>("reference-file");
    Object.defineProperty(file, "files", {
      configurable: true,
      value: [new File(["x"], "reference.png", { type: "image/png" })],
    });
    file.dispatchEvent(new Event("change"));
    await vi.waitFor(() => expect(importer).toHaveBeenCalledOnce());
    expect(send).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: "replace-reference",
        reference: imported,
      }),
    );
    const opacity = byId<HTMLInputElement>("opacity");
    opacity.value = "30";
    opacity.dispatchEvent(new Event("input"));
    opacity.value = "40";
    opacity.dispatchEvent(new Event("input"));
    await vi.waitFor(() => expect(send).toHaveBeenCalledTimes(3));
    expect(send).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        kind: "update-settings",
        patch: { kind: "opacity", opacity: 0.3 },
      }),
    );
    expect(send).toHaveBeenLastCalledWith(
      expect.objectContaining({
        kind: "update-settings",
        patch: { kind: "opacity", opacity: 0.4 },
      }),
    );
    const scale = byId<HTMLInputElement>("scale");
    const scaleNumber = byId<HTMLInputElement>("scale-number");
    scale.value = "125";
    scale.dispatchEvent(new Event("input"));
    expect(scaleNumber.value).toBe("125");
    scaleNumber.value = "150";
    scaleNumber.dispatchEvent(new Event("input"));
    expect(scale.value).toBe("150");
    await vi.waitFor(() =>
      expect(send).toHaveBeenLastCalledWith(
        expect.objectContaining({
          kind: "update-settings",
          patch: { kind: "sizing", sizing: { kind: "scale", percent: 150 } },
        }),
      ),
    );
    byId<HTMLInputElement>("visible").click();
    byId<HTMLInputElement>("fit-width").click();
    byId<HTMLInputElement>("inverted").click();
    byId<HTMLInputElement>("interaction-drag").click();
    const x = byId<HTMLInputElement>("x");
    x.value = "12";
    x.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter" }));
    const clear = byId<HTMLButtonElement>("clear-site");
    clear.click();
    expect(clear.textContent).toContain("Confirm");
    clear.click();
    await vi.waitFor(() =>
      expect(send).toHaveBeenCalledWith(
        expect.objectContaining({ kind: "clear-site" }),
      ),
    );
  });

  it("clamps persisted positions to keep its handle reachable", () => {
    panel.apply(snapshot(1, { x: 999, y: 999 }, { visible: false }));
    const host = document.querySelector<HTMLElement>(
      "#pixel-pincher-control-panel",
    );
    expect(host?.style.left).toBe("352px");
    expect(host?.style.top).toBe("260px");
    expect(
      elements.find((element) => element.classList.contains("visibility"))
        ?.textContent,
    ).toContain("Overlay hidden");
  });
});
