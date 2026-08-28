import { describe, expect, it } from "vitest";

import { OverlayRepository } from "../../src/background/repository";
import type { StorageAdapter } from "../../src/background/storage-adapter";
import { parseImportedReference } from "../../src/shared/parse";

class MemoryStorage implements StorageAdapter {
  readonly values: Record<string, unknown> = {};
  readonly reads: string[][] = [];
  readonly writes: Record<string, unknown>[] = [];

  async get(keys: readonly string[]): Promise<Readonly<Record<string, unknown>>> {
    this.reads.push([...keys]);
    return Object.fromEntries(keys.filter((key) => Object.hasOwn(this.values, key)).map((key) => [key, this.values[key]]));
  }
  async set(values: Readonly<Record<string, unknown>>): Promise<void> {
    this.writes.push({ ...values });
    Object.assign(this.values, values);
  }
  async remove(keys: readonly string[]): Promise<void> {
    for (const key of keys) delete this.values[key];
  }
}

const url = new URL("https://example.test/path#fragment");

function reference() {
  const dataUrl = "data:image/png;base64,aGVsbG8=";
  const parsed = parseImportedReference({
    metadata: { id: "123e4567-e89b-42d3-a456-426614174000", name: "reference.png", mimeType: "image/png", width: 1, height: 1, encodedBytes: new TextEncoder().encode(dataUrl).byteLength, importedAt: 1 },
    dataUrl,
  });
  if (!parsed.ok) throw new Error("Test reference must parse.");
  return parsed.value;
}

describe("OverlayRepository", () => {
  it("returns fresh defaults and settings updates never access image keys", async () => {
    const storage = new MemoryStorage();
    const repository = new OverlayRepository(storage);
    const fresh = await repository.getSnapshot(url);
    expect(fresh.ok && fresh.value.settings.opacity).toBe(0.5);
    const changed = await repository.updateSettings(url, { kind: "opacity", opacity: 0.75 });
    expect(changed.ok && changed.value.revision).toBe(1);
    expect([...storage.reads.flat(), ...storage.writes.flatMap((write) => Object.keys(write))].some((key) => key.includes(":image:"))).toBe(false);
  });

  it("hydrates image data only after a reference exists and advances revisions", async () => {
    const storage = new MemoryStorage();
    const repository = new OverlayRepository(storage);
    const replaced = await repository.replaceReference(url, reference());
    expect(replaced.ok && replaced.value.revision).toBe(1);
    const hydration = await repository.hydrate(url);
    expect(hydration.ok && hydration.value.reference?.metadata.name).toBe("reference.png");
  });
});
