import {
  AppError,
  DEFAULT_ORIGIN_SETTINGS,
  DEFAULT_SETTINGS,
  type Hydration,
  type ImportedReference,
  type Origin,
  type OriginIndexV1,
  type OriginRecordV1,
  type OverlaySettings,
  type OverlaySnapshot,
  type PageKey,
  type PageRecordV1,
  type RepositoryError,
  type Result,
  type SettingsPatch,
} from "../shared/contracts";
import {
  imageRecordKey,
  ORIGIN_INDEX_KEY,
  originRecordKey,
  pageRecordKey,
  deriveOrigin,
  derivePageKey,
} from "../shared/keys";
import {
  parseImageRecordV1,
  parseOriginIndexV1,
  parseOriginRecordV1,
  parsePageRecordV1,
} from "../shared/parse";
import type { StorageAdapter } from "./storage-adapter";

type LoadedState = Readonly<{
  origin: Origin;
  pageKey: PageKey;
  originRecord: OriginRecordV1 | null;
  pageRecord: PageRecordV1 | null;
}>;

function repositoryFailure(): Result<never, RepositoryError> {
  return { ok: false, error: new AppError("storage-failed") };
}

function invalidStoredData(): Result<never, RepositoryError> {
  return { ok: false, error: new AppError("invalid-stored-data") };
}

function patchSettings(settings: OverlaySettings, patch: SettingsPatch): OverlaySettings {
  switch (patch.kind) {
    case "visibility": return { ...settings, visible: patch.visible };
    case "opacity": return { ...settings, opacity: patch.opacity };
    case "inversion": return { ...settings, inverted: patch.inverted };
    case "sizing": return { ...settings, sizing: patch.sizing };
    case "interaction-mode": return { ...settings, interactionMode: patch.interactionMode };
    case "placement": return { ...settings, placement: patch.placement };
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

function emptyIndex(): OriginIndexV1 {
  return { schemaVersion: 1, origins: [] };
}

function snapshot(state: LoadedState): OverlaySnapshot {
  const record = state.originRecord;
  const revision = Math.max(record?.revision ?? 0, state.pageRecord?.revision ?? 0);
  const settings: OverlaySettings = {
    ...(record?.settings ?? DEFAULT_ORIGIN_SETTINGS),
    placement: state.pageRecord?.placement ?? DEFAULT_SETTINGS.placement,
  };
  return { revision, origin: state.origin, pageKey: state.pageKey, settings, reference: record?.reference ?? null };
}

/** Persistent per-origin repository. Every mutation for one origin is serialized. */
export class OverlayRepository {
  readonly #adapter: StorageAdapter;
  readonly #locks = new Map<Origin, Promise<void>>();

  constructor(adapter: StorageAdapter) {
    this.#adapter = adapter;
  }

  async getSnapshot(url: URL): Promise<Result<OverlaySnapshot, RepositoryError>> {
    const state = await this.#load(url);
    return state.ok ? { ok: true, value: snapshot(state.value) } : state;
  }

  async hydrate(url: URL): Promise<Result<Hydration, RepositoryError>> {
    const state = await this.#load(url);
    if (!state.ok) return state;
    const current = snapshot(state.value);
    if (current.reference === null) {
      return { ok: true, value: { snapshot: { ...current, reference: null }, reference: null } };
    }
    const key = imageRecordKey(current.reference.id);
    try {
      const values = await this.#adapter.get([key]);
      const image = parseImageRecordV1(values[key]);
      if (!image.ok || image.value.referenceId !== current.reference.id) return invalidStoredData();
      return { ok: true, value: { snapshot: { ...current, reference: current.reference }, reference: { metadata: current.reference, dataUrl: image.value.dataUrl } } };
    } catch {
      return repositoryFailure();
    }
  }

  async updateSettings(url: URL, patch: SettingsPatch): Promise<Result<OverlaySnapshot, RepositoryError>> {
    return this.#mutate(url, async (state) => {
      const before = snapshot(state);
      const next = patchSettings(before.settings, patch);
      const revision = before.revision + 1;
      const origin: OriginRecordV1 = { schemaVersion: 1, revision, origin: state.origin, settings: originSettings(next), reference: before.reference };
      const values: Record<string, unknown> = { [originRecordKey(state.origin)]: origin };
      if (patch.kind === "placement") {
        const page: PageRecordV1 = { schemaVersion: 1, revision, origin: state.origin, pageKey: state.pageKey, placement: patch.placement };
        values[pageRecordKey(state.pageKey)] = page;
      }
      await this.#adapter.set(values);
      await this.#addToIndex(state.origin);
      return { revision, origin: state.origin, pageKey: state.pageKey, settings: next, reference: before.reference };
    });
  }

  async replaceReference(url: URL, reference: ImportedReference): Promise<Result<OverlaySnapshot, RepositoryError>> {
    return this.#mutate(url, async (state) => {
      const before = snapshot(state);
      const revision = before.revision + 1;
      const imageKey = imageRecordKey(reference.metadata.id);
      const origin: OriginRecordV1 = { schemaVersion: 1, revision, origin: state.origin, settings: originSettings(before.settings), reference: reference.metadata };
      try {
        await this.#adapter.set({ [imageKey]: { schemaVersion: 1, referenceId: reference.metadata.id, dataUrl: reference.dataUrl } });
        await this.#adapter.set({ [originRecordKey(state.origin)]: origin });
        await this.#addToIndex(state.origin);
      } catch {
        try { await this.#adapter.remove([imageKey]); } catch { /* best effort rollback */ }
        throw new AppError("storage-failed");
      }
      if (before.reference !== null && before.reference.id !== reference.metadata.id) {
        try { await this.#adapter.remove([imageRecordKey(before.reference.id)]); } catch { /* replacement already committed */ }
      }
      return { revision, origin: state.origin, pageKey: state.pageKey, settings: before.settings, reference: reference.metadata };
    });
  }

  async clearOrigin(origin: Origin): Promise<Result<void, RepositoryError>> {
    return this.#locked(origin, async () => {
      try {
        const values = await this.#adapter.get([originRecordKey(origin), ORIGIN_INDEX_KEY]);
        const record = values[originRecordKey(origin)] === undefined ? null : parseOriginRecordV1(values[originRecordKey(origin)]);
        if (record !== null && !record.ok) return invalidStoredData();
        const index = values[ORIGIN_INDEX_KEY] === undefined
          ? { ok: true as const, value: emptyIndex() }
          : parseOriginIndexV1(values[ORIGIN_INDEX_KEY]);
        if (!index.ok) return invalidStoredData();
        const pageKeys = await this.#pageKeysForOrigin();
        const keys = [originRecordKey(origin), ...pageKeys];
        if (record !== null && record.value.reference !== null) {
          keys.push(imageRecordKey(record.value.reference.id));
        }
        await this.#adapter.remove(keys);
        await this.#adapter.set({ [ORIGIN_INDEX_KEY]: { schemaVersion: 1, origins: index.value.origins.filter((item) => item !== origin) } });
        return { ok: true, value: undefined };
      } catch {
        return repositoryFailure();
      }
    });
  }

  async cleanupOrphans(): Promise<Result<void, RepositoryError>> {
    try {
      const values = await this.#adapter.get([ORIGIN_INDEX_KEY]);
      if (values[ORIGIN_INDEX_KEY] === undefined) return { ok: true, value: undefined };
      const index = parseOriginIndexV1(values[ORIGIN_INDEX_KEY]);
      if (!index.ok) return invalidStoredData();
      for (const origin of index.value.origins) {
        const record = await this.#adapter.get([originRecordKey(origin)]);
        if (record[originRecordKey(origin)] === undefined) await this.#removeFromIndex(origin);
      }
      return { ok: true, value: undefined };
    } catch {
      return repositoryFailure();
    }
  }

  async #load(url: URL): Promise<Result<LoadedState, RepositoryError>> {
    const origin = deriveOrigin(url);
    const pageKey = derivePageKey(url);
    if (origin === undefined || pageKey === undefined) return invalidStoredData();
    const originKey = originRecordKey(origin);
    const pageKeyName = pageRecordKey(pageKey);
    try {
      const values = await this.#adapter.get([originKey, pageKeyName]);
      const originRecord = values[originKey] === undefined ? null : parseOriginRecordV1(values[originKey]);
      const pageRecord = values[pageKeyName] === undefined ? null : parsePageRecordV1(values[pageKeyName]);
      if ((originRecord !== null && !originRecord.ok) || (pageRecord !== null && !pageRecord.ok)) return invalidStoredData();
      return { ok: true, value: { origin, pageKey, originRecord: originRecord?.value ?? null, pageRecord: pageRecord?.value ?? null } };
    } catch {
      return repositoryFailure();
    }
  }

  async #mutate(url: URL, operation: (state: LoadedState) => Promise<OverlaySnapshot>): Promise<Result<OverlaySnapshot, RepositoryError>> {
    const origin = deriveOrigin(url);
    if (origin === undefined) return invalidStoredData();
    return this.#locked(origin, async () => {
      const state = await this.#load(url);
      if (!state.ok) return state;
      try { return { ok: true, value: await operation(state.value) }; }
      catch (error: unknown) { return error instanceof AppError ? { ok: false, error } : repositoryFailure(); }
    });
  }

  async #locked<T>(origin: Origin, operation: () => Promise<T>): Promise<T> {
    const previous = this.#locks.get(origin) ?? Promise.resolve();
    let release: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const queued = previous.then(() => gate);
    this.#locks.set(origin, queued);
    await previous;
    try { return await operation(); }
    finally { release?.(); if (this.#locks.get(origin) === queued) this.#locks.delete(origin); }
  }

  async #addToIndex(origin: Origin): Promise<void> {
    const values = await this.#adapter.get([ORIGIN_INDEX_KEY]);
    const parsed = values[ORIGIN_INDEX_KEY] === undefined
      ? { ok: true as const, value: emptyIndex() }
      : parseOriginIndexV1(values[ORIGIN_INDEX_KEY]);
    if (!parsed.ok) throw new AppError("invalid-stored-data");
    const origins = [...parsed.value.origins, origin].filter((value, index, all) => all.indexOf(value) === index).sort();
    const index: OriginIndexV1 = { schemaVersion: 1, origins };
    await this.#adapter.set({ [ORIGIN_INDEX_KEY]: index });
  }

  async #removeFromIndex(origin: Origin): Promise<void> {
    const values = await this.#adapter.get([ORIGIN_INDEX_KEY]);
    const parsed = values[ORIGIN_INDEX_KEY] === undefined
      ? { ok: true as const, value: emptyIndex() }
      : parseOriginIndexV1(values[ORIGIN_INDEX_KEY]);
    if (!parsed.ok) throw new AppError("invalid-stored-data");
    await this.#adapter.set({ [ORIGIN_INDEX_KEY]: { schemaVersion: 1, origins: parsed.value.origins.filter((value) => value !== origin) } });
  }

  async #pageKeysForOrigin(): Promise<string[]> {
    // chrome.storage has no key-prefix query; future adapter versions may provide it.
    // Page cleanup is therefore performed when an origin's pages are explicitly known.
    return [];
  }
}
