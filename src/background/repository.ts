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
  pageRecordKeyOrigin,
  deriveOrigin,
  derivePageKey,
} from "../shared/keys";
import {
  parseImageRecordV1,
  parseImportedReference,
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
  #maintenance: Promise<void> = Promise.resolve();

  constructor(adapter: StorageAdapter) {
    this.#adapter = adapter;
  }

  async readSnapshot(url: URL): Promise<Result<OverlaySnapshot, RepositoryError>> {
    const state = await this.#load(url);
    return state.ok ? { ok: true, value: snapshot(state.value) } : state;
  }

  /** Backwards-compatible alias for callers created before the Task 2 contract was finalized. */
  async getSnapshot(url: URL): Promise<Result<OverlaySnapshot, RepositoryError>> {
    return this.readSnapshot(url);
  }

  async readHydration(url: URL): Promise<Result<Hydration, RepositoryError>> {
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
      if (!image.ok || image.value.referenceId !== current.reference.id || key !== imageRecordKey(image.value.referenceId)) return invalidStoredData();
      const imported = parseImportedReference({ metadata: current.reference, dataUrl: image.value.dataUrl });
      if (!imported.ok) return invalidStoredData();
      return { ok: true, value: { snapshot: { ...current, reference: current.reference }, reference: imported.value } };
    } catch {
      return repositoryFailure();
    }
  }

  /** Backwards-compatible alias for callers created before the Task 2 contract was finalized. */
  async hydrate(url: URL): Promise<Result<Hydration, RepositoryError>> {
    return this.readHydration(url);
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
      await this.#writeWithIndex(state.origin, values);
      return { revision, origin: state.origin, pageKey: state.pageKey, settings: next, reference: before.reference };
    });
  }

  async updatePlacement(url: URL, placement: OverlaySettings["placement"]): Promise<Result<OverlaySnapshot, RepositoryError>> {
    return this.updateSettings(url, { kind: "placement", placement });
  }

  async replaceReference(url: URL, reference: ImportedReference): Promise<Result<OverlaySnapshot, RepositoryError>> {
    return this.#mutate(url, async (state) => {
      const before = snapshot(state);
      const revision = before.revision + 1;
      const imageKey = imageRecordKey(reference.metadata.id);
      const origin: OriginRecordV1 = { schemaVersion: 1, revision, origin: state.origin, settings: originSettings(before.settings), reference: reference.metadata };
      try {
        await this.#adapter.set({ [imageKey]: { schemaVersion: 1, referenceId: reference.metadata.id, dataUrl: reference.dataUrl } });
        await this.#writeWithIndex(state.origin, { [originRecordKey(state.origin)]: origin });
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
    return this.#locked(origin, async () => this.#withMaintenance(async () => {
      try {
        const values = await this.#adapter.get([originRecordKey(origin), ORIGIN_INDEX_KEY]);
        const allValues = await this.#adapter.readAll();
        const record = values[originRecordKey(origin)] === undefined ? null : parseOriginRecordV1(values[originRecordKey(origin)]);
        const validRecord = record !== null && record.ok && record.value.origin === origin ? record.value : null;
        const index = values[ORIGIN_INDEX_KEY] === undefined
          ? { ok: true as const, value: emptyIndex() }
          : parseOriginIndexV1(values[ORIGIN_INDEX_KEY]);
        const pageKeys = this.#pageKeysForOrigin(allValues, origin);
        const keys = [originRecordKey(origin), ...pageKeys];
        if (validRecord?.reference !== null && validRecord !== null) keys.push(imageRecordKey(validRecord.reference.id));
        await this.#adapter.remove(keys);
        const remainingOrigins = index.ok
          ? index.value.origins.filter((item) => item !== origin)
          : this.#originsFromValues(allValues, origin);
        await this.#adapter.set({ [ORIGIN_INDEX_KEY]: { schemaVersion: 1, origins: remainingOrigins } });
        return { ok: true, value: undefined };
      } catch {
        return repositoryFailure();
      }
    }));
  }

  async listOrigins(): Promise<Result<readonly Origin[], RepositoryError>> {
    return this.#withMaintenance(async () => {
      try {
        const values = await this.#adapter.readAll();
        return { ok: true, value: this.#originsFromValues(values) };
      } catch {
        return repositoryFailure();
      }
    });
  }

  async removeOrphans(): Promise<Result<void, RepositoryError>> {
    return this.cleanupOrphans();
  }

  async cleanupOrphans(): Promise<Result<void, RepositoryError>> {
    return this.#withMaintenance(async () => {
    try {
      const values = await this.#adapter.readAll();
      const storedIndex = values[ORIGIN_INDEX_KEY] === undefined
        ? { ok: true as const, value: emptyIndex() }
        : parseOriginIndexV1(values[ORIGIN_INDEX_KEY]);
      if (!storedIndex.ok) return invalidStoredData();

      const origins = new Set<Origin>();
      const referencedImages = new Set<string>();
      for (const [key, value] of Object.entries(values)) {
        if (!key.startsWith("pixel-pincher:origin:")) continue;
        const record = parseOriginRecordV1(value);
        if (!record.ok || key !== originRecordKey(record.value.origin)) return invalidStoredData();
        origins.add(record.value.origin);
        if (record.value.reference !== null) referencedImages.add(imageRecordKey(record.value.reference.id));
      }

      const orphanKeys: string[] = [];
      for (const key of Object.keys(values)) {
        const pageOrigin = pageRecordKeyOrigin(key);
        if (pageOrigin !== undefined && !origins.has(pageOrigin)) orphanKeys.push(key);
        if (key.startsWith("pixel-pincher:image:") && !referencedImages.has(key)) orphanKeys.push(key);
      }
      if (orphanKeys.length > 0) await this.#adapter.remove(orphanKeys);

      const nextOrigins = [...origins].sort();
      if (nextOrigins.length !== storedIndex.value.origins.length || nextOrigins.some((origin, index) => origin !== storedIndex.value.origins[index])) {
        await this.#adapter.set({ [ORIGIN_INDEX_KEY]: { schemaVersion: 1, origins: nextOrigins } });
      }
      return { ok: true, value: undefined };
    } catch {
      return repositoryFailure();
    }
    });
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
      if ((originRecord !== null && originRecord.value.origin !== origin) || (pageRecord !== null && (pageRecord.value.origin !== origin || pageRecord.value.pageKey !== pageKey))) return invalidStoredData();
      return { ok: true, value: { origin, pageKey, originRecord: originRecord?.value ?? null, pageRecord: pageRecord?.value ?? null } };
    } catch {
      return repositoryFailure();
    }
  }

  async #mutate(url: URL, operation: (state: LoadedState) => Promise<OverlaySnapshot>): Promise<Result<OverlaySnapshot, RepositoryError>> {
    const origin = deriveOrigin(url);
    if (origin === undefined) return invalidStoredData();
    return this.#locked(origin, async () => this.#withMaintenance(async () => {
      const state = await this.#load(url);
      if (!state.ok) return state;
      try { return { ok: true, value: await operation(state.value) }; }
      catch (error: unknown) { return error instanceof AppError ? { ok: false, error } : repositoryFailure(); }
    }));
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

  async #withMaintenance<T>(operation: () => Promise<T>): Promise<T> {
    const previous = this.#maintenance;
    let release: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    this.#maintenance = previous.then(() => gate);
    await previous;
    try { return await operation(); }
    finally { release?.(); }
  }

  /** Writes the origin mutation and its index membership in one adapter set. */
  async #writeWithIndex(origin: Origin, values: Readonly<Record<string, unknown>>): Promise<void> {
      const stored = await this.#adapter.get([ORIGIN_INDEX_KEY]);
      const parsed = stored[ORIGIN_INDEX_KEY] === undefined
        ? { ok: true as const, value: emptyIndex() }
        : parseOriginIndexV1(stored[ORIGIN_INDEX_KEY]);
      if (!parsed.ok) throw new AppError("invalid-stored-data");
      const origins = [...new Set([...parsed.value.origins, origin])].sort();
      await this.#adapter.set({ ...values, [ORIGIN_INDEX_KEY]: { schemaVersion: 1, origins } });
  }

  #originsFromValues(values: Readonly<Record<string, unknown>>, excluded?: Origin): Origin[] {
    return Object.entries(values).flatMap(([key, value]) => {
      const record = parseOriginRecordV1(value);
      return record.ok && record.value.origin !== excluded && key === originRecordKey(record.value.origin) ? [record.value.origin] : [];
    }).sort();
  }

  #pageKeysForOrigin(values: Readonly<Record<string, unknown>>, origin: Origin): string[] {
    return Object.keys(values).filter((key) => pageRecordKeyOrigin(key) === origin);
  }
}
