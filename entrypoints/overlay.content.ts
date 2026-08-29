import { defineContentScript } from "wxt/utils/define-content-script";

import { OverlayController } from "../src/content/overlay-controller";
import type { ContentEvent } from "../src/shared/contracts";
import { parseContentRequest } from "../src/shared/parse";

const controllerKey = Symbol.for("pixel-pincher.overlay-controller");

type ContentWindow = Window & { [controllerKey]?: OverlayController };

export function startOverlayContent(
  contentWindow: ContentWindow = window,
): OverlayController {
  const existing = contentWindow[controllerKey];
  if (existing !== undefined) return existing;

  const send = (event: ContentEvent): void => {
    void chrome.runtime.sendMessage(event).catch(() => undefined);
  };
  const controller = new OverlayController({
    window: contentWindow,
    document: contentWindow.document,
    requestAnimationFrame:
      contentWindow.requestAnimationFrame.bind(contentWindow),
    cancelAnimationFrame:
      contentWindow.cancelAnimationFrame.bind(contentWindow),
    onPlacementCommitted: (placement) =>
      send({
        kind: "placement-committed",
        url: contentWindow.location.href,
        placement,
      }),
    onImageLoadFailed: (referenceId) =>
      send({
        kind: "image-load-failed",
        url: contentWindow.location.href,
        referenceId,
      }),
  });
  contentWindow[controllerKey] = controller;
  chrome.runtime.onMessage.addListener((message: unknown) => {
    const request = parseContentRequest(message);
    if (!request.ok) return;
    switch (request.value.kind) {
      case "hydrate-overlay":
        void controller.hydrate(request.value.hydration);
        return;
      case "apply-settings":
        controller.apply(request.value.snapshot);
        return;
      case "clear-overlay":
        controller.clear(request.value.revision);
    }
  });
  send({ kind: "content-ready", url: contentWindow.location.href });
  return controller;
}

export default defineContentScript({
  allFrames: false,
  registration: "runtime",
  runAt: "document_idle",
  main() {
    startOverlayContent();
  },
});
