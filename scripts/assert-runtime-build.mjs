import { access, readFile } from "node:fs/promises";
import { join } from "node:path";

const outputDirectory = "dist/chrome-mv3";
const manifestPath = join(outputDirectory, "manifest.json");
const assetPath = join(outputDirectory, "content-scripts/overlay.js");

let manifestText;
try {
  manifestText = await readFile(manifestPath, "utf8");
} catch (error) {
  throw new Error(`Could not read generated manifest at ${manifestPath}.`, { cause: error });
}

let manifest;
try {
  manifest = JSON.parse(manifestText);
} catch (error) {
  throw new Error(`Generated manifest at ${manifestPath} is not valid JSON.`, { cause: error });
}

if (Array.isArray(manifest.content_scripts) && manifest.content_scripts.length > 0) {
  throw new Error("Runtime overlay must not create a static manifest content script.");
}

if (Array.isArray(manifest.host_permissions) && manifest.host_permissions.length > 0) {
  throw new Error("Runtime overlay must not create broad required host permissions.");
}

const expectedPermissions = ["activeTab", "scripting", "storage", "unlimitedStorage", "webNavigation"];
const expectedOptionalOrigins = ["http://*/*", "https://*/*"];

function hasExactStrings(value, expected) {
  return Array.isArray(value) && value.length === expected.length &&
    [...value].sort().every((item, index) => item === [...expected].sort()[index]);
}

if (!hasExactStrings(manifest.permissions, expectedPermissions)) {
  throw new Error("Manifest permissions must contain exactly the required runtime permissions.");
}

if (!hasExactStrings(manifest.optional_host_permissions, expectedOptionalOrigins)) {
  throw new Error("Manifest optional host permissions must contain exactly HTTP and HTTPS origins.");
}

if (manifest.incognito !== "not_allowed") {
  throw new Error("Manifest must set incognito to not_allowed.");
}

if (typeof manifest.background?.service_worker !== "string") {
  throw new Error("Manifest must declare a background service-worker asset.");
}

await access(join(outputDirectory, manifest.background.service_worker));
await access(assetPath);
