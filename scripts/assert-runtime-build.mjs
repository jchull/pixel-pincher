import { access, readFile } from "node:fs/promises";
import { join, normalize, relative } from "node:path";

const outputDirectory = "dist/chrome-mv3";
const manifestPath = join(outputDirectory, "manifest.json");
const packagePath = "package.json";
const runtimeOverlayPath = "content-scripts/overlay.js";
const expectedPermissions = [
  "activeTab",
  "scripting",
  "storage",
  "unlimitedStorage",
  "webNavigation",
];
const expectedOptionalOrigins = ["http://*/*", "https://*/*"];
const iconSizes = ["16", "32", "48", "128"];

async function readJson(path, description) {
  let text;
  try {
    text = await readFile(path, "utf8");
  } catch (error) {
    throw new Error(`Could not read ${description} at ${path}.`, { cause: error });
  }

  try {
    return JSON.parse(text);
  } catch (error) {
    throw new Error(`${description} at ${path} is not valid JSON.`, { cause: error });
  }
}

async function assertPackageAsset(asset, description) {
  if (typeof asset !== "string" || asset.length === 0) {
    throw new Error(`${description} must name a generated package asset.`);
  }

  const normalizedAsset = normalize(asset.replace(/^\/+/, ""));
  if (normalizedAsset === ".." || normalizedAsset.startsWith(`..${"/"}`)) {
    throw new Error(`${description} must remain inside the generated package.`);
  }

  const assetPath = join(outputDirectory, normalizedAsset);
  if (relative(outputDirectory, assetPath).startsWith("..")) {
    throw new Error(`${description} must remain inside the generated package.`);
  }

  try {
    await access(assetPath);
  } catch (error) {
    throw new Error(`${description} is missing from the generated package: ${asset}.`, {
      cause: error,
    });
  }
}

function hasExactStrings(value, expected) {
  return Array.isArray(value) && value.length === expected.length &&
    [...value].sort().every((item, index) => item === [...expected].sort()[index]);
}

function popupAssetReferences(html) {
  const references = [];
  const attributePattern = /\b(?:src|href)\s*=\s*(?:"([^"]+)"|'([^']+)'|([^\s>]+))/gi;

  for (const match of html.matchAll(attributePattern)) {
    const reference = match[1] ?? match[2] ?? match[3];
    if (reference !== undefined && !reference.startsWith("#")) {
      references.push(reference);
    }
  }

  return references;
}

function popupAssetPath(reference) {
  if (/^[a-z][a-z0-9+.-]*:/i.test(reference) || reference.startsWith("//")) {
    throw new Error(`Popup HTML must not reference an external asset: ${reference}.`);
  }

  return reference.split(/[?#]/, 1)[0];
}

const packageJson = await readJson(packagePath, "package metadata");
const manifest = await readJson(manifestPath, "generated manifest");

if (typeof packageJson.version !== "string") {
  throw new Error("Package metadata must declare a string version.");
}

if (typeof manifest !== "object" || manifest === null || Array.isArray(manifest)) {
  throw new Error("Generated manifest must be an object.");
}

if (manifest.version !== packageJson.version) {
  throw new Error(
    `Package and generated manifest versions must match: ${packageJson.version} !== ${String(manifest.version)}.`,
  );
}

if (Array.isArray(manifest.content_scripts) && manifest.content_scripts.length > 0) {
  throw new Error("Runtime overlay must not create a static manifest content script.");
}

if (Array.isArray(manifest.host_permissions) && manifest.host_permissions.length > 0) {
  throw new Error("Runtime overlay must not create broad required host permissions.");
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

await assertPackageAsset(manifest.background?.service_worker, "Manifest service worker");
await assertPackageAsset(runtimeOverlayPath, "Runtime overlay");

if (typeof manifest.action?.default_popup !== "string") {
  throw new Error("Manifest must declare a popup HTML asset.");
}

const popupPath = manifest.action.default_popup;
await assertPackageAsset(popupPath, "Popup HTML");
const popupHtml = await readFile(join(outputDirectory, popupPath), "utf8");
for (const reference of popupAssetReferences(popupHtml)) {
  await assertPackageAsset(popupAssetPath(reference), `Popup asset referenced by ${popupPath}`);
}

if (typeof manifest.icons !== "object" || manifest.icons === null) {
  throw new Error("Manifest must declare 16, 32, 48, and 128 pixel icons.");
}

for (const size of iconSizes) {
  await assertPackageAsset(manifest.icons[size], `${size} pixel icon`);
}
