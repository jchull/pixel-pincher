import { describe, expect, it } from "vitest";

import { OverlayRepository } from "../../src/background/repository";
import type { StorageAdapter } from "../../src/background/storage-adapter";
import {
  deriveOrigin,
  derivePageKey,
  imageRecordKey,
  ORIGIN_INDEX_KEY,
  pageRecordKey,
} from "../../src/shared/keys";
import { parseImportedReference } from "../../src/shared/parse";

class MemoryStorage implements StorageAdapter {
  readonly values: Record<string, unknown> = {};
  readonly reads: string[][] = [];
  readonly writes: Record<string, unknown>[] = [];
  readonly removes: string[][] = [];
  readAllCalls = 0;

  async get(keys: readonly string[]): Promise<Readonly<Record<string, unknown>>> {
    this.reads.push([...keys]);
    return Object.fromEntries(keys.filter((key) => Object.hasOwn(this.values, key)).map((key) => [key, this.values[key]]));
  }
  async readAll(): Promise<Readonly<Record<string, unknown>>> {
    this.readAllCalls += 1;
    return { ...this.values };
  }
  async set(values: Readonly<Record<string, unknown>>): Promise<void> {
    this.writes.push({ ...values });
    Object.assign(this.values, values);
  }
  async remove(keys: readonly string[]): Promise<void> {
    this.removes.push([...keys]);
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

  it("clears unknown page values for one origin while preserving unrelated records", async () => {
    const storage = new MemoryStorage();
    const repository = new OverlayRepository(storage);
    const targetUrl = new URL("https://example.test/unknown-page");
    const unrelatedUrl = new URL("https://other.test/page");
    const targetOrigin = deriveOrigin(targetUrl);
    const targetPage = derivePageKey(targetUrl);
    const unrelatedPage = derivePageKey(unrelatedUrl);
    if (targetOrigin === undefined || targetPage === undefined || unrelatedPage === undefined) {
      throw new Error("Known HTTPS URLs must derive storage identities.");
    }

    storage.values[pageRecordKey(targetPage)] = { unexpected: "legacy page value" };
    storage.values[pageRecordKey(unrelatedPage)] = { unrelated: true };
    const cleared = await repository.clearOrigin(targetOrigin);

    expect(cleared).toEqual({ ok: true, value: undefined });
    expect(storage.values[pageRecordKey(targetPage)]).toBeUndefined();
    expect(storage.values[pageRecordKey(unrelatedPage)]).toEqual({ unrelated: true });
    expect(storage.readAllCalls).toBe(1);

    expect(await repository.clearOrigin(targetOrigin)).toEqual({ ok: true, value: undefined });
    expect(storage.values[pageRecordKey(unrelatedPage)]).toEqual({ unrelated: true });
    expect(storage.readAllCalls).toBe(2);
  });

  it("repairs stale indexes and orphan records idempotently from one full scan", async () => {
    const storage = new MemoryStorage();
    const repository = new OverlayRepository(storage);
    const actualOrigin = deriveOrigin(url);
    const staleUrl = new URL("https://stale.test/page");
    const staleOrigin = deriveOrigin(staleUrl);
    const stalePage = derivePageKey(staleUrl);
    if (actualOrigin === undefined || staleOrigin === undefined || stalePage === undefined) {
      throw new Error("Known HTTPS URLs must derive storage identities.");
    }

    await repository.updateSettings(url, { kind: "visibility", visible: false });
    storage.values[ORIGIN_INDEX_KEY] = { schemaVersion: 1, origins: [actualOrigin, staleOrigin] };
    storage.values[pageRecordKey(stalePage)] = { schemaVersion: 1, stale: true };
    storage.values[imageRecordKey(reference().metadata.id)] = { orphan: true };

    expect(await repository.cleanupOrphans()).toEqual({ ok: true, value: undefined });
    expect(storage.values[ORIGIN_INDEX_KEY]).toEqual({ schemaVersion: 1, origins: [actualOrigin] });
    expect(storage.values[pageRecordKey(stalePage)]).toBeUndefined();
    expect(storage.values[imageRecordKey(reference().metadata.id)]).toBeUndefined();

    const removeCount = storage.removes.length;
    const writeCount = storage.writes.length;
    expect(await repository.cleanupOrphans()).toEqual({ ok: true, value: undefined });
    expect(storage.removes).toHaveLength(removeCount);
    expect(storage.writes).toHaveLength(writeCount);
  });
});
