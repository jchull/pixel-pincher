import { access, readFile } from "node:fs/promises";
import { join } from "node:path";

const outputDirectory = ".output/chrome-mv3";
const runtimeProofAssetPath = "content-scripts/runtime-proof.js";
const manifestPath = join(outputDirectory, "manifest.json");
const manifest = JSON.parse(await readFile(manifestPath, "utf8"));

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
