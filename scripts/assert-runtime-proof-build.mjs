import { access, readFile } from "node:fs/promises";
import { join } from "node:path";

const outputDirectory = "dist/chrome-mv3";
const runtimeProofAssetPath = "content-scripts/runtime-proof.js";
const manifestPath = join(outputDirectory, "manifest.json");

let manifestText;
try {
  manifestText = await readFile(manifestPath, "utf8");
} catch (error) {
  throw new Error(`Could not read generated manifest at ${manifestPath}.`, {
    cause: error,
  });
}

let manifest;
try {
  manifest = JSON.parse(manifestText);
} catch (error) {
  throw new Error(`Generated manifest at ${manifestPath} is not valid JSON.`, {
    cause: error,
  });
}

if (
  Array.isArray(manifest.content_scripts) &&
  manifest.content_scripts.length > 0
) {
  throw new Error(
    "Runtime proof must not create a static manifest content script.",
  );
}

if (
  Array.isArray(manifest.host_permissions) &&
  manifest.host_permissions.length > 0
) {
  throw new Error(
    "Runtime proof must not create broad required host permissions.",
  );
}

await access(join(outputDirectory, runtimeProofAssetPath));
