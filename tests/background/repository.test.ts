import { describe, expect, it } from "vitest";

import { OverlayRepository } from "../../src/background/repository";
import type { StorageAdapter } from "../../src/background/storage-adapter";
import {
  deriveOrigin,
  imageRecordKey,
  ORIGIN_INDEX_KEY,
  originRecordKey,
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
  #failNextRemove = false;

  failSetOn(call: number): void {
    this.#failSetCall = call;
  }

  failNextRemove(): void {
    this.#failNextRemove = true;
  }

  async get(keys: readonly string[]): Promise<Readonly<Record<string, unknown>>> {
    this.reads.push([...keys]);
    return Object.fromEntries(
      keys
        .filter((key) => Object.hasOwn(this.values, key))
        .map((key) => [key, this.values[key]]),
    );
  }

  async readAll(): Promise<Readonly<Record<string, unknown>>> {
    this.readAllCalls += 1;
    return { ...this.values };
  }

  async set(values: Readonly<Record<string, unknown>>): Promise<void> {
    this.#setCalls += 1;
    if (this.#setCalls === this.#failSetCall)
      throw new Error("planned set failure");
    this.writes.push({ ...values });
    Object.assign(this.values, values);
  }

  async remove(keys: readonly string[]): Promise<void> {
    if (this.#failNextRemove) {
      this.#failNextRemove = false;
      throw new Error("planned remove failure");
    }
    this.removes.push([...keys]);
    for (const key of keys) delete this.values[key];
  }
}

const url = new URL("https://example.test/path#fragment");

function reference(input: Readonly<{ id?: string; dataUrl?: string }> = {}) {
  const dataUrl = input.dataUrl ?? "data:image/png;base64,aGVsbG8=";
  const parsed = parseImportedReference({
    metadata: {
      id: input.id ?? "123e4567-e89b-42d3-a456-426614174000",
      name: "reference.png",
      mimeType: "image/png",
      width: 1,
      height: 1,
      encodedBytes: new TextEncoder().encode(dataUrl).byteLength,
      importedAt: 1,
    },
    dataUrl,
  });
  if (!parsed.ok) throw new Error("Test reference must parse.");
  return parsed.value;
}

function originFor(value: URL): NonNullable<ReturnType<typeof deriveOrigin>> {
  const origin = deriveOrigin(value);
  if (origin === undefined) throw new Error("Test URL must have an origin.");
  return origin;
}

function originRecord(origin: ReturnType<typeof originFor>, imported = reference()) {
  return {
    schemaVersion: 1,
    revision: 1,
    origin,
    settings: {
      visible: true,
      opacity: 0.5,
      inverted: false,
      sizing: { kind: "scale", percent: 100 },
      interactionMode: "drag",
    },
    placement: { x: 0, y: 0 },
    reference: imported.metadata,
  };
}

describe("OverlayRepository V2 index", () => {
  it("does not materialize unrelated large image payloads during routine reads", async () => {
    const storage = new MemoryStorage();
    const repository = new OverlayRepository(storage);
    const imported = reference();
    expect((await repository.replaceReference({ url, reference: imported })).ok).toBe(true);
    storage.values[imageRecordKey(reference({ id: "123e4567-e89b-42d3-a456-426614174001" }).metadata.id)] = {
      schemaVersion: 1,
      referenceId: "123e4567-e89b-42d3-a456-426614174001",
      dataUrl: `data:image/png;base64,${"A".repeat(14 * 1024 * 1024)}`,
    };
    storage.reads.length = 0;

    await expect(repository.readSnapshot(url)).resolves.toMatchObject({ ok: true });
    await expect(repository.listOrigins()).resolves.toMatchObject({ ok: true });
    expect(storage.readAllCalls).toBe(0);
    expect(storage.reads.flat()).not.toContain(
      imageRecordKey(reference({ id: "123e4567-e89b-42d3-a456-426614174001" }).metadata.id),
    );
  });

  it("migrates V1 once, seeds image IDs from named image keys, and removes legacy pages", async () => {
    const storage = new MemoryStorage();
    const repository = new OverlayRepository(storage);
    const origin = originFor(url);
    const imported = reference();
    storage.values[ORIGIN_INDEX_KEY] = { schemaVersion: 1, origins: [origin] };
    storage.values[originRecordKey(origin)] = originRecord(origin, imported);
    storage.values[imageRecordKey(imported.metadata.id)] = {
      schemaVersion: 1,
      referenceId: imported.metadata.id,
      dataUrl: imported.dataUrl,
    };
    storage.values["pixel-pincher:page:https%3A%2F%2Fexample.test%2Fpath"] = {
      legacy: true,
    };

    await expect(repository.readSnapshot(url)).resolves.toMatchObject({ ok: true });
    expect(storage.readAllCalls).toBe(1);
    expect(storage.values[ORIGIN_INDEX_KEY]).toEqual({
      schemaVersion: 2,
      origins: [{ origin, referenceId: imported.metadata.id }],
      imageIds: [imported.metadata.id],
    });
    expect(storage.values["pixel-pincher:page:https%3A%2F%2Fexample.test%2Fpath"]).toBeUndefined();
    await repository.readSnapshot(url);
    expect(storage.readAllCalls).toBe(1);
  });

  it("writes the new image, owner entry, and origin record together then deletes the old image", async () => {
    const storage = new MemoryStorage();
    const repository = new OverlayRepository(storage);
    const first = reference();
    const second = reference({
      id: "123e4567-e89b-42d3-a456-426614174002",
      dataUrl: "data:image/png;base64,d29ybGQ=",
    });
    await repository.replaceReference({ url, reference: first });
    storage.writes.length = 0;
    storage.removes.length = 0;

    await expect(repository.replaceReference({ url, reference: second })).resolves.toMatchObject({
      ok: true,
      value: { reference: second.metadata },
    });
    expect(storage.writes[0]).toEqual(expect.objectContaining({
      [ORIGIN_INDEX_KEY]: {
        schemaVersion: 2,
        origins: [{ origin: originFor(url), referenceId: second.metadata.id }],
        imageIds: [second.metadata.id],
      },
      [originRecordKey(originFor(url))]: expect.any(Object),
      [imageRecordKey(second.metadata.id)]: expect.any(Object),
    }));
    expect(storage.removes).toEqual([[imageRecordKey(first.metadata.id)]]);
    expect(storage.values[imageRecordKey(first.metadata.id)]).toBeUndefined();
  });

  it("rolls back records and V2 membership when old-image removal fails", async () => {
    const storage = new MemoryStorage();
    const repository = new OverlayRepository(storage);
    const first = reference();
    const second = reference({ id: "123e4567-e89b-42d3-a456-426614174003" });
    await repository.replaceReference({ url, reference: first });
    storage.failNextRemove();

    await expect(repository.replaceReference({ url, reference: second })).resolves.toMatchObject({
      ok: false,
      error: { code: "storage-failed" },
    });
    expect(storage.values[imageRecordKey(first.metadata.id)]).toBeDefined();
    expect(storage.values[imageRecordKey(second.metadata.id)]).toBeUndefined();
    expect(storage.values[ORIGIN_INDEX_KEY]).toMatchObject({
      origins: [{ origin: originFor(url), referenceId: first.metadata.id }],
      imageIds: [first.metadata.id],
    });
  });

  it("purges a corrupt target origin and its image while preserving a valid unrelated image", async () => {
    const storage = new MemoryStorage();
    const repository = new OverlayRepository(storage);
    const targetUrl = new URL("https://target.test/page");
    const otherUrl = new URL("https://other.test/page");
    const target = originFor(targetUrl);
    const other = originFor(otherUrl);
    const targetReference = reference({ id: "123e4567-e89b-42d3-a456-426614174004" });
    const otherReference = reference({ id: "123e4567-e89b-42d3-a456-426614174005" });
    await repository.replaceReference({ url: otherUrl, reference: otherReference });
    storage.values[originRecordKey(target)] = { corrupt: true };
    storage.values[imageRecordKey(targetReference.metadata.id)] = {
      schemaVersion: 1,
      referenceId: targetReference.metadata.id,
      dataUrl: targetReference.dataUrl,
    };
    storage.values[ORIGIN_INDEX_KEY] = {
      schemaVersion: 2,
      origins: [
        { origin: other, referenceId: otherReference.metadata.id },
        { origin: target, referenceId: targetReference.metadata.id },
      ].sort((left, right) => left.origin.localeCompare(right.origin)),
      imageIds: [otherReference.metadata.id, targetReference.metadata.id].sort(),
    };

    await expect(repository.purgeOrigin(target)).resolves.toEqual({ ok: true, value: undefined });
    expect(storage.values[originRecordKey(target)]).toBeUndefined();
    expect(storage.values[imageRecordKey(targetReference.metadata.id)]).toBeUndefined();
    expect(storage.values[originRecordKey(other)]).toBeDefined();
    expect(storage.values[imageRecordKey(otherReference.metadata.id)]).toBeDefined();
    expect(storage.values[ORIGIN_INDEX_KEY]).toEqual({
      schemaVersion: 2,
      origins: [{ origin: other, referenceId: otherReference.metadata.id }],
      imageIds: [otherReference.metadata.id],
    });
  });

  it("recovers from a corrupt index, is idempotent after partial cleanup, and removes target legacy pages", async () => {
    const storage = new MemoryStorage();
    const repository = new OverlayRepository(storage);
    const target = originFor(new URL("https://target.test/page"));
    const targetReference = reference({ id: "123e4567-e89b-42d3-a456-426614174006" });
    storage.values[originRecordKey(target)] = { corrupt: true };
    storage.values[imageRecordKey(targetReference.metadata.id)] = {
      schemaVersion: 1,
      referenceId: targetReference.metadata.id,
      dataUrl: targetReference.dataUrl,
    };
    storage.values["pixel-pincher:page:https%3A%2F%2Ftarget.test%2Fpage"] = { corrupt: true };
    storage.values[ORIGIN_INDEX_KEY] = { corrupt: true };
    storage.failNextRemove();

    await expect(repository.purgeOrigin(target)).resolves.toMatchObject({
      ok: false,
      error: { code: "storage-failed" },
    });
    await expect(repository.purgeOrigin(target)).resolves.toEqual({ ok: true, value: undefined });
    await expect(repository.purgeOrigin(target)).resolves.toEqual({ ok: true, value: undefined });
    expect(storage.values[originRecordKey(target)]).toBeUndefined();
    expect(storage.values[imageRecordKey(targetReference.metadata.id)]).toBeUndefined();
    expect(storage.values["pixel-pincher:page:https%3A%2F%2Ftarget.test%2Fpage"]).toBeUndefined();
  });

  it("reports storage failures for replacement writes and purge index writes", async () => {
    const storage = new MemoryStorage();
    const repository = new OverlayRepository(storage);
    storage.failSetOn(1);
    await expect(repository.replaceReference({ url, reference: reference() })).resolves.toMatchObject({
      ok: false,
      error: { code: "storage-failed" },
    });

    const secondStorage = new MemoryStorage();
    const secondRepository = new OverlayRepository(secondStorage);
    const origin = originFor(url);
    const imported = reference();
    await secondRepository.replaceReference({ url, reference: imported });
    secondStorage.failSetOn(2);
    await expect(secondRepository.purgeOrigin(origin)).resolves.toMatchObject({
      ok: false,
      error: { code: "storage-failed" },
    });
  });
});
