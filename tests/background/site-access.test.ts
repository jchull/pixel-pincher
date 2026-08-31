import { describe, expect, it, vi } from "vitest";

import { AppError, type Origin } from "../../src/shared/contracts";
import { OverlayRepository } from "../../src/background/repository";
import type { StorageAdapter } from "../../src/background/storage-adapter";
import {
  createChromeSiteAccessAdapter,
  OVERLAY_REGISTRATION_PREFIX,
  originFromMatch,
  type ObservedRegistration,
  type RuntimeRegistration,
  type SiteAccessAdapter,
  SiteAccessService,
  registrationForOrigin,
  registrationIdForOrigin,
} from "../../src/background/site-access";
import {
  deriveOrigin,
  imageRecordKey,
  ORIGIN_INDEX_KEY,
  originRecordKey,
} from "../../src/shared/keys";
import { parseReferenceId } from "../../src/shared/parse";

class MemoryStorage implements StorageAdapter {
  readonly values = new Map<string, unknown>();

  async get(keys: readonly string[]): Promise<Readonly<Record<string, unknown>>> {
    const result: Record<string, unknown> = {};
    for (const key of keys) {
      const value = this.values.get(key);
      if (value !== undefined) result[key] = value;
    }
    return result;
  }

  async getKeys(): Promise<readonly string[]> {
    return [...this.values.keys()];
  }

  async readAll(): Promise<Readonly<Record<string, unknown>>> {
    return Object.fromEntries(this.values);
  }

  async set(values: Readonly<Record<string, unknown>>): Promise<void> {
    for (const [key, value] of Object.entries(values)) this.values.set(key, value);
  }

  async remove(keys: readonly string[]): Promise<void> {
    for (const key of keys) this.values.delete(key);
  }
}

class FakeSiteAccessAdapter implements SiteAccessAdapter {
  readonly grants = new Set<string>();
  readonly injected: Array<{ files: readonly string[]; tabId: number }> = [];
  readonly registrations: ObservedRegistration[] = [];
  executeFails = false;
  registerAsDuplicate = false;
  registerFails = false;
  revokeOnRegister = false;
  unregisterAsRace = false;
  unregisterFails = false;
  unregisterLeavesRegistration = false;
  updateFails = false;

  async containsOrigin(originMatch: string): Promise<boolean> {
    return this.grants.has(originMatch);
  }

  async executeScript(tabId: number, files: readonly string[]): Promise<void> {
    if (this.executeFails) throw new Error("execute failed");
    this.injected.push({ files, tabId });
  }

  async getGrantedOrigins(): Promise<readonly string[]> {
    return [...this.grants];
  }

  async getRegistrations(): Promise<readonly ObservedRegistration[]> {
    return this.registrations;
  }

  async register(registration: RuntimeRegistration): Promise<void> {
    if (this.registerFails) throw new Error("register failed");
    this.registrations.push(registration);
    if (this.revokeOnRegister) this.grants.delete(registration.matches[0] ?? "");
    if (this.registerAsDuplicate) throw new Error("duplicate registration");
  }

  async unregister(ids: readonly string[]): Promise<void> {
    if (this.unregisterLeavesRegistration) return;
    for (const id of ids) {
      const index = this.registrations.findIndex((registration) => registration.id === id);
      if (index >= 0) this.registrations.splice(index, 1);
    }
    if (this.unregisterFails || this.unregisterAsRace) throw new Error("unregister failed");
  }

  async update(registration: RuntimeRegistration): Promise<void> {
    if (this.updateFails) throw new Error("update failed");
    await this.unregister([registration.id]);
    await this.register(registration);
  }
}

function getOrigin(url: URL) {
  const origin = deriveOrigin(url);
  if (origin === undefined) throw new Error("Test URL must have an origin.");
  return origin;
}

describe("createChromeSiteAccessAdapter", () => {
  it("uses top-frame-only injection and translates Chrome defaults", async () => {
    const executeScript = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(globalThis, "chrome", {
      configurable: true,
      value: {
        permissions: {
          contains: vi.fn().mockResolvedValue(true),
          getAll: vi.fn().mockResolvedValue({}),
        },
        scripting: {
          executeScript,
          getRegisteredContentScripts: vi.fn().mockResolvedValue([{
            id: "other-extension-registration",
            js: ["other.js"],
            matches: ["https://other.example/*"],
          }]),
          registerContentScripts: vi.fn().mockResolvedValue(undefined),
          unregisterContentScripts: vi.fn().mockResolvedValue(undefined),
          updateContentScripts: vi.fn().mockResolvedValue(undefined),
        },
      },
      writable: true,
    });
    const adapter = createChromeSiteAccessAdapter();

    await adapter.executeScript(12, ["content-scripts/overlay.js"]);
    expect(executeScript).toHaveBeenCalledWith({
      files: ["content-scripts/overlay.js"],
      target: { frameIds: [0], tabId: 12 },
    });
    await expect(adapter.getGrantedOrigins()).resolves.toEqual([]);
    await expect(adapter.getRegistrations()).resolves.toEqual([expect.objectContaining({
      allFrames: false,
      css: [],
      excludeMatches: [],
      matchOriginAsFallback: false,
      persistAcrossSessions: true,
      runAt: "document_idle",
      world: "ISOLATED",
    })]);
  });

  it("translates permission and registration operations to exact Chrome arguments", async () => {
    const contains = vi.fn().mockResolvedValue(true);
    const registerContentScripts = vi.fn().mockResolvedValue(undefined);
    const unregisterContentScripts = vi.fn().mockResolvedValue(undefined);
    const updateContentScripts = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(globalThis, "chrome", {
      configurable: true,
      value: {
        permissions: { contains, getAll: vi.fn().mockResolvedValue({ origins: [] }) },
        scripting: {
          executeScript: vi.fn().mockResolvedValue(undefined),
          getRegisteredContentScripts: vi.fn().mockResolvedValue([]),
          registerContentScripts,
          unregisterContentScripts,
          updateContentScripts,
        },
      },
      writable: true,
    });
    const adapter = createChromeSiteAccessAdapter();
    const registration = await registrationForOrigin(getOrigin(new URL("https://example.com/page")));

    await expect(adapter.containsOrigin("https://example.com/*")).resolves.toBe(true);
    await adapter.register(registration);
    await adapter.update(registration);
    await adapter.unregister([registration.id]);

    expect(contains).toHaveBeenCalledWith({ origins: ["https://example.com/*"] });
    const expectedRegistration = {
      ...registration,
      css: [],
      excludeMatches: [],
      js: ["content-scripts/overlay.js"],
      matches: ["https://example.com/*"],
    };
    expect(registerContentScripts).toHaveBeenCalledWith([expectedRegistration]);
    expect(updateContentScripts).toHaveBeenCalledWith([expectedRegistration]);
    expect(unregisterContentScripts).toHaveBeenCalledWith({ ids: [registration.id] });
  });
});

describe("SiteAccessService", () => {
  it("parses only exact supported origin permission matches", () => {
    expect(originFromMatch("https://example.com/*")).toBe(getOrigin(new URL("https://example.com/page")));
    expect(originFromMatch("https://*/*")).toBeUndefined();
    expect(originFromMatch("https://example.com/path/*")).toBeUndefined();
    expect(originFromMatch("chrome://extensions/*")).toBeUndefined();
  });

  it("rejects registration without an optional origin grant", async () => {
    const service = new SiteAccessService(new FakeSiteAccessAdapter(), new OverlayRepository(new MemoryStorage()));
    const result = await service.ensureForUrl(new URL("https://example.com/page"));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("site-access-revoked");
  });

  it("treats a duplicate registration as success after final-state verification", async () => {
    const adapter = new FakeSiteAccessAdapter();
    adapter.grants.add("https://example.com/*");
    adapter.registerAsDuplicate = true;
    const service = new SiteAccessService(adapter, new OverlayRepository(new MemoryStorage()));

    expect((await service.ensureForUrl(new URL("https://example.com/page"))).ok).toBe(true);
  });

  it("registers, verifies, repairs stale state, and injects only frame zero", async () => {
    const adapter = new FakeSiteAccessAdapter();
    adapter.grants.add("https://example.com/*");
    const service = new SiteAccessService(adapter, new OverlayRepository(new MemoryStorage()));
    const url = new URL("https://example.com/page");
    const origin = getOrigin(url);
    const expected = await registrationForOrigin(origin);
    adapter.registrations.push({ ...expected, allFrames: true });

    expect((await service.ensureForUrl(url)).ok).toBe(true);
    expect(adapter.registrations).toEqual([expected]);
    expect((await service.injectForUrl(url, 7)).ok).toBe(true);
    expect(adapter.injected).toEqual([{ files: ["content-scripts/overlay.js"], tabId: 7 }]);
  });

  it("preserves a valid managed registration with permission but no stored origin", async () => {
    const adapter = new FakeSiteAccessAdapter();
    const origin = getOrigin(new URL("https://example.com/page"));
    const registration = await registrationForOrigin(origin);
    adapter.grants.add("https://example.com/*");
    adapter.registrations.push(registration);
    const service = new SiteAccessService(adapter, new OverlayRepository(new MemoryStorage()));

    expect((await service.reconcile()).ok).toBe(true);
    expect(adapter.registrations).toEqual([registration]);
  });

  it("does not create a registration from permission alone or broad permission", async () => {
    const adapter = new FakeSiteAccessAdapter();
    adapter.grants.add("https://example.com/*");
    adapter.grants.add("https://*/*");
    const service = new SiteAccessService(adapter, new OverlayRepository(new MemoryStorage()));

    expect((await service.reconcile()).ok).toBe(true);
    expect(adapter.registrations).toEqual([]);
  });

  it("leaves unrelated registrations alone and de-duplicates stored origins during reconciliation", async () => {
    const adapter = new FakeSiteAccessAdapter();
    const origin = getOrigin(new URL("https://example.com/page"));
    const unrelated = {
      ...(await registrationForOrigin(getOrigin(new URL("https://other.example/page")))),
      id: "other-extension-registration",
    };
    adapter.grants.add("https://example.com/*");
    adapter.registrations.push(unrelated);
    const repository: Pick<OverlayRepository, "purgeOrigin" | "listOrigins"> = {
      async purgeOrigin() { return { ok: true, value: undefined }; },
      async listOrigins() { return { ok: true, value: [origin, origin] }; },
    };
    const service = new SiteAccessService(adapter, repository);

    await expect(service.reconcile()).resolves.toEqual({ ok: true, value: undefined });
    expect(adapter.registrations).toHaveLength(2);
    expect(adapter.registrations).toContainEqual(unrelated);
  });

  it("uses a deterministic SHA-256 registration ID and full runtime registration shape", async () => {
    const origin = getOrigin(new URL("https://example.com/page"));
    await expect(registrationIdForOrigin(origin)).resolves.toBe(
      `${OVERLAY_REGISTRATION_PREFIX}100680ad546ce6a577f42f52df33b4cfdca756859e664b8d7de329b150d09ce9`,
    );
    await expect(registrationForOrigin(origin)).resolves.toEqual({
      allFrames: false,
      css: [],
      excludeMatches: [],
      id: `${OVERLAY_REGISTRATION_PREFIX}100680ad546ce6a577f42f52df33b4cfdca756859e664b8d7de329b150d09ce9`,
      js: ["content-scripts/overlay.js"],
      matchOriginAsFallback: false,
      matches: ["https://example.com/*"],
      persistAcrossSessions: true,
      runAt: "document_idle",
      world: "ISOLATED",
    });
  });

  it("repairs CSS and execution-world registration drift", async () => {
    const adapter = new FakeSiteAccessAdapter();
    const url = new URL("https://example.com/page");
    const origin = getOrigin(url);
    const expected = await registrationForOrigin(origin);
    adapter.grants.add("https://example.com/*");
    adapter.registrations.push({ ...expected, css: ["stale.css"], world: "MAIN" });
    const service = new SiteAccessService(adapter, new OverlayRepository(new MemoryStorage()));

    expect((await service.ensureForUrl(url)).ok).toBe(true);
    expect(adapter.registrations).toEqual([expected]);
  });

  it("reports current managed state without mutating permission or registrations", async () => {
    const adapter = new FakeSiteAccessAdapter();
    const origin = getOrigin(new URL("https://example.com/page"));
    const service = new SiteAccessService(adapter, new OverlayRepository(new MemoryStorage()));

    await expect(service.has(origin)).resolves.toEqual({ ok: true, value: false });
    expect(adapter.registrations).toEqual([]);

    adapter.grants.add("https://example.com/*");
    await expect(service.has(origin)).resolves.toEqual({ ok: true, value: false });
    expect(adapter.registrations).toEqual([]);

    adapter.registrations.push(await registrationForOrigin(origin));
    await expect(service.has(origin)).resolves.toEqual({ ok: true, value: true });
  });

  it("removes a just-registered script when permission is revoked during registration", async () => {
    const adapter = new FakeSiteAccessAdapter();
    adapter.grants.add("https://example.com/*");
    adapter.revokeOnRegister = true;
    const service = new SiteAccessService(adapter, new OverlayRepository(new MemoryStorage()));

    const result = await service.ensureForUrl(new URL("https://example.com/page"));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("site-access-revoked");
    expect(adapter.registrations).toEqual([]);
  });

  it("reports failed registration, update, and injection operations as unavailable", async () => {
    const adapter = new FakeSiteAccessAdapter();
    adapter.grants.add("https://example.com/*");
    adapter.registerFails = true;
    const service = new SiteAccessService(adapter, new OverlayRepository(new MemoryStorage()));

    const registration = await service.ensureForUrl(new URL("https://example.com/page"));
    expect(registration.ok).toBe(false);
    if (!registration.ok) expect(registration.error.code).toBe("content-unavailable");

    adapter.registerFails = false;
    await service.ensureForUrl(new URL("https://example.com/page"));
    adapter.registrations[0] = { ...adapter.registrations[0]!, allFrames: true };
    adapter.updateFails = true;
    const update = await service.ensureForUrl(new URL("https://example.com/page"));
    expect(update.ok).toBe(false);
    if (!update.ok) expect(update.error.code).toBe("content-unavailable");
    adapter.updateFails = false;
    await service.ensureForUrl(new URL("https://example.com/page"));
    adapter.executeFails = true;
    const injection = await service.injectForUrl(new URL("https://example.com/page"), 7);
    expect(injection.ok).toBe(false);
    if (!injection.ok) expect(injection.error.code).toBe("content-unavailable");
  });

  it("rejects restricted URLs and invalid tab IDs without using Chrome APIs", async () => {
    const adapter = new FakeSiteAccessAdapter();
    const service = new SiteAccessService(adapter, new OverlayRepository(new MemoryStorage()));

    await expect(service.ensureForUrl(new URL("chrome://extensions"))).resolves.toEqual({
      ok: false,
      error: expect.objectContaining({ code: "content-unavailable" }),
    });
    await expect(service.injectForUrl(new URL("https://example.com"), -1)).resolves.toEqual({
      ok: false,
      error: expect.objectContaining({ code: "content-unavailable" }),
    });
    expect(adapter.injected).toEqual([]);
  });

  it("never repairs or registers while injecting", async () => {
    const adapter = new FakeSiteAccessAdapter();
    const url = new URL("https://example.com/page");
    adapter.grants.add("https://example.com/*");
    const service = new SiteAccessService(adapter, new OverlayRepository(new MemoryStorage()));

    expect((await service.injectForUrl(url, 7)).ok).toBe(false);
    expect(adapter.registrations).toEqual([]);
    expect(adapter.injected).toEqual([]);
  });

  it("treats missing and race-removed registrations as successful unregisters but reports survivors", async () => {
    const adapter = new FakeSiteAccessAdapter();
    const origin = getOrigin(new URL("https://example.com/page"));
    const service = new SiteAccessService(adapter, new OverlayRepository(new MemoryStorage()));

    await expect(service.unregisterOrigin(origin)).resolves.toEqual({ ok: true, value: undefined });
    adapter.registrations.push(await registrationForOrigin(origin));
    adapter.unregisterAsRace = true;
    await expect(service.unregisterOrigin(origin)).resolves.toEqual({ ok: true, value: undefined });
    adapter.unregisterAsRace = false;
    adapter.registrations.push(await registrationForOrigin(origin));
    adapter.unregisterLeavesRegistration = true;
    const survivor = await service.unregisterOrigin(origin);
    expect(survivor.ok).toBe(false);
    if (!survivor.ok) expect(survivor.error.code).toBe("content-unavailable");
  });

  it("continues revoked-site data cleanup when unregister fails", async () => {
    const adapter = new FakeSiteAccessAdapter();
    const origin = getOrigin(new URL("https://example.com/page"));
    const registration = await registrationForOrigin(origin);
    adapter.registrations.push(registration);
    adapter.unregisterFails = true;
    adapter.unregisterLeavesRegistration = true;
    const cleared: Origin[] = [];
    const repository: Pick<OverlayRepository, "purgeOrigin" | "listOrigins"> = {
      async purgeOrigin(value) {
        cleared.push(value);
        return { ok: true, value: undefined };
      },
      async listOrigins() {
        return { ok: true, value: [origin] };
      },
    };
    const service = new SiteAccessService(adapter, repository);

    const result = await service.reconcile();
    expect(result.ok).toBe(false);
    expect(cleared).toEqual([origin]);
  });

  it("continues clearing later revoked origins after an earlier clear failure", async () => {
    const adapter = new FakeSiteAccessAdapter();
    const first = getOrigin(new URL("https://first.example/page"));
    const second = getOrigin(new URL("https://second.example/page"));
    const cleared: Origin[] = [];
    const repository: Pick<OverlayRepository, "purgeOrigin" | "listOrigins"> = {
      async purgeOrigin(origin) {
        cleared.push(origin);
        return origin === first
          ? { ok: false as const, error: new AppError("storage-failed") }
          : { ok: true as const, value: undefined };
      },
      async listOrigins() { return { ok: true, value: [first, second] }; },
    };
    const service = new SiteAccessService(adapter, repository);

    expect((await service.reconcile()).ok).toBe(false);
    expect(cleared).toEqual([first, second]);
  });

  it("serializes concurrent reconciliation, registration, and injection operations", async () => {
    class ConcurrentAdapter extends FakeSiteAccessAdapter {
      activeContains = 0;
      maxActiveContains = 0;

      override async containsOrigin(originMatch: string): Promise<boolean> {
        this.activeContains += 1;
        this.maxActiveContains = Math.max(this.maxActiveContains, this.activeContains);
        await Promise.resolve();
        this.activeContains -= 1;
        return super.containsOrigin(originMatch);
      }
    }

    const adapter = new ConcurrentAdapter();
    const url = new URL("https://example.com/page");
    const origin = getOrigin(url);
    adapter.grants.add("https://example.com/*");
    const repository: Pick<OverlayRepository, "purgeOrigin" | "listOrigins"> = {
      async purgeOrigin() { return { ok: true, value: undefined }; },
      async listOrigins() { return { ok: true, value: [origin] }; },
    };
    const service = new SiteAccessService(adapter, repository);

    const [reconciled, ensured, injected] = await Promise.all([
      service.reconcile(),
      service.ensureOrigin(origin),
      service.injectForUrl(url, 7),
    ]);

    expect(reconciled.ok).toBe(true);
    expect(ensured.ok).toBe(true);
    expect(injected.ok).toBe(true);
    expect(adapter.maxActiveContains).toBe(1);
    expect(adapter.injected).toEqual([{ files: ["content-scripts/overlay.js"], tabId: 7 }]);
  });

  it("purges corrupt target data after permission revocation", async () => {
    const adapter = new FakeSiteAccessAdapter();
    const storage = new MemoryStorage();
    const target = getOrigin(new URL("https://revoked.example/page"));
    const parsedReferenceId = parseReferenceId(
      "123e4567-e89b-42d3-a456-426614174050",
    );
    if (!parsedReferenceId.ok) throw new Error("Test reference ID must parse.");
    const referenceId = parsedReferenceId.value;
    storage.values.set(ORIGIN_INDEX_KEY, {
      schemaVersion: 2,
      origins: [{ origin: target, referenceId }],
      imageIds: [referenceId],
    });
    storage.values.set(originRecordKey(target), { corrupt: true });
    storage.values.set(imageRecordKey(referenceId), {
      schemaVersion: 1,
      referenceId,
      dataUrl: "data:image/png;base64,aGVsbG8=",
    });
    const service = new SiteAccessService(adapter, new OverlayRepository(storage));

    await expect(service.reconcile()).resolves.toEqual({ ok: true, value: undefined });
    expect(storage.values.get(originRecordKey(target))).toBeUndefined();
    expect(storage.values.get(imageRecordKey(referenceId))).toBeUndefined();
  });

  it("purges a revoked registered origin even when the index is corrupt", async () => {
    const adapter = new FakeSiteAccessAdapter();
    const storage = new MemoryStorage();
    const target = getOrigin(new URL("https://corrupt-index.example/page"));
    const parsedReferenceId = parseReferenceId(
      "123e4567-e89b-42d3-a456-426614174051",
    );
    if (!parsedReferenceId.ok) throw new Error("Test reference ID must parse.");
    const referenceId = parsedReferenceId.value;
    adapter.registrations.push(await registrationForOrigin(target));
    storage.values.set(ORIGIN_INDEX_KEY, { corrupt: true });
    storage.values.set(originRecordKey(target), { corrupt: true });
    storage.values.set(imageRecordKey(referenceId), {
      schemaVersion: 1,
      referenceId,
      dataUrl: "data:image/png;base64,aGVsbG8=",
    });
    const service = new SiteAccessService(adapter, new OverlayRepository(storage));

    expect((await service.reconcile()).ok).toBe(false);
    expect(adapter.registrations).toEqual([]);
    expect(storage.values.get(originRecordKey(target))).toBeUndefined();
    expect(storage.values.get(imageRecordKey(referenceId))).toBeUndefined();
    expect(storage.values.get(ORIGIN_INDEX_KEY)).toEqual({
      schemaVersion: 2,
      origins: [],
      imageIds: [],
    });
  });

  it("removes malformed and revoked managed registrations", async () => {
    const adapter = new FakeSiteAccessAdapter();
    adapter.registrations.push({
      allFrames: false,
      css: [],
      excludeMatches: [],
      id: `${OVERLAY_REGISTRATION_PREFIX}not-a-real-hash`,
      js: ["content-scripts/overlay.js"],
      matchOriginAsFallback: false,
      matches: ["https://example.com/*"],
      persistAcrossSessions: true,
      runAt: "document_idle",
      world: "ISOLATED",
    });
    const service = new SiteAccessService(adapter, new OverlayRepository(new MemoryStorage()));

    expect((await service.reconcile()).ok).toBe(true);
    expect(adapter.registrations).toEqual([]);
  });
});
