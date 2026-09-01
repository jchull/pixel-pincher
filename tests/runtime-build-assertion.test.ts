import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { describe, expect, it } from "vitest";

const assertionScript = resolve("scripts/assert-runtime-build.mjs");

type FixtureOptions = Readonly<{
  manifestVersion?: string;
  minimumChromeVersion?: string;
  omitPopupAsset?: boolean;
}>;

async function createFixture(options: FixtureOptions = {}) {
  const directory = await mkdtemp(join(tmpdir(), "pixel-pincher-runtime-build-"));
  const manifestVersion = options.manifestVersion ?? "0.1.0";
  const minimumChromeVersion = options.minimumChromeVersion ?? "130";
  const files = [
    ["package.json", JSON.stringify({ version: "0.1.0" })],
    [
      "dist/chrome-mv3/manifest.json",
      JSON.stringify({
        version: manifestVersion,
        minimum_chrome_version: minimumChromeVersion,
        permissions: ["activeTab", "scripting", "storage", "unlimitedStorage", "webNavigation"],
        optional_host_permissions: ["http://*/*", "https://*/*"],
        incognito: "not_allowed",
        background: { service_worker: "background.js" },
        action: { default_popup: "popup.html" },
        icons: {
          16: "icon/16.png",
          32: "icon/32.png",
          48: "icon/48.png",
          128: "icon/128.png",
        },
      }),
    ],
    ["dist/chrome-mv3/popup.html", '<script src="assets/popup.js"></script>'],
    ["dist/chrome-mv3/background.js", ""],
    ["dist/chrome-mv3/content-scripts/overlay.js", ""],
    ["dist/chrome-mv3/icon/16.png", ""],
    ["dist/chrome-mv3/icon/32.png", ""],
    ["dist/chrome-mv3/icon/48.png", ""],
    ["dist/chrome-mv3/icon/128.png", ""],
  ];

  if (!options.omitPopupAsset) {
    files.push(["dist/chrome-mv3/assets/popup.js", ""]);
  }

  await Promise.all(
    files.map(async ([path, contents]) => {
      const filePath = join(directory, path);
      await mkdir(dirname(filePath), { recursive: true });
      await writeFile(filePath, contents);
    }),
  );

  return { directory };
}

function runAssertion(directory: string) {
  return spawnSync(process.execPath, [assertionScript], {
    cwd: directory,
    encoding: "utf8",
  });
}

describe("runtime build assertion", () => {
  it("accepts a complete package with matching versions", async () => {
    const { directory } = await createFixture();

    try {
      const result = runAssertion(directory);
      expect(result.status).toBe(0);
      expect(result.stderr).toBe("");
    } finally {
      await rm(directory, { force: true, recursive: true });
    }
  });

  it("reports version drift deterministically", async () => {
    const { directory } = await createFixture({ manifestVersion: "0.1.1" });

    try {
      const result = runAssertion(directory);
      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain(
        "Package and generated manifest versions must match: 0.1.0 !== 0.1.1.",
      );
    } finally {
      await rm(directory, { force: true, recursive: true });
    }
  });

  it("reports a minimum Chrome version below the supported floor deterministically", async () => {
    const { directory } = await createFixture({ minimumChromeVersion: "129" });

    try {
      const result = runAssertion(directory);
      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain("Manifest minimum_chrome_version must be 130.");
    } finally {
      await rm(directory, { force: true, recursive: true });
    }
  });

  it("reports a missing popup asset deterministically", async () => {
    const { directory } = await createFixture({ omitPopupAsset: true });

    try {
      const result = runAssertion(directory);
      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain(
        "Popup asset referenced by popup.html is missing from the generated package: assets/popup.js.",
      );
    } finally {
      await rm(directory, { force: true, recursive: true });
    }
  });
});
