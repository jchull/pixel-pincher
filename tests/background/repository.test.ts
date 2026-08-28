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
  #setCalls = 0;
  #failSetCall: number | undefined;

  failSetOn(call: number): void {
    this.#failSetCall = call;
  }

  resetCalls(): void {
    this.reads.length = 0;
    this.writes.length = 0;
    this.removes.length = 0;
  }

  async get(keys: readonly string[]): Promise<Readonly<Record<string, unknown>>> {
    this.reads.push([...keys]);
    return Object.fromEntries(keys.filter((key) => Object.hasOwn(this.values, key)).map((key) => [key, this.values[key]]));
  }
  async readAll(): Promise<Readonly<Record<string, unknown>>> {
    this.readAllCalls += 1;
    return { ...this.values };
  }
  async set(values: Readonly<Record<string, unknown>>): Promise<void> {
    this.#setCalls += 1;
    if (this.#setCalls === this.#failSetCall) throw new Error("planned storage failure");
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
  it("returns fresh defaults and settings-only mutations never access image keys", async () => {
    const storage = new MemoryStorage();
    const repository = new OverlayRepository(storage);
    const fresh = await repository.getSnapshot(url);
    expect(fresh.ok && fresh.value.settings.opacity).toBe(0.5);
    expect((await repository.replaceReference({ url, reference: reference() })).ok).toBe(true);
    storage.resetCalls();

    const patches = [
      { kind: "opacity", opacity: 0.75 } as const,
      { kind: "visibility", visible: false } as const,
      { kind: "inversion", inverted: true } as const,
      { kind: "sizing", sizing: { kind: "scale", percent: 125 } } as const,
      { kind: "interaction-mode", interactionMode: "drag" } as const,
    ];
    for (const patch of patches) {
      expect((await repository.updateSettings({ url, patch })).ok).toBe(true);
    }
    expect((await repository.updatePlacement({ url, placement: { x: 12, y: -3 } })).ok).toBe(true);
    const touchedKeys = [...storage.reads.flat(), ...storage.writes.flatMap((write) => Object.keys(write)), ...storage.removes.flat()];
    expect(touchedKeys.some((key) => key.includes(":image:"))).toBe(false);
  });

  it("hydrates validated image data only after a reference exists and advances revisions", async () => {
    const storage = new MemoryStorage();
    const repository = new OverlayRepository(storage);
    const imported = reference();
    const replaced = await repository.replaceReference({ url, reference: imported });
    expect(replaced.ok && replaced.value.revision).toBe(1);
    const hydration = await repository.readHydration(url);
    expect(hydration.ok && hydration.value.reference?.metadata.name).toBe("reference.png");

    storage.values[imageRecordKey(imported.metadata.id)] = {
      schemaVersion: 1,
      referenceId: imported.metadata.id,
      dataUrl: "data:image/png;base64,AA==",
    };
    expect(await repository.hydrate(url)).toEqual({ ok: false, error: expect.objectContaining({ code: "invalid-stored-data" }) });
  });

  it("exposes the documented repository method names", async () => {
    const storage = new MemoryStorage();
    const repository = new OverlayRepository(storage);
    const changed = await repository.updatePlacement({ url, placement: { x: 12, y: -3 } });
    expect(changed.ok && changed.value.settings.placement).toEqual({ x: 12, y: -3 });
    expect(await repository.readSnapshot(url)).toEqual(await repository.getSnapshot(url));
    const origin = deriveOrigin(url);
    if (origin === undefined) throw new Error("Known HTTPS URL must derive an origin.");
    expect(await repository.listOrigins()).toEqual({ ok: true, value: [origin] });
    expect(await repository.removeOrphans()).toEqual({ ok: true, value: undefined });
  });

  it("preserves an existing image when same-ID replacement is a no-op or rejected", async () => {
    const storage = new MemoryStorage();
    const repository = new OverlayRepository(storage);
    const imported = reference();
    expect((await repository.replaceReference({ url, reference: imported })).ok).toBe(true);
    const imageKey = imageRecordKey(imported.metadata.id);
    const originalImage = storage.values[imageKey];
    storage.resetCalls();

    const repeated = await repository.replaceReference({ url, reference: imported });
    expect(repeated.ok && repeated.value.revision).toBe(1);
    expect(storage.writes).toHaveLength(0);
    expect(storage.removes).toHaveLength(0);

    const changedData = { ...imported, dataUrl: "data:image/png;base64,d29ybGQ=" };
    expect(await repository.replaceReference({ url, reference: changedData })).toEqual({
      ok: false,
      error: expect.objectContaining({ code: "storage-failed" }),
    });
    expect(storage.values[imageKey]).toEqual(originalImage);

    const changedMetadata = parseImportedReference({
      metadata: { ...imported.metadata, name: "renamed.png" },
      dataUrl: imported.dataUrl,
    });
    if (!changedMetadata.ok) throw new Error("Changed test metadata must parse.");
    expect(await repository.replaceReference({ url, reference: changedMetadata.value })).toEqual({
      ok: false,
      error: expect.objectContaining({ code: "storage-failed" }),
    });
    expect(storage.values[imageKey]).toEqual(originalImage);
  });

  it("rolls back only a newly written replacement image when origin commit fails", async () => {
    const storage = new MemoryStorage();
    const repository = new OverlayRepository(storage);
    const original = reference();
    expect((await repository.replaceReference({ url, reference: original })).ok).toBe(true);
    const replacementDataUrl = "data:image/png;base64,d29ybGQ=";
    const replacement = parseImportedReference({
      metadata: {
        ...original.metadata,
        id: "123e4567-e89b-42d3-a456-426614174001",
        encodedBytes: new TextEncoder().encode(replacementDataUrl).byteLength,
      },
      dataUrl: replacementDataUrl,
    });
    if (!replacement.ok) throw new Error("Test replacement must parse.");
    storage.failSetOn(4);

    expect(await repository.replaceReference({ url, reference: replacement.value })).toEqual({
      ok: false,
      error: expect.objectContaining({ code: "storage-failed" }),
    });
    expect(storage.values[imageRecordKey(original.metadata.id)]).toBeDefined();
    expect(storage.values[imageRecordKey(replacement.value.metadata.id)]).toBeUndefined();
  });

  it("returns invalid-stored-data for corrupt indexes and missing indexed origin records", async () => {
    const storage = new MemoryStorage();
    const repository = new OverlayRepository(storage);
    const origin = deriveOrigin(url);
    if (origin === undefined) throw new Error("Known HTTPS URL must derive an origin.");

    storage.values[ORIGIN_INDEX_KEY] = { schemaVersion: 2, origins: [] };
    expect(await repository.listOrigins()).toEqual({ ok: false, error: expect.objectContaining({ code: "invalid-stored-data" }) });
    expect(await repository.clearOrigin(origin)).toEqual({ ok: false, error: expect.objectContaining({ code: "invalid-stored-data" }) });

    storage.values[ORIGIN_INDEX_KEY] = { schemaVersion: 1, origins: [origin] };
    expect(await repository.listOrigins()).toEqual({ ok: false, error: expect.objectContaining({ code: "invalid-stored-data" }) });
  });

  it("serializes concurrent origin mutations with monotonic revisions and page precedence", async () => {
    const storage = new MemoryStorage();
    const repository = new OverlayRepository(storage);
    const [first, second] = await Promise.all([
      repository.updateSettings({ url, patch: { kind: "opacity", opacity: 0.25 } }),
      repository.updateSettings({ url, patch: { kind: "inversion", inverted: true } }),
    ]);
    expect([first, second].map((result) => result.ok ? result.value.revision : -1).sort()).toEqual([1, 2]);
    expect((await repository.updatePlacement({ url, placement: { x: 44, y: -5 } })).ok).toBe(true);
    const current = await repository.readSnapshot(url);
    expect(current.ok && current.value.settings).toMatchObject({ opacity: 0.25, inverted: true, placement: { x: 44, y: -5 } });
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

    await repository.updateSettings({ url, patch: { kind: "visibility", visible: false } });
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
