import { beforeEach, describe, expect, it } from "vitest";

import {
  readPanelVisibility,
  setPanelVisibility,
} from "../../src/popup/panel-visibility";

const panelId = "pixel-pincher-control-panel";

beforeEach(() => {
  document.getElementById(panelId)?.remove();
});

describe("in-page panel visibility", () => {
  it("distinguishes a not-yet-injected panel from a hidden panel", () => {
    expect(readPanelVisibility()).toBeUndefined();
    expect(setPanelVisibility(true)).toBe(false);

    const panel = document.createElement("pixel-pincher-control-panel");
    panel.id = panelId;
    document.documentElement.append(panel);
    panel.style.display = "none";

    expect(readPanelVisibility()).toBe(false);
    expect(setPanelVisibility(true)).toBe(true);
    expect(readPanelVisibility()).toBe(true);
    expect(panel.getAttribute("aria-hidden")).toBe("false");

    expect(setPanelVisibility(false)).toBe(true);
    expect(readPanelVisibility()).toBe(false);
    expect(panel.getAttribute("aria-hidden")).toBe("true");
  });
});
