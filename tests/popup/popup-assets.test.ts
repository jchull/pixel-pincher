import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const projectRoot = join(import.meta.dirname, "..", "..");

function readAsset(path: string): string {
  return readFileSync(join(projectRoot, path), "utf8");
}

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

function expectValidPng(path: string, size: number): void {
  const bytes = readFileSync(join(projectRoot, path));
  expect(Array.from(bytes.subarray(0, 8)), `PNG signature in ${path}`).toEqual(
    PNG_SIGNATURE,
  );
  const view = new DataView(bytes.buffer, bytes.byteOffset);
  expect(view.getUint32(8), `${path} IHDR length`).toBe(13);
  expect(
    String.fromCharCode(...bytes.subarray(12, 16)),
    `${path} IHDR type`,
  ).toBe("IHDR");
  expect(view.getUint32(16), `${path} width`).toBe(size);
  expect(view.getUint32(20), `${path} height`).toBe(size);
  expect(bytes[24], `${path} bit depth`).toBe(8);
  expect(bytes[25], `${path} color type`).toBe(6);
}

describe("extension assets", () => {
  it.each([16, 32, 48, 128])("ships a valid %i pixel RGBA PNG icon", (size) => {
    expectValidPng(join("public", "icon", `${size}.png`), size);
  });

  it("declares a labeled, loading-ready popup document", () => {
    const html = readAsset("entrypoints/popup.html");
    expect(html).toMatch(/<html lang="en">/);
    expect(html).toContain("<title>Pixel Pincher</title>");
    expect(html).toContain('<main id="popup-root">');
    expect(html).toContain("Loading…");
    expect(html).toContain('type="module"');
  });

  it("keeps visible focus, reduced-motion support, and accessible error text in the popup styles", () => {
    const css = readAsset("entrypoints/popup/style.css");
    expect(css).toContain(":focus-visible");
    expect(css).toContain("@media (prefers-reduced-motion: reduce)");
    expect(css).toContain(".error");
    expect(css).toContain(".diagnostic");
    expect(css).not.toMatch(/outline:\s*(none|0)/);
  });

  it("uses grab cursors only when the overlay is draggable", () => {
    const css = readAsset("src/content/overlay.css");
    expect(css).toMatch(/img\.drag-mode\s*\{[^}]*cursor:\s*grab/);
    expect(css).toMatch(/img\.drag-mode:active\s*\{[^}]*cursor:\s*grabbing/);
  });

  it("marks the popup busy while its loading state is rendered", () => {
    const main = readAsset("entrypoints/popup/main.ts");
    expect(main).toContain(
      'root.toggleAttribute("aria-busy", recovery(state).kind === "loading")',
    );
  });

  it("declares the generated icons for the extension and toolbar", () => {
    const config = readAsset("wxt.config.ts");
    for (const size of [16, 32, 48, 128]) {
      expect(config).toContain(`${size}: "/icon/${size}.png"`);
    }
    expect(config).toContain("default_icon");
  });

  it("documents installation, commands, and data behavior in the README", () => {
    const readme = readAsset("README.md");
    expect(readme).toContain("chrome://extensions");
    expect(readme).toContain("Load unpacked");
    expect(readme).toContain("dist/chrome-mv3");
    expect(readme).toContain("Alt+Shift+P");
    expect(readme).toContain("pnpm build");
    expect(readme).toContain("chrome.storage.local");
  });
});
