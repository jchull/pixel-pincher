import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ControlPanel } from "../../src/content/control-panel";
import {
  publicError,
  type ContentPanelRequest,
  type OverlaySnapshot,
} from "../../src/shared/contracts";
import {
  parseImportedReference,
  parseOverlaySnapshot,
} from "../../src/shared/parse";

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

function deferred<T>(): Readonly<{
  promise: Promise<T>;
  resolve: (value: T) => void;
}> {
  let complete: ((value: T) => void) | undefined;
  const promise = new Promise<T>((resolve) => {
    complete = resolve;
  });
  return {
    promise,
    resolve(value: T): void {
      if (complete === undefined) throw new Error("Deferred promise is not ready.");
      complete(value);
    },
  };
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

  afterEach(() => {
    panel.destroy();
  });

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

  it("renders hydrated reference metadata and visibility in an isolated closed shadow panel", async () => {
    panel.apply(snapshot(1));
    const host = document.querySelector<HTMLElement>(
      "#pixel-pincher-control-panel",
    );
    expect(host?.shadowRoot).toBeNull();
    expect(host?.style.left).toBe("20px");
    expect(host?.style.top).toBe("30px");
    expect(
      elements.some((element) => element.classList.contains("reference")),
    ).toBe(false);
    expect(
      elements.some((element) => element.classList.contains("visibility")),
    ).toBe(false);
    expect(
      elements
        .find((element) => element.getAttribute("role") === "status")
        ?.getAttribute("aria-live"),
    ).toBe("polite");
    expect(buttons.some((button) => button.id.startsWith("move-"))).toBe(false);
    expect(buttons.some((button) => button.id === "reset-scale")).toBe(false);
    const hideToggle = elements.find(
      (element) => element.id === "overlay-hide",
    );
    if (!(hideToggle instanceof HTMLButtonElement))
      throw new Error("Expected overlay hide toggle.");
    expect(hideToggle.getAttribute("aria-pressed")).toBe("false");
    expect(hideToggle.textContent).toBe("Hide");
    expect(hideToggle.querySelector("svg")).not.toBeNull();
    const lockToggle = elements.find(
      (element) => element.id === "overlay-lock",
    );
    if (!(lockToggle instanceof HTMLButtonElement))
      throw new Error("Expected overlay lock toggle.");
    expect(lockToggle.getAttribute("aria-pressed")).toBe("true");
    expect(lockToggle.textContent).toBe("Unlock");
    expect(lockToggle.querySelector("svg")).not.toBeNull();
    expect(
      elements.some((element) => element.classList.contains("position-inputs")),
    ).toBe(true);
    const close = buttons.find((button) => button.id === "close-panel");
    if (close === undefined) throw new Error("Expected close button.");
    const collapse = buttons.find((button) => button.id === "collapse-panel");
    if (collapse === undefined) throw new Error("Expected collapse button.");
    expect(collapse.getAttribute("aria-expanded")).toBe("true");
    collapse.click();
    expect(collapse.getAttribute("aria-expanded")).toBe("false");
    expect(
      elements.find((element) => element.classList.contains("panel"))
        ?.classList,
    ).toContain("collapsed");
    close.click();
    await vi.waitFor(() => expect(host?.style.display).toBe("none"));
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
    expect(dragHandle.classList).toContain("dragging");
    dragHandle.dispatchEvent(
      pointer("pointermove", { pointerId: 1, clientX: 60, clientY: 40 }),
    );
    dragHandle.dispatchEvent(
      pointer("pointerup", { pointerId: 1, clientX: 60, clientY: 40 }),
    );
    expect(commits).toHaveBeenLastCalledWith({ x: 70, y: 60 });
    expect(dragHandle.classList).not.toContain("dragging");

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
    const dropTarget = byId<HTMLElement>("reference-drop-target");
    const uploadImage = byId<HTMLAnchorElement>("upload-image");
    expect(uploadImage.parentElement?.className).toBe("upload-line");
    const pickFile = vi.spyOn(file, "click");
    uploadImage.click();
    expect(pickFile).toHaveBeenCalledOnce();
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
    await vi.waitFor(() =>
      expect(dropTarget.style.getPropertyValue("--reference-image")).toBe(
        `url("${dataUrl}")`,
      ),
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
    const opacityNumber = byId<HTMLInputElement>("opacity-number");
    opacity.value = "65";
    opacity.dispatchEvent(new Event("input"));
    expect(opacityNumber.value).toBe("65");
    opacityNumber.value = "55";
    opacityNumber.dispatchEvent(new Event("input"));
    expect(opacity.value).toBe("55");
    await vi.waitFor(() =>
      expect(send).toHaveBeenLastCalledWith(
        expect.objectContaining({
          kind: "update-settings",
          patch: { kind: "opacity", opacity: 0.55 },
        }),
      ),
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
    byId<HTMLButtonElement>("overlay-hide").click();
    byId<HTMLInputElement>("fit-width").click();
    byId<HTMLInputElement>("inverted").click();
    byId<HTMLButtonElement>("overlay-lock").click();
    const x = byId<HTMLInputElement>("x");
    x.value = "12";
    x.dispatchEvent(new Event("input"));
    await vi.waitFor(() =>
      expect(send).toHaveBeenCalledWith(
        expect.objectContaining({
          kind: "update-settings",
          patch: { kind: "placement", placement: { x: 12, y: 20 } },
        }),
      ),
    );
    const clear = byId<HTMLButtonElement>("clear-site");
    clear.click();
    expect(clear.textContent).toContain("Confirm");
    clear.click();
    await vi.waitFor(() =>
      expect(send).toHaveBeenCalledWith(
        expect.objectContaining({ kind: "clear-site" }),
      ),
    );
    const dropped = new File(["drop"], "dropped.png", { type: "image/png" });
    const drop = new Event("drop", { bubbles: true, cancelable: true });
    Object.defineProperty(drop, "dataTransfer", {
      value: { files: [dropped] },
    });
    dropTarget.dispatchEvent(drop);
    await vi.waitFor(() => expect(importer).toHaveBeenCalledTimes(2));
    const pasted = new File(["paste"], "pasted.png", { type: "image/png" });
    const paste = new Event("paste", { bubbles: true, cancelable: true });
    Object.defineProperty(paste, "clipboardData", {
      value: { files: [pasted] },
    });
    dropTarget.dispatchEvent(paste);
    await vi.waitFor(() => expect(importer).toHaveBeenCalledTimes(3));
    const fetch = vi.spyOn(globalThis, "fetch").mockImplementation(
      async () =>
        new Response(new Uint8Array([1, 2, 3]), {
          headers: { "content-type": "image/png" },
        }),
    );
    const referenceUrl = byId<HTMLInputElement>("reference-url");
    const importUrl = byId<HTMLButtonElement>("import-url");
    referenceUrl.value = "data:image/png;base64,AQID";
    importUrl.click();
    await vi.waitFor(() => expect(fetch).toHaveBeenCalledOnce());
    expect(fetch).toHaveBeenCalledWith(expect.any(URL), {
      credentials: "omit",
      referrerPolicy: "no-referrer",
    });
    await vi.waitFor(() => expect(importer).toHaveBeenCalledTimes(4));
    referenceUrl.value = "data:image/png;base64,AQID";
    referenceUrl.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter" }));
    await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(2));
    await vi.waitFor(() => expect(importer).toHaveBeenCalledTimes(5));
  });

  it("redacts URL credentials and path details from import diagnostics", async () => {
    const fetch = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("failed"));
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const referenceUrl = elements.find((element) => element.id === "reference-url");
    const importUrl = buttons.find((button) => button.id === "import-url");
    if (!(referenceUrl instanceof HTMLInputElement) || importUrl === undefined)
      throw new Error("Expected URL import controls.");
    const sensitiveUrl =
      "https://user:password@example.test/private/image.png?token=secret#fragment";
    referenceUrl.value = sensitiveUrl;
    importUrl.click();

    await vi.waitFor(() => expect(fetch).toHaveBeenCalledOnce());
    await vi.waitFor(() => expect(error).toHaveBeenCalledOnce());
    expect(error).toHaveBeenCalledWith(
      "[Pixel Pincher] Could not load an image URL.",
      { source: "https://example.test" },
    );
    expect(JSON.stringify(error.mock.calls)).not.toContain(sensitiveUrl);
    expect(JSON.stringify(error.mock.calls)).not.toContain("password");
    expect(JSON.stringify(error.mock.calls)).not.toContain("token=secret");
  });

  it("preserves X and Y placement intent across deferred mutations", async () => {
    const first = deferred<unknown>();
    const second = deferred<unknown>();
    const requests: ContentPanelRequest[] = [];
    const send = vi.fn((request: ContentPanelRequest): Promise<unknown> => {
      requests.push(request);
      return requests.length === 1 ? first.promise : second.promise;
    });
    panel.destroy();
    panel = new ControlPanel({ window, document, request: send });
    panel.apply(snapshot(1));
    const input = (id: string): HTMLInputElement => {
      const found = [...elements].reverse().find((element) => element.id === id);
      if (!(found instanceof HTMLInputElement)) throw new Error(`Expected ${id}.`);
      return found;
    };
    const x = input("x");
    const y = input("y");

    x.value = "12";
    x.dispatchEvent(new Event("input"));
    await vi.waitFor(() => expect(requests).toHaveLength(1));
    y.value = "30";
    y.dispatchEvent(new Event("input"));
    expect(requests).toHaveLength(1);
    const firstRequest = requests[0];
    if (firstRequest === undefined || firstRequest.kind !== "update-settings")
      throw new Error("Expected the first settings mutation.");
    expect(firstRequest.patch).toEqual({
      kind: "placement",
      placement: { x: 12, y: 20 },
    });

    first.resolve({
      requestId: firstRequest.requestId,
      ok: true,
      value: snapshot(2, undefined, { placement: { x: 12, y: 20 } }),
    });
    await vi.waitFor(() => expect(requests).toHaveLength(2));
    const secondRequest = requests[1];
    if (secondRequest === undefined || secondRequest.kind !== "update-settings")
      throw new Error("Expected the queued settings mutation.");
    expect(secondRequest.patch).toEqual({
      kind: "placement",
      placement: { x: 12, y: 30 },
    });

    second.resolve({
      requestId: secondRequest.requestId,
      ok: true,
      value: snapshot(3, undefined, { placement: { x: 12, y: 30 } }),
    });
    await vi.waitFor(() => {
      expect(x.value).toBe("12");
      expect(y.value).toBe("30");
    });
  });

  it("stops queued mutations and restores confirmed controls after a failure", async () => {
    const first = deferred<unknown>();
    const requests: ContentPanelRequest[] = [];
    const send = vi.fn((request: ContentPanelRequest): Promise<unknown> => {
      requests.push(request);
      return first.promise;
    });
    panel.destroy();
    panel = new ControlPanel({ window, document, request: send });
    panel.apply(snapshot(1));
    const input = (id: string): HTMLInputElement => {
      const found = [...elements].reverse().find((element) => element.id === id);
      if (!(found instanceof HTMLInputElement)) throw new Error(`Expected ${id}.`);
      return found;
    };
    const x = input("x");
    const y = input("y");

    x.value = "12";
    x.dispatchEvent(new Event("input"));
    await vi.waitFor(() => expect(requests).toHaveLength(1));
    y.value = "30";
    y.dispatchEvent(new Event("input"));
    const firstRequest = requests[0];
    if (firstRequest === undefined) throw new Error("Expected a settings mutation.");
    first.resolve({
      requestId: firstRequest.requestId,
      ok: false,
      error: publicError("content-unavailable"),
    });

    await vi.waitFor(() => {
      expect(x.value).toBe("10");
      expect(y.value).toBe("20");
    });
    expect(send).toHaveBeenCalledTimes(1);
    expect(
      [...elements]
        .reverse()
        .find((element) => element.getAttribute("role") === "status")
        ?.textContent,
    ).toBe(publicError("content-unavailable").message);
  });

  it("does not preview a replacement that the background rejects", async () => {
    const oldDataUrl = "data:image/png;base64,AAAA";
    const newDataUrl = "data:image/png;base64,AQID";
    const imported = parse(
      parseImportedReference({
        metadata: { ...metadata, encodedBytes: newDataUrl.length },
        dataUrl: newDataUrl,
      }),
    );
    const send = vi.fn(async (request: { requestId: string }) => ({
      requestId: request.requestId,
      ok: false as const,
      error: publicError("storage-failed"),
    }));
    const importer = vi.fn(async () => ({ ok: true as const, value: imported }));
    panel.destroy();
    panel = new ControlPanel({
      window,
      document,
      request: send,
      importReference: importer,
    });
    const currentSnapshot = snapshot(1);
    if (currentSnapshot.reference === null)
      throw new Error("Expected a reference snapshot.");
    panel.hydrate({
      snapshot: { ...currentSnapshot, reference: imported.metadata },
      reference: { ...imported, dataUrl: oldDataUrl },
    });
    const file = [...elements]
      .reverse()
      .find((element) => element.id === "reference-file");
    const dropTarget = [...elements]
      .reverse()
      .find((element) => element.id === "reference-drop-target");
    if (!(file instanceof HTMLInputElement) || !(dropTarget instanceof HTMLElement))
      throw new Error("Expected import controls.");
    Object.defineProperty(file, "files", {
      configurable: true,
      value: [new File(["new"], "replacement.png", { type: "image/png" })],
    });

    file.dispatchEvent(new Event("change"));
    await vi.waitFor(() => expect(send).toHaveBeenCalledOnce());
    expect(dropTarget.style.getPropertyValue("--reference-image")).toBe(
      `url("${oldDataUrl}")`,
    );
    expect(
      [...elements]
        .reverse()
        .find((element) => element.getAttribute("role") === "status")
        ?.textContent,
    ).toBe(publicError("storage-failed").message);
  });

  it("keeps the panel visible when hiding the overlay fails", async () => {
    const send = vi.fn(async (request: { requestId: string }) => ({
      requestId: request.requestId,
      ok: false as const,
      error: publicError("content-unavailable"),
    }));
    panel.destroy();
    panel = new ControlPanel({ window, document, request: send });
    panel.apply(snapshot(1));
    const host = document.querySelector<HTMLElement>(
      "#pixel-pincher-control-panel",
    );
    const close = [...buttons].reverse().find((button) => button.id === "close-panel");
    if (host === null || close === undefined) throw new Error("Expected panel.");

    close.click();
    await vi.waitFor(() => expect(send).toHaveBeenCalledOnce());
    expect(host.style.display).toBe("block");
    expect(send).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: "update-settings",
        patch: { kind: "visibility", visible: false },
      }),
    );
    expect(
      [...elements]
        .reverse()
        .find((element) => element.getAttribute("role") === "status")
        ?.textContent,
    ).toBe(publicError("content-unavailable").message);
  });

  it("removes global listeners, clears queued mutations, and is safe to destroy twice", async () => {
    const first = deferred<unknown>();
    const requests: ContentPanelRequest[] = [];
    const send = vi.fn((request: ContentPanelRequest): Promise<unknown> => {
      requests.push(request);
      return first.promise;
    });
    panel.destroy();
    panel = new ControlPanel({ window, document, request: send });
    panel.apply(snapshot(1));
    const host = document.querySelector<HTMLElement>(
      "#pixel-pincher-control-panel",
    );
    const x = [...elements]
      .reverse()
      .find((element) => element.id === "x");
    const y = [...elements]
      .reverse()
      .find((element) => element.id === "y");
    if (host === null || !(x instanceof HTMLInputElement) || !(y instanceof HTMLInputElement))
      throw new Error("Expected panel controls.");
    x.value = "12";
    x.dispatchEvent(new Event("input"));
    await vi.waitFor(() => expect(requests).toHaveLength(1));
    y.value = "30";
    y.dispatchEvent(new Event("input"));
    const leftBeforeDestroy = host.style.left;

    panel.destroy();
    panel.destroy();
    Object.defineProperty(window, "innerWidth", {
      configurable: true,
      value: 10,
    });
    window.dispatchEvent(new Event("resize"));
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
    expect(host.style.left).toBe(leftBeforeDestroy);

    const request = requests[0];
    if (request === undefined) throw new Error("Expected queued mutation.");
    first.resolve({ requestId: request.requestId, ok: true, value: snapshot(2) });
    await Promise.resolve();
    await Promise.resolve();
    expect(requests).toHaveLength(1);
  });

  it("clamps persisted positions to keep its handle reachable", () => {
    panel.apply(snapshot(1, { x: 999, y: 999 }, { visible: false }));
    const host = document.querySelector<HTMLElement>(
      "#pixel-pincher-control-panel",
    );
    expect(host?.style.left).toBe("352px");
    expect(host?.style.top).toBe("260px");
    const hideOverlay = elements.find(
      (element) => element.id === "overlay-hide",
    );
    if (!(hideOverlay instanceof HTMLButtonElement))
      throw new Error("Expected overlay hide toggle.");
    expect(hideOverlay.getAttribute("aria-pressed")).toBe("true");
    expect(hideOverlay.textContent).toBe("Show");
  });
});
