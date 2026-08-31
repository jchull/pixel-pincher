import { describe, expect, it } from "vitest";

import { OverlayRepository } from "../../src/background/repository";
import type { StorageAdapter } from "../../src/background/storage-adapter";
import {
  deriveOrigin,
  derivePageKey,
  imageRecordKey,
  originRecordKey,
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
  #failNextGet = false;
  #failNextReadAll = false;
  #failNextRemove = false;

  failSetOn(call: number): void {
    this.#failSetCall = call;
  }

  failNextGet(): void {
    this.#failNextGet = true;
  }

  failNextReadAll(): void {
    this.#failNextReadAll = true;
  }

  failNextRemove(): void {
    this.#failNextRemove = true;
  }

  resetCalls(): void {
    this.reads.length = 0;
    this.writes.length = 0;
    this.removes.length = 0;
  }

  async get(
    keys: readonly string[],
  ): Promise<Readonly<Record<string, unknown>>> {
    if (this.#failNextGet) {
      this.#failNextGet = false;
      throw new Error("planned get failure");
    }
    this.reads.push([...keys]);
    return Object.fromEntries(
      keys
        .filter((key) => Object.hasOwn(this.values, key))
        .map((key) => [key, this.values[key]]),
    );
  }
  async readAll(): Promise<Readonly<Record<string, unknown>>> {
    if (this.#failNextReadAll) {
      this.#failNextReadAll = false;
      throw new Error("planned read-all failure");
    }
    this.readAllCalls += 1;
    return { ...this.values };
  }
  async set(values: Readonly<Record<string, unknown>>): Promise<void> {
    this.#setCalls += 1;
    if (this.#setCalls === this.#failSetCall)
      throw new Error("planned storage failure");
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

describe("OverlayRepository", () => {
  it("returns fresh defaults and settings-only mutations never access image keys", async () => {
    const storage = new MemoryStorage();
    const repository = new OverlayRepository(storage);
    const fresh = await repository.getSnapshot(url);
    expect(fresh.ok && fresh.value.settings.opacity).toBe(0.5);
    expect(
      (await repository.replaceReference({ url, reference: reference() })).ok,
    ).toBe(true);
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
    expect(
      (await repository.updatePlacement({ url, placement: { x: 12, y: -3 } }))
        .ok,
    ).toBe(true);
    const touchedKeys = [
      ...storage.reads.flat(),
      ...storage.writes.flatMap((write) => Object.keys(write)),
      ...storage.removes.flat(),
    ];
    expect(touchedKeys.some((key) => key.includes(":image:"))).toBe(false);
  });

  it("persists panel position only in the origin record and advances its revision", async () => {
    const storage = new MemoryStorage();
    const repository = new OverlayRepository(storage);
    expect(
      (await repository.updatePlacement({ url, placement: { x: 4, y: -5 } }))
        .ok,
    ).toBe(true);
    storage.resetCalls();

    const updated = await repository.updatePanelPosition({
      url,
      panelPosition: { x: 12, y: 34 },
    });
    expect(updated).toMatchObject({
      ok: true,
      value: { revision: 2, panelPosition: { x: 12, y: 34 } },
    });
    const origin = deriveOrigin(url);
    if (origin === undefined)
      throw new Error("Known HTTPS URL must derive an origin.");
    expect(storage.values[originRecordKey(origin)]).toMatchObject({
      revision: 2,
      panelPosition: { x: 12, y: 34 },
    });
    const writtenKeys = storage.writes.flatMap((write) => Object.keys(write));
    expect(
      writtenKeys.some(
        (key) => key.includes(":image:") || key.includes(":page:"),
      ),
    ).toBe(false);
    expect(await repository.readSnapshot(url)).toMatchObject({
      ok: true,
      value: { panelPosition: { x: 12, y: 34 } },
    });
  });

  it("preserves panel position in settings and reference mutation snapshots", async () => {
    const storage = new MemoryStorage();
    const repository = new OverlayRepository(storage);
    expect(
      (
        await repository.updatePanelPosition({
          url,
          panelPosition: { x: 12, y: 34 },
        })
      ).ok,
    ).toBe(true);

    await expect(
      repository.updateSettings({
        url,
        patch: { kind: "opacity", opacity: 0.75 },
      }),
    ).resolves.toMatchObject({
      ok: true,
      value: { panelPosition: { x: 12, y: 34 } },
    });
    await expect(
      repository.replaceReference({
        url,
        reference: reference(),
      }),
    ).resolves.toMatchObject({
      ok: true,
      value: { panelPosition: { x: 12, y: 34 } },
    });
  });

  it("hydrates validated image data only after a reference exists and advances revisions", async () => {
    const storage = new MemoryStorage();
    const repository = new OverlayRepository(storage);
    const imported = reference();
    const replaced = await repository.replaceReference({
      url,
      reference: imported,
    });
    expect(replaced.ok && replaced.value.revision).toBe(1);
    const hydration = await repository.readHydration(url);
    expect(hydration.ok && hydration.value.reference?.metadata.name).toBe(
      "reference.png",
    );

    storage.values[imageRecordKey(imported.metadata.id)] = {
      schemaVersion: 1,
      referenceId: imported.metadata.id,
      dataUrl: "data:image/png;base64,AA==",
    };
    expect(await repository.hydrate(url)).toEqual({
      ok: false,
      error: expect.objectContaining({ code: "invalid-stored-data" }),
    });
  });

  it("exposes the documented repository method names", async () => {
    const storage = new MemoryStorage();
    const repository = new OverlayRepository(storage);
    const changed = await repository.updatePlacement({
      url,
      placement: { x: 12, y: -3 },
    });
    expect(changed.ok && changed.value.settings.placement).toEqual({
      x: 12,
      y: -3,
    });
    expect(await repository.readSnapshot(url)).toEqual(
      await repository.getSnapshot(url),
    );
    const origin = deriveOrigin(url);
    if (origin === undefined)
      throw new Error("Known HTTPS URL must derive an origin.");
    expect(await repository.listOrigins()).toEqual({
      ok: true,
      value: [origin],
    });
    expect(await repository.removeOrphans()).toEqual({
      ok: true,
      value: undefined,
    });
  });

  it("preserves an existing image when same-ID replacement is a no-op or rejected", async () => {
    const storage = new MemoryStorage();
    const repository = new OverlayRepository(storage);
    const imported = reference();
    expect(
      (await repository.replaceReference({ url, reference: imported })).ok,
    ).toBe(true);
    const imageKey = imageRecordKey(imported.metadata.id);
    const originalImage = storage.values[imageKey];
    storage.resetCalls();

    const repeated = await repository.replaceReference({
      url,
      reference: imported,
    });
    expect(repeated.ok && repeated.value.revision).toBe(1);
    expect(storage.writes).toHaveLength(0);
    expect(storage.removes).toHaveLength(0);

    const changedData = {
      ...imported,
      dataUrl: "data:image/png;base64,d29ybGQ=",
    };
    expect(
      await repository.replaceReference({ url, reference: changedData }),
    ).toEqual({
      ok: false,
      error: expect.objectContaining({ code: "storage-failed" }),
    });
    expect(storage.values[imageKey]).toEqual(originalImage);

    const changedMetadata = parseImportedReference({
      metadata: { ...imported.metadata, name: "renamed.png" },
      dataUrl: imported.dataUrl,
    });
    if (!changedMetadata.ok)
      throw new Error("Changed test metadata must parse.");
    expect(
      await repository.replaceReference({
        url,
        reference: changedMetadata.value,
      }),
    ).toEqual({
      ok: false,
      error: expect.objectContaining({ code: "storage-failed" }),
    });
    expect(storage.values[imageKey]).toEqual(originalImage);
  });

  it("rolls back only a newly written replacement image when origin commit fails", async () => {
    const storage = new MemoryStorage();
    const repository = new OverlayRepository(storage);
    const original = reference();
    expect(
      (await repository.replaceReference({ url, reference: original })).ok,
    ).toBe(true);
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

    expect(
      await repository.replaceReference({ url, reference: replacement.value }),
    ).toEqual({
      ok: false,
      error: expect.objectContaining({ code: "storage-failed" }),
    });
    expect(storage.values[imageRecordKey(original.metadata.id)]).toBeDefined();
    expect(
      storage.values[imageRecordKey(replacement.value.metadata.id)],
    ).toBeUndefined();
  });

  it("returns invalid-stored-data for corrupt indexes and missing indexed origin records", async () => {
    const storage = new MemoryStorage();
    const repository = new OverlayRepository(storage);
    const origin = deriveOrigin(url);
    if (origin === undefined)
      throw new Error("Known HTTPS URL must derive an origin.");

    storage.values[ORIGIN_INDEX_KEY] = { schemaVersion: 2, origins: [] };
    expect(await repository.listOrigins()).toEqual({
      ok: false,
      error: expect.objectContaining({ code: "invalid-stored-data" }),
    });
    expect(await repository.clearOrigin(origin)).toEqual({
      ok: true,
      value: undefined,
    });

    storage.values[ORIGIN_INDEX_KEY] = { schemaVersion: 1, origins: [origin] };
    expect(await repository.listOrigins()).toEqual({
      ok: false,
      error: expect.objectContaining({ code: "invalid-stored-data" }),
    });
  });

  it("serializes concurrent origin mutations with monotonic revisions and page precedence", async () => {
    const storage = new MemoryStorage();
    const repository = new OverlayRepository(storage);
    const [first, second] = await Promise.all([
      repository.updateSettings({
        url,
        patch: { kind: "opacity", opacity: 0.25 },
      }),
      repository.updateSettings({
        url,
        patch: { kind: "inversion", inverted: true },
      }),
    ]);
    expect(
      [first, second]
        .map((result) => (result.ok ? result.value.revision : -1))
        .sort(),
    ).toEqual([1, 2]);
    expect(
      (await repository.updatePlacement({ url, placement: { x: 44, y: -5 } }))
        .ok,
    ).toBe(true);
    const current = await repository.readSnapshot(url);
    expect(current.ok && current.value.settings).toMatchObject({
      opacity: 0.25,
      inverted: true,
      placement: { x: 44, y: -5 },
    });
  });

  it("clears unknown page values for one origin while preserving unrelated records", async () => {
    const storage = new MemoryStorage();
    const repository = new OverlayRepository(storage);
    const targetUrl = new URL("https://example.test/unknown-page");
    const unrelatedUrl = new URL("https://other.test/page");
    const targetOrigin = deriveOrigin(targetUrl);
    const targetPage = derivePageKey(targetUrl);
    const unrelatedPage = derivePageKey(unrelatedUrl);
    if (
      targetOrigin === undefined ||
      targetPage === undefined ||
      unrelatedPage === undefined
    ) {
      throw new Error("Known HTTPS URLs must derive storage identities.");
    }

    storage.values[pageRecordKey(targetPage)] = {
      unexpected: "legacy page value",
    };
    storage.values[pageRecordKey(unrelatedPage)] = { unrelated: true };
    const cleared = await repository.clearOrigin(targetOrigin);

    expect(cleared).toEqual({ ok: true, value: undefined });
    expect(storage.values[pageRecordKey(targetPage)]).toBeUndefined();
    expect(storage.values[pageRecordKey(unrelatedPage)]).toEqual({
      unrelated: true,
    });
    expect(storage.readAllCalls).toBe(1);

    expect(await repository.clearOrigin(targetOrigin)).toEqual({
      ok: true,
      value: undefined,
    });
    expect(storage.values[pageRecordKey(unrelatedPage)]).toEqual({
      unrelated: true,
    });
    expect(storage.readAllCalls).toBe(2);
  });

  it("repairs stale indexes and orphan records idempotently from one full scan", async () => {
    const storage = new MemoryStorage();
    const repository = new OverlayRepository(storage);
    const actualOrigin = deriveOrigin(url);
    const staleUrl = new URL("https://stale.test/page");
    const staleOrigin = deriveOrigin(staleUrl);
    const stalePage = derivePageKey(staleUrl);
    if (
      actualOrigin === undefined ||
      staleOrigin === undefined ||
      stalePage === undefined
    ) {
      throw new Error("Known HTTPS URLs must derive storage identities.");
    }

    await repository.updateSettings({
      url,
      patch: { kind: "visibility", visible: false },
    });
    storage.values[ORIGIN_INDEX_KEY] = {
      schemaVersion: 1,
      origins: [actualOrigin, staleOrigin],
    };
    storage.values[pageRecordKey(stalePage)] = {
      schemaVersion: 1,
      stale: true,
    };
    storage.values[imageRecordKey(reference().metadata.id)] = { orphan: true };

    expect(await repository.cleanupOrphans()).toEqual({
      ok: true,
      value: undefined,
    });
    expect(storage.values[ORIGIN_INDEX_KEY]).toEqual({
      schemaVersion: 1,
      origins: [actualOrigin],
    });
    expect(storage.values[pageRecordKey(stalePage)]).toBeUndefined();
    expect(
      storage.values[imageRecordKey(reference().metadata.id)],
    ).toBeUndefined();

    const removeCount = storage.removes.length;
    const writeCount = storage.writes.length;
    expect(await repository.cleanupOrphans()).toEqual({
      ok: true,
      value: undefined,
    });
    expect(storage.removes).toHaveLength(removeCount);
    expect(storage.writes).toHaveLength(writeCount);
  });

  it("rejects a ReferenceId already committed by another origin and preserves independent hydration", async () => {
    const storage = new MemoryStorage();
    const repository = new OverlayRepository(storage);
    const firstUrl = new URL("https://first.test/page");
    const secondUrl = new URL("https://second.test/page");
    const firstReference = reference({
      id: "123e4567-e89b-42d3-a456-426614174010",
    });
    const secondReference = reference({
      id: "123e4567-e89b-42d3-a456-426614174011",
      dataUrl: "data:image/png;base64,d29ybGQ=",
    });

    expect(
      (
        await repository.replaceReference({
          url: firstUrl,
          reference: firstReference,
        })
      ).ok,
    ).toBe(true);
    expect(
      (
        await repository.replaceReference({
          url: secondUrl,
          reference: secondReference,
        })
      ).ok,
    ).toBe(true);
    expect(
      await repository.replaceReference({
        url: secondUrl,
        reference: firstReference,
      }),
    ).toEqual({
      ok: false,
      error: expect.objectContaining({ code: "storage-failed" }),
    });

    expect((await repository.readHydration(secondUrl)).ok).toBe(true);
    const firstOrigin = deriveOrigin(firstUrl);
    if (firstOrigin === undefined)
      throw new Error("Known HTTPS URL must derive an origin.");
    expect(await repository.clearOrigin(firstOrigin)).toEqual({
      ok: true,
      value: undefined,
    });
    const secondHydration = await repository.readHydration(secondUrl);
    expect(
      secondHydration.ok && secondHydration.value.reference?.metadata.id,
    ).toBe(secondReference.metadata.id);

    const replacement = reference({
      id: "123e4567-e89b-42d3-a456-426614174012",
      dataUrl: "data:image/png;base64,YWdhaW4=",
    });
    expect(
      (
        await repository.replaceReference({
          url: firstUrl,
          reference: replacement,
        })
      ).ok,
    ).toBe(true);
    const independentHydration = await repository.readHydration(secondUrl);
    expect(
      independentHydration.ok &&
        independentHydration.value.reference?.metadata.id,
    ).toBe(secondReference.metadata.id);
  });

  it("clears a populated origin while preserving a different origin's settings, image, and index membership", async () => {
    const storage = new MemoryStorage();
    const repository = new OverlayRepository(storage);
    const firstUrl = new URL("https://first.test/page");
    const secondUrl = new URL("https://second.test/page");
    const firstReference = reference({
      id: "123e4567-e89b-42d3-a456-426614174020",
    });
    const secondReference = reference({
      id: "123e4567-e89b-42d3-a456-426614174021",
      dataUrl: "data:image/png;base64,d29ybGQ=",
    });
    expect(
      (
        await repository.replaceReference({
          url: firstUrl,
          reference: firstReference,
        })
      ).ok,
    ).toBe(true);
    expect(
      (
        await repository.updatePlacement({
          url: firstUrl,
          placement: { x: 3, y: 4 },
        })
      ).ok,
    ).toBe(true);
    expect(
      (
        await repository.replaceReference({
          url: secondUrl,
          reference: secondReference,
        })
      ).ok,
    ).toBe(true);
    expect(
      (
        await repository.updatePlacement({
          url: secondUrl,
          placement: { x: 7, y: 8 },
        })
      ).ok,
    ).toBe(true);

    const firstOrigin = deriveOrigin(firstUrl);
    const secondOrigin = deriveOrigin(secondUrl);
    if (firstOrigin === undefined || secondOrigin === undefined) {
      throw new Error("Known HTTPS URLs must derive storage identities.");
    }
    expect(await repository.clearOrigin(firstOrigin)).toEqual({
      ok: true,
      value: undefined,
    });
    expect(storage.values[originRecordKey(firstOrigin)]).toBeUndefined();
    expect(
      storage.values[imageRecordKey(firstReference.metadata.id)],
    ).toBeUndefined();
    expect(storage.values[originRecordKey(secondOrigin)]).toBeDefined();
    expect(
      storage.values[imageRecordKey(secondReference.metadata.id)],
    ).toBeDefined();
    expect(await repository.listOrigins()).toEqual({
      ok: true,
      value: [secondOrigin],
    });
  });

  it("maps get, read-all, and remove adapter failures to storage-failed", async () => {
    const storage = new MemoryStorage();
    const repository = new OverlayRepository(storage);
    storage.failNextGet();
    expect(await repository.readSnapshot(url)).toEqual({
      ok: false,
      error: expect.objectContaining({ code: "storage-failed" }),
    });

    storage.failNextReadAll();
    expect(await repository.listOrigins()).toEqual({
      ok: false,
      error: expect.objectContaining({ code: "storage-failed" }),
    });

    const imported = reference();
    expect(
      (await repository.replaceReference({ url, reference: imported })).ok,
    ).toBe(true);
    const origin = deriveOrigin(url);
    if (origin === undefined)
      throw new Error("Known HTTPS URL must derive an origin.");
    storage.failNextRemove();
    expect(await repository.clearOrigin(origin)).toEqual({
      ok: false,
      error: expect.objectContaining({ code: "storage-failed" }),
    });
  });

  it("shares placement across pages under one origin", async () => {
    const storage = new MemoryStorage();
    const repository = new OverlayRepository(storage);
    const firstPage = new URL("https://example.test/first");
    const secondPage = new URL("https://example.test/second");
    expect(
      (
        await repository.updateSettings({
          url: firstPage,
          patch: { kind: "opacity", opacity: 0.25 },
        })
      ).ok,
    ).toBe(true);
    expect(
      (
        await repository.updatePlacement({
          url: firstPage,
          placement: { x: 1, y: 2 },
        })
      ).ok,
    ).toBe(true);
    const secondSnapshot = await repository.readSnapshot(secondPage);
    expect(secondSnapshot.ok && secondSnapshot.value.settings).toMatchObject({
      opacity: 0.25,
      placement: { x: 1, y: 2 },
    });
    expect(
      (
        await repository.updatePlacement({
          url: secondPage,
          placement: { x: 3, y: 4 },
        })
      ).ok,
    ).toBe(true);
    const firstSnapshot = await repository.readSnapshot(firstPage);
    expect(firstSnapshot.ok && firstSnapshot.value.settings).toMatchObject({
      opacity: 0.25,
      placement: { x: 3, y: 4 },
    });
  });

  it("reports persisted duplicate image ownership and never deletes the shared image", async () => {
    const storage = new MemoryStorage();
    const repository = new OverlayRepository(storage);
    const firstUrl = new URL("https://first.test/page");
    const secondUrl = new URL("https://second.test/page");
    const shared = reference({ id: "123e4567-e89b-42d3-a456-426614174030" });
    const independent = reference({
      id: "123e4567-e89b-42d3-a456-426614174031",
      dataUrl: "data:image/png;base64,d29ybGQ=",
    });
    expect(
      (await repository.replaceReference({ url: firstUrl, reference: shared }))
        .ok,
    ).toBe(true);
    expect(
      (
        await repository.replaceReference({
          url: secondUrl,
          reference: independent,
        })
      ).ok,
    ).toBe(true);
    const secondOrigin = deriveOrigin(secondUrl);
    if (secondOrigin === undefined)
      throw new Error("Known HTTPS URL must derive an origin.");
    storage.values[originRecordKey(secondOrigin)] = {
      schemaVersion: 1,
      revision: 1,
      origin: secondOrigin,
      settings: {
        visible: true,
        opacity: 0.5,
        inverted: false,
        sizing: { kind: "fit-width", lastScalePercent: 100 },
        interactionMode: "click-through",
      },
      reference: shared.metadata,
    };
    const firstOrigin = deriveOrigin(firstUrl);
    if (firstOrigin === undefined)
      throw new Error("Known HTTPS URL must derive an origin.");
    expect(await repository.readSnapshot(firstUrl)).toEqual({
      ok: false,
      error: expect.objectContaining({ code: "invalid-stored-data" }),
    });
    expect(await repository.cleanupOrphans()).toEqual({
      ok: false,
      error: expect.objectContaining({ code: "invalid-stored-data" }),
    });
    expect(await repository.clearOrigin(firstOrigin)).toEqual({
      ok: false,
      error: expect.objectContaining({ code: "invalid-stored-data" }),
    });
    expect(storage.values[imageRecordKey(shared.metadata.id)]).toBeDefined();
  });

  it("blocks replacement of a duplicated current reference without deleting the other origin image", async () => {
    const storage = new MemoryStorage();
    const repository = new OverlayRepository(storage);
    const firstUrl = new URL("https://first.test/page");
    const secondUrl = new URL("https://second.test/page");
    const shared = reference({ id: "123e4567-e89b-42d3-a456-426614174040" });
    const independent = reference({
      id: "123e4567-e89b-42d3-a456-426614174041",
      dataUrl: "data:image/png;base64,d29ybGQ=",
    });
    const replacement = reference({
      id: "123e4567-e89b-42d3-a456-426614174042",
      dataUrl: "data:image/png;base64,cmVwbGFjZWQ=",
    });
    expect(
      (await repository.replaceReference({ url: firstUrl, reference: shared }))
        .ok,
    ).toBe(true);
    expect(
      (
        await repository.replaceReference({
          url: secondUrl,
          reference: independent,
        })
      ).ok,
    ).toBe(true);

    const secondOrigin = deriveOrigin(secondUrl);
    if (secondOrigin === undefined)
      throw new Error("Known HTTPS URL must derive an origin.");
    storage.values[originRecordKey(secondOrigin)] = {
      schemaVersion: 1,
      revision: 1,
      origin: secondOrigin,
      settings: {
        visible: true,
        opacity: 0.5,
        inverted: false,
        sizing: { kind: "fit-width", lastScalePercent: 100 },
        interactionMode: "click-through",
      },
      reference: shared.metadata,
    };
    storage.resetCalls();

    expect(
      await repository.replaceReference({
        url: firstUrl,
        reference: replacement,
      }),
    ).toEqual({
      ok: false,
      error: expect.objectContaining({ code: "invalid-stored-data" }),
    });
    expect(storage.writes).toHaveLength(0);
    expect(storage.removes).toHaveLength(0);
    expect(storage.values[imageRecordKey(shared.metadata.id)]).toBeDefined();

    const secondHydration = await repository.readHydration(secondUrl);
    expect(
      secondHydration.ok && secondHydration.value.reference?.metadata.id,
    ).toBe(shared.metadata.id);
  });

  it("clears corrupt target records and indexes without removing unrelated data", async () => {
    const storage = new MemoryStorage();
    const repository = new OverlayRepository(storage);
    const targetUrl = new URL("https://target.test/page");
    const otherUrl = new URL("https://other.test/page");
    const targetOrigin = deriveOrigin(targetUrl);
    const targetPage = derivePageKey(targetUrl);
    const otherOrigin = deriveOrigin(otherUrl);
    if (
      targetOrigin === undefined ||
      targetPage === undefined ||
      otherOrigin === undefined
    )
      throw new Error("Known HTTPS URLs must derive storage identities.");
    expect(
      (
        await repository.updateSettings({
          url: otherUrl,
          patch: { kind: "visibility", visible: false },
        })
      ).ok,
    ).toBe(true);
    storage.values[originRecordKey(targetOrigin)] = { corrupt: true };
    storage.values[pageRecordKey(targetPage)] = { corrupt: true };
    storage.values[ORIGIN_INDEX_KEY] = { corrupt: true };
    expect(await repository.clearOrigin(targetOrigin)).toEqual({
      ok: true,
      value: undefined,
    });
    expect(storage.values[originRecordKey(targetOrigin)]).toBeUndefined();
    expect(storage.values[pageRecordKey(targetPage)]).toBeUndefined();
    expect(storage.values[originRecordKey(otherOrigin)]).toBeDefined();
    expect(storage.values[ORIGIN_INDEX_KEY]).toEqual({
      schemaVersion: 1,
      origins: [otherOrigin],
    });
  });

  it("rejects inconsistent snapshots and exhausted revisions before writes", async () => {
    const storage = new MemoryStorage();
    const repository = new OverlayRepository(storage);
    const origin = deriveOrigin(url);
    const page = derivePageKey(url);
    if (origin === undefined || page === undefined)
      throw new Error("Known HTTPS URL must derive storage identities.");
    storage.values[pageRecordKey(page)] = {
      schemaVersion: 1,
      revision: 1,
      origin,
      pageKey: page,
      placement: { x: 0, y: 0 },
    };
    expect(await repository.readSnapshot(url)).toEqual({
      ok: false,
      error: expect.objectContaining({ code: "invalid-stored-data" }),
    });
    storage.values[originRecordKey(origin)] = {
      schemaVersion: 1,
      revision: 0,
      origin,
      settings: {
        visible: true,
        opacity: 0.5,
        inverted: false,
        sizing: { kind: "fit-width", lastScalePercent: 100 },
        interactionMode: "click-through",
      },
      reference: null,
    };
    expect(await repository.readSnapshot(url)).toEqual({
      ok: false,
      error: expect.objectContaining({ code: "invalid-stored-data" }),
    });
    storage.values[pageRecordKey(page)] = {
      schemaVersion: 1,
      revision: Number.MAX_SAFE_INTEGER,
      origin,
      pageKey: page,
      placement: { x: 0, y: 0 },
    };
    storage.values[originRecordKey(origin)] = {
      schemaVersion: 1,
      revision: Number.MAX_SAFE_INTEGER,
      origin,
      settings: {
        visible: true,
        opacity: 0.5,
        inverted: false,
        sizing: { kind: "fit-width", lastScalePercent: 100 },
        interactionMode: "click-through",
      },
      reference: null,
    };
    storage.resetCalls();
    expect(
      await repository.updateSettings({
        url,
        patch: { kind: "opacity", opacity: 0.25 },
      }),
    ).toEqual({
      ok: false,
      error: expect.objectContaining({ code: "invalid-stored-data" }),
    });
    expect(storage.writes).toHaveLength(0);
  });

  it("does not write no-op settings and preserves index membership across concurrent origins", async () => {
    const storage = new MemoryStorage();
    const repository = new OverlayRepository(storage);
    const firstUrl = new URL("https://first.test/page");
    const secondUrl = new URL("https://second.test/page");
    expect(
      (
        await repository.updateSettings({
          url: firstUrl,
          patch: { kind: "opacity", opacity: 0.5 },
        })
      ).ok,
    ).toBe(true);
    storage.resetCalls();
    expect(
      (
        await repository.updateSettings({
          url: firstUrl,
          patch: { kind: "opacity", opacity: 0.5 },
        })
      ).ok,
    ).toBe(true);
    expect(storage.writes).toHaveLength(0);
    await Promise.all([
      repository.updateSettings({
        url: firstUrl,
        patch: { kind: "visibility", visible: false },
      }),
      repository.updateSettings({
        url: secondUrl,
        patch: { kind: "inversion", inverted: true },
      }),
    ]);
    const firstOrigin = deriveOrigin(firstUrl);
    const secondOrigin = deriveOrigin(secondUrl);
    if (firstOrigin === undefined || secondOrigin === undefined)
      throw new Error("Known HTTPS URLs must derive origins.");
    expect(await repository.listOrigins()).toEqual({
      ok: true,
      value: [firstOrigin, secondOrigin],
    });
  });
});
