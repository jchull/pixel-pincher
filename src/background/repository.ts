import {
  AppError,
  DEFAULT_ORIGIN_SETTINGS,
  DEFAULT_SETTINGS,
  type Hydration,
  type Origin,
  type OriginIndexV2,
  type OriginRecordV1,
  type OverlaySettings,
  type OverlaySnapshot,
  type PageKey,
  type ReferenceId,
  type ReferenceMetadata,
  type ReplaceReferenceInput,
  type RepositoryError,
  type Result,
  type SettingsPatch,
  type UpdatePanelPositionInput,
  type UpdatePlacementInput,
  type UpdateSettingsInput,
} from "../shared/contracts";
import {
  deriveOrigin,
  derivePageKey,
  IMAGE_RECORD_KEY_PREFIX,
  imageRecordKey,
  isImageRecordKey,
  OBSOLETE_PAGE_STORAGE_PREFIX,
  ORIGIN_INDEX_KEY,
  originRecordKey,
} from "../shared/keys";
import {
  parseImageRecordV1,
  parseImportedReference,
  parseOriginIndexV1,
  parseOriginIndexV2,
  parseOriginRecordV1,
  parseReferenceId,
} from "../shared/parse";
import type { StorageAdapter } from "./storage-adapter";

type LoadedState = Readonly<{
  index: OriginIndexV2;
  origin: Origin;
  pageKey: PageKey;
  originRecord: OriginRecordV1 | null;
}>;

export type {
  ReplaceReferenceInput,
  UpdatePanelPositionInput,
  UpdatePlacementInput,
  UpdateSettingsInput,
} from "../shared/contracts";

function repositoryFailure(): Result<never, RepositoryError> {
  return { ok: false, error: new AppError("storage-failed") };
}

function invalidStoredData(): Result<never, RepositoryError> {
  return { ok: false, error: new AppError("invalid-stored-data") };
}

function emptyIndex(): OriginIndexV2 {
  return { schemaVersion: 2, origins: [], imageIds: [] };
}

function buildIndex(
  origins: readonly OriginIndexV2["origins"][number][],
  imageIds: readonly ReferenceId[],
): OriginIndexV2 {
  return {
    schemaVersion: 2,
    origins: [...origins].sort((left, right) =>
      left.origin < right.origin ? -1 : left.origin > right.origin ? 1 : 0,
    ),
    imageIds: [...imageIds].sort(),
  };
}

function patchSettings(
  settings: OverlaySettings,
  patch: SettingsPatch,
): OverlaySettings {
  switch (patch.kind) {
    case "visibility":
      return { ...settings, visible: patch.visible };
    case "opacity":
      return { ...settings, opacity: patch.opacity };
    case "inversion":
      return { ...settings, inverted: patch.inverted };
    case "sizing":
      return { ...settings, sizing: patch.sizing };
    case "interaction-mode":
      return { ...settings, interactionMode: patch.interactionMode };
    case "placement":
      return { ...settings, placement: patch.placement };
  }
}

function originSettings(settings: OverlaySettings): OriginRecordV1["settings"] {
  return {
    visible: settings.visible,
    opacity: settings.opacity,
    inverted: settings.inverted,
    sizing: settings.sizing,
    interactionMode: settings.interactionMode,
  };
}

function sameMetadata(
  left: ReferenceMetadata,
  right: ReferenceMetadata,
): boolean {
  return (
    left.id === right.id &&
    left.name === right.name &&
    left.mimeType === right.mimeType &&
    left.width === right.width &&
    left.height === right.height &&
    left.encodedBytes === right.encodedBytes &&
    left.importedAt === right.importedAt
  );
}

function nextRevision(current: number): number {
  if (current >= Number.MAX_SAFE_INTEGER)
    throw new AppError("invalid-stored-data");
  return current + 1;
}

function snapshot(state: LoadedState): OverlaySnapshot {
  const record = state.originRecord;
  const settings: OverlaySettings = {
    ...(record?.settings ?? DEFAULT_ORIGIN_SETTINGS),
    placement: record?.placement ?? DEFAULT_SETTINGS.placement,
  };
  return {
    revision: record?.revision ?? 0,
    origin: state.origin,
    pageKey: state.pageKey,
    settings,
    reference: record?.reference ?? null,
    ...(record?.panelPosition === undefined
      ? {}
      : { panelPosition: record.panelPosition }),
  };
}

function referenceId(record: OriginRecordV1 | null): ReferenceId | null {
  return record?.reference?.id ?? null;
}

/** Persistent per-origin repository. Every mutation for one origin is serialized. */
export class OverlayRepository {
  readonly #adapter: StorageAdapter;
  readonly #locks = new Map<Origin, Promise<void>>();
  #maintenance: Promise<void> = Promise.resolve();

  constructor(adapter: StorageAdapter) {
    this.#adapter = adapter;
  }

  async readSnapshot(
    url: URL,
  ): Promise<Result<OverlaySnapshot, RepositoryError>> {
    return this.#withMaintenance(async () => {
      const state = await this.#load(url);
      return state.ok ? { ok: true, value: snapshot(state.value) } : state;
    });
  }

  async readHydration(url: URL): Promise<Result<Hydration, RepositoryError>> {
    return this.#withMaintenance(async () => {
      const state = await this.#load(url);
      if (!state.ok) return state;
      const current = snapshot(state.value);
      if (current.reference === null) {
        return {
          ok: true,
          value: { snapshot: { ...current, reference: null }, reference: null },
        };
      }
      try {
        const key = imageRecordKey(current.reference.id);
        const values = await this.#adapter.get([key]);
        const image = parseImageRecordV1(values[key]);
        if (
          !image.ok ||
          image.value.referenceId !== current.reference.id ||
          key !== imageRecordKey(image.value.referenceId)
        ) {
          return invalidStoredData();
        }
        const imported = parseImportedReference({
          metadata: current.reference,
          dataUrl: image.value.dataUrl,
        });
        if (!imported.ok) return invalidStoredData();
        return {
          ok: true,
          value: {
            snapshot: { ...current, reference: current.reference },
            reference: imported.value,
          },
        };
      } catch {
        return repositoryFailure();
      }
    });
  }

  async updateSettings(
    input: UpdateSettingsInput,
  ): Promise<Result<OverlaySnapshot, RepositoryError>> {
    return this.#mutate(input.url, async (state) => {
      const before = snapshot(state);
      const settings = patchSettings(before.settings, input.patch);
      if (JSON.stringify(before.settings) === JSON.stringify(settings)) return before;
      const origin: OriginRecordV1 = {
        schemaVersion: 1,
        revision: nextRevision(before.revision),
        origin: state.origin,
        settings: originSettings(settings),
        placement: settings.placement,
        reference: before.reference,
        ...(state.originRecord?.panelPosition === undefined
          ? {}
          : { panelPosition: state.originRecord.panelPosition }),
      };
      await this.#writeOrigin(state, origin, state.index);
      return { ...before, revision: origin.revision, settings };
    });
  }

  async updatePlacement(
    input: UpdatePlacementInput,
  ): Promise<Result<OverlaySnapshot, RepositoryError>> {
    return this.updateSettings({
      url: input.url,
      patch: { kind: "placement", placement: input.placement },
    });
  }

  async updatePanelPosition(
    input: UpdatePanelPositionInput,
  ): Promise<Result<OverlaySnapshot, RepositoryError>> {
    return this.#mutate(input.url, async (state) => {
      const before = snapshot(state);
      if (
        before.panelPosition?.x === input.panelPosition.x &&
        before.panelPosition?.y === input.panelPosition.y
      ) {
        return before;
      }
      const origin: OriginRecordV1 = {
        schemaVersion: 1,
        revision: nextRevision(before.revision),
        origin: state.origin,
        settings: originSettings(before.settings),
        placement: before.settings.placement,
        reference: before.reference,
        panelPosition: input.panelPosition,
      };
      await this.#writeOrigin(state, origin, state.index);
      return { ...before, revision: origin.revision, panelPosition: input.panelPosition };
    });
  }

  async replaceReference(
    input: ReplaceReferenceInput,
  ): Promise<Result<OverlaySnapshot, RepositoryError>> {
    return this.#mutate(input.url, async (state) => {
      const before = snapshot(state);
      const previousId = referenceId(state.originRecord);
      const nextId = input.reference.metadata.id;
      const nextImageKey = imageRecordKey(nextId);
      try {
        const existingValues = await this.#adapter.get([nextImageKey]);
        const existingValue = existingValues[nextImageKey];
        if (previousId === nextId) {
          if (!sameMetadata(before.reference ?? input.reference.metadata, input.reference.metadata))
            throw new AppError("storage-failed");
          const existing = parseImageRecordV1(existingValue);
          if (!existing.ok || existing.value.referenceId !== nextId)
            throw new AppError("invalid-stored-data");
          if (existing.value.dataUrl !== input.reference.dataUrl)
            throw new AppError("storage-failed");
          return before;
        }
        if (
          state.index.origins.some(
            (entry) => entry.origin !== state.origin && entry.referenceId === nextId,
          )
        ) {
          throw new AppError("storage-failed");
        }
        if (existingValue !== undefined) {
          const existing = parseImageRecordV1(existingValue);
          if (!existing.ok || existing.value.referenceId !== nextId)
            throw new AppError("invalid-stored-data");
          if (existing.value.dataUrl !== input.reference.dataUrl)
            throw new AppError("storage-failed");
        }

        const origin: OriginRecordV1 = {
          schemaVersion: 1,
          revision: nextRevision(before.revision),
          origin: state.origin,
          settings: originSettings(before.settings),
          placement: before.settings.placement,
          reference: input.reference.metadata,
          ...(state.originRecord?.panelPosition === undefined
            ? {}
            : { panelPosition: state.originRecord.panelPosition }),
        };
        // Keep every physical image ID indexed until its remove call succeeds.
        // This makes either image reachable by cleanup or purge if the worker is
        // interrupted between replacement phases.
        const replacementIndex = this.#indexWithOrigin(
          state.index,
          state.origin,
          nextId,
        );
        await this.#adapter.set({
          [originRecordKey(state.origin)]: origin,
          [ORIGIN_INDEX_KEY]: replacementIndex,
          ...(existingValue === undefined
            ? {
                [nextImageKey]: {
                  schemaVersion: 1,
                  referenceId: nextId,
                  dataUrl: input.reference.dataUrl,
                },
              }
            : {}),
        });
        if (previousId !== null) {
          try {
            await this.#adapter.remove([imageRecordKey(previousId)]);
          } catch {
            await this.#rollbackReplacement(state, replacementIndex, nextId);
            throw new AppError("storage-failed");
          }
          // Removing the old ID from the index is deliberately a separate
          // cleanup phase. If it fails, the stale (but indexed) ID is harmless
          // and a later cleanup/purge removes it without losing discoverability.
          await this.#adapter.set({
            [ORIGIN_INDEX_KEY]: this.#indexWithoutImage(
              replacementIndex,
              previousId,
            ),
          });
        }
        return { ...before, revision: origin.revision, reference: input.reference.metadata };
      } catch (error: unknown) {
        throw error instanceof AppError
          ? error
          : new AppError("storage-failed");
      }
    });
  }

  /** Deletes one origin even when normal metadata parsing cannot identify its image. */
  async purgeOrigin(origin: Origin): Promise<Result<void, RepositoryError>> {
    return this.#locked(origin, async () =>
      this.#withMaintenance(async () => {
        try {
          if (await this.#purgeFromValidIndex(origin))
            return { ok: true, value: undefined };
        } catch (error: unknown) {
          if (!(error instanceof AppError) || error.code !== "invalid-stored-data")
            return repositoryFailure();
        }
        return this.#purgeFromCorruptState(origin);
      }),
    );
  }

  async listOrigins(): Promise<Result<readonly Origin[], RepositoryError>> {
    return this.#withMaintenance(async () => {
      try {
        const index = await this.#readIndex();
        // Reconciliation needs the indexed origin even when its record is corrupt,
        // so permission revocation can reach purgeOrigin instead of being blocked.
        return { ok: true, value: index.origins.map((entry) => entry.origin) };
      } catch (error: unknown) {
        return error instanceof AppError ? invalidStoredData() : repositoryFailure();
      }
    });
  }

  /** Removes indexed image records that no stored origin owns without loading payloads. */
  async cleanupOrphans(): Promise<Result<void, RepositoryError>> {
    return this.#withMaintenance(async () => {
      try {
        const index = await this.#readIndex();
        const owned = new Set(
          index.origins.flatMap((entry) =>
            entry.referenceId === null ? [] : [entry.referenceId],
          ),
        );
        const orphanIds = index.imageIds.filter((id) => !owned.has(id));
        const obsoleteKeys = (await this.#adapter.getKeys()).filter((key) =>
          key.startsWith(OBSOLETE_PAGE_STORAGE_PREFIX),
        );
        if (orphanIds.length === 0 && obsoleteKeys.length === 0)
          return { ok: true, value: undefined };
        await this.#adapter.remove([
          ...orphanIds.map(imageRecordKey),
          ...obsoleteKeys,
        ]);
        if (orphanIds.length > 0) {
          await this.#adapter.set({
            [ORIGIN_INDEX_KEY]: buildIndex(
              index.origins,
              index.imageIds.filter((id) => owned.has(id)),
            ),
          });
        }
        return { ok: true, value: undefined };
      } catch (error: unknown) {
        return error instanceof AppError ? invalidStoredData() : repositoryFailure();
      }
    });
  }

  async #load(url: URL): Promise<Result<LoadedState, RepositoryError>> {
    const origin = deriveOrigin(url);
    const pageKey = derivePageKey(url);
    if (origin === undefined || pageKey === undefined) return invalidStoredData();
    try {
      const index = await this.#readIndex();
      const key = originRecordKey(origin);
      const values = await this.#adapter.get([key]);
      const entry = index.origins.find((candidate) => candidate.origin === origin);
      const value = values[key];
      if (value === undefined) {
        if (entry !== undefined) return invalidStoredData();
        return { ok: true, value: { index, origin, pageKey, originRecord: null } };
      }
      const record = parseOriginRecordV1(value);
      if (
        !record.ok ||
        record.value.origin !== origin ||
        entry === undefined ||
        referenceId(record.value) !== entry.referenceId ||
        (entry.referenceId !== null && !index.imageIds.includes(entry.referenceId))
      ) {
        return invalidStoredData();
      }
      return { ok: true, value: { index, origin, pageKey, originRecord: record.value } };
    } catch (error: unknown) {
      return error instanceof AppError ? invalidStoredData() : repositoryFailure();
    }
  }

  async #mutate(
    url: URL,
    operation: (state: LoadedState) => Promise<OverlaySnapshot>,
  ): Promise<Result<OverlaySnapshot, RepositoryError>> {
    const origin = deriveOrigin(url);
    if (origin === undefined) return invalidStoredData();
    return this.#locked(origin, async () =>
      this.#withMaintenance(async () => {
        const state = await this.#load(url);
        if (!state.ok) return state;
        try {
          return { ok: true, value: await operation(state.value) };
        } catch (error: unknown) {
          return error instanceof AppError
            ? { ok: false, error }
            : repositoryFailure();
        }
      }),
    );
  }

  async #readIndex(): Promise<OriginIndexV2> {
    const values = await this.#adapter.get([ORIGIN_INDEX_KEY]);
    const stored = values[ORIGIN_INDEX_KEY];
    if (stored === undefined) return emptyIndex();
    const v2 = parseOriginIndexV2(stored);
    if (v2.ok) return v2.value;
    const v1 = parseOriginIndexV1(stored);
    if (!v1.ok) throw new AppError("invalid-stored-data");
    return this.#migrateV1();
  }

  /** The only non-purge full-store read upgrades the unpublished V1 index once. */
  async #migrateV1(): Promise<OriginIndexV2> {
    const values = await this.#adapter.readAll();
    const origins: OriginIndexV2["origins"][number][] = [];
    const owners = new Set<ReferenceId>();
    const imageIds = new Set<ReferenceId>();
    const obsoleteKeys = Object.keys(values).filter((key) =>
      key.startsWith(OBSOLETE_PAGE_STORAGE_PREFIX),
    );

    for (const [key, value] of Object.entries(values)) {
      if (!key.startsWith("pixel-pincher:origin:")) continue;
      const record = parseOriginRecordV1(value);
      if (!record.ok || key !== originRecordKey(record.value.origin)) continue;
      const id = referenceId(record.value);
      if (id !== null && owners.has(id))
        throw new AppError("invalid-stored-data");
      if (id !== null) owners.add(id);
      origins.push({ origin: record.value.origin, referenceId: id });
    }
    for (const key of Object.keys(values)) {
      if (!isImageRecordKey(key)) continue;
      const imageId = parseReferenceId(key.slice(IMAGE_RECORD_KEY_PREFIX.length));
      // Image payloads are deliberately not parsed during migration. A canonical
      // named key is enough to index corrupted payloads for later cleanup/purge.
      if (imageId.ok && key === imageRecordKey(imageId.value))
        imageIds.add(imageId.value);
    }
    const index = buildIndex(origins, [...imageIds]);
    await this.#adapter.set({ [ORIGIN_INDEX_KEY]: index });
    if (obsoleteKeys.length > 0) await this.#adapter.remove(obsoleteKeys);
    return index;
  }

  async #writeOrigin(
    state: LoadedState,
    origin: OriginRecordV1,
    index: OriginIndexV2,
  ): Promise<void> {
    await this.#adapter.set({
      [originRecordKey(state.origin)]: origin,
      [ORIGIN_INDEX_KEY]: this.#indexWithOrigin(
        index,
        state.origin,
        referenceId(origin),
      ),
    });
  }

  #indexWithOrigin(
    index: OriginIndexV2,
    origin: Origin,
    nextReferenceId: ReferenceId | null,
  ): OriginIndexV2 {
    const origins = [
      ...index.origins.filter((entry) => entry.origin !== origin),
      { origin, referenceId: nextReferenceId },
    ];
    const imageIds = new Set(index.imageIds);
    if (nextReferenceId !== null) imageIds.add(nextReferenceId);
    return buildIndex(origins, [...imageIds]);
  }

  #indexWithoutImage(index: OriginIndexV2, id: ReferenceId): OriginIndexV2 {
    return buildIndex(
      index.origins,
      index.imageIds.filter((imageId) => imageId !== id),
    );
  }

  async #rollbackReplacement(
    state: LoadedState,
    replacementIndex: OriginIndexV2,
    nextId: ReferenceId,
  ): Promise<void> {
    // Restore metadata first, but retain the replacement ID in the index until
    // its bytes are actually gone. A failed rollback can therefore be resumed
    // by cleanupOrphans or any clear/revocation purge.
    const rollbackIndex = this.#indexWithOrigin(
      replacementIndex,
      state.origin,
      referenceId(state.originRecord),
    );
    const restored: Record<string, unknown> = {
      [ORIGIN_INDEX_KEY]: rollbackIndex,
    };
    if (state.originRecord !== null)
      restored[originRecordKey(state.origin)] = state.originRecord;
    await this.#adapter.set(restored);
    await this.#adapter.remove([
      ...(state.originRecord === null ? [originRecordKey(state.origin)] : []),
      imageRecordKey(nextId),
    ]);
    await this.#adapter.set({ [ORIGIN_INDEX_KEY]: state.index });
  }

  /** Returns false only when malformed target metadata requires the deletion scan. */
  async #purgeFromValidIndex(origin: Origin): Promise<boolean> {
    const index = await this.#readIndex();
    const entry = index.origins.find((candidate) => candidate.origin === origin);
    const key = originRecordKey(origin);
    const values = await this.#adapter.get([key]);
    const value = values[key];
    if (value === undefined) {
      // An absent target record cannot prove that no target pages or orphaned
      // images remain after an interrupted or externally corrupted deletion.
      // Deletion is the only path allowed to scan those residual values.
      return false;
    }
    const record = parseOriginRecordV1(value);
    if (
      !record.ok ||
      record.value.origin !== origin ||
      entry === undefined ||
      referenceId(record.value) !== entry.referenceId
    ) {
      return false;
    }
    const remainingOrigins = index.origins.filter(
      (candidate) => candidate.origin !== origin,
    );
    const remainingImageIds = new Set(
      remainingOrigins.flatMap((candidate) =>
        candidate.referenceId === null ? [] : [candidate.referenceId],
      ),
    );
    // Replacement interruptions retain the previous ID in imageIds until its
    // remove phase completes. Clear/revocation must remove those bytes too.
    const imageIdsToRemove = index.imageIds.filter(
      (id) => !remainingImageIds.has(id),
    );
    const nextIndex = buildIndex(remainingOrigins, [...remainingImageIds]);
    // Key enumeration exposes names only, so cleanup can remove every obsolete
    // unpublished-record key without materializing unrelated image payloads.
    const obsoleteKeys = (await this.#adapter.getKeys()).filter((key) =>
      key.startsWith(OBSOLETE_PAGE_STORAGE_PREFIX),
    );
    await this.#adapter.remove([
      key,
      ...imageIdsToRemove.map(imageRecordKey),
      ...obsoleteKeys,
    ]);
    await this.#adapter.set({ [ORIGIN_INDEX_KEY]: nextIndex });
    return true;
  }

  /** Explicit deletion recovery: malformed records never prevent target-origin removal. */
  async #purgeFromCorruptState(
    target: Origin,
  ): Promise<Result<void, RepositoryError>> {
    try {
      const values = await this.#adapter.readAll();
      const records = new Map<Origin, OriginRecordV1>();
      const owners = new Map<ReferenceId, Origin[]>();
      const keysToRemove = [originRecordKey(target)];
      for (const [key, value] of Object.entries(values)) {
        if (key.startsWith(OBSOLETE_PAGE_STORAGE_PREFIX)) keysToRemove.push(key);
        if (!key.startsWith("pixel-pincher:origin:")) continue;
        const record = parseOriginRecordV1(value);
        if (
          !record.ok ||
          key !== originRecordKey(record.value.origin) ||
          record.value.origin === target
        ) {
          continue;
        }
        records.set(record.value.origin, record.value);
        const id = referenceId(record.value);
        if (id !== null) {
          const currentOwners = owners.get(id) ?? [];
          owners.set(id, [...currentOwners, record.value.origin]);
        }
      }
      const ambiguousIds = new Set<ReferenceId>();
      for (const [id, ownerOrigins] of owners) {
        if (ownerOrigins.length > 1) ambiguousIds.add(id);
      }
      const referencedImageKeys = new Set(
        [...owners.keys()].map(imageRecordKey),
      );
      for (const key of Object.keys(values)) {
        if (
          isImageRecordKey(key) &&
          !referencedImageKeys.has(key)
        ) {
          keysToRemove.push(key);
        }
      }
      if (keysToRemove.length > 0) await this.#adapter.remove(keysToRemove);
      const entries = [...records.values()].map((record) => {
        const id = referenceId(record);
        return {
          origin: record.origin,
          referenceId: id !== null && ambiguousIds.has(id) ? null : id,
        };
      });
      const index = buildIndex(entries, [...owners.keys()]);
      await this.#adapter.set({ [ORIGIN_INDEX_KEY]: index });
      return ambiguousIds.size === 0
        ? { ok: true, value: undefined }
        : invalidStoredData();
    } catch {
      return repositoryFailure();
    }
  }

  async #locked<T>(origin: Origin, operation: () => Promise<T>): Promise<T> {
    const previous = this.#locks.get(origin) ?? Promise.resolve();
    let release: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const queued = previous.then(() => gate);
    this.#locks.set(origin, queued);
    await previous;
    try {
      return await operation();
    } finally {
      release?.();
      if (this.#locks.get(origin) === queued) this.#locks.delete(origin);
    }
  }

  async #withMaintenance<T>(operation: () => Promise<T>): Promise<T> {
    const previous = this.#maintenance;
    let release: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    this.#maintenance = previous.then(() => gate);
    await previous;
    try {
      return await operation();
    } finally {
      release?.();
    }
  }
}
