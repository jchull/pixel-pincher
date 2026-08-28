import { describe, expect, it } from "vitest";

import { OverlayRepository } from "../../src/background/repository";
import type { StorageAdapter } from "../../src/background/storage-adapter";
import {
  OVERLAY_REGISTRATION_PREFIX,
  type ObservedRegistration,
  type RuntimeRegistration,
  type SiteAccessAdapter,
  SiteAccessService,
  registrationForOrigin,
} from "../../src/background/site-access";
import { deriveOrigin } from "../../src/shared/keys";

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
  readonly injected: number[] = [];
  readonly registrations: ObservedRegistration[] = [];
  registerAsDuplicate = false;

  async containsOrigin(originMatch: string): Promise<boolean> {
    return this.grants.has(originMatch);
  }

  async executeScript(tabId: number): Promise<void> {
    this.injected.push(tabId);
  }

  async getGrantedOrigins(): Promise<readonly string[]> {
    return [...this.grants];
  }

  async getRegistrations(): Promise<readonly ObservedRegistration[]> {
    return this.registrations;
  }

  async register(registration: RuntimeRegistration): Promise<void> {
    this.registrations.push(registration);
    if (this.registerAsDuplicate) throw new Error("duplicate registration");
  }

  async unregister(ids: readonly string[]): Promise<void> {
    for (const id of ids) {
      const index = this.registrations.findIndex((registration) => registration.id === id);
      if (index >= 0) this.registrations.splice(index, 1);
    }
  }

  async update(registration: RuntimeRegistration): Promise<void> {
    await this.unregister([registration.id]);
    await this.register(registration);
  }
}

function getOrigin(url: URL) {
  const origin = deriveOrigin(url);
  if (origin === undefined) throw new Error("Test URL must have an origin.");
  return origin;
}

describe("SiteAccessService", () => {
  it("rejects registration without an optional origin grant", async () => {
    const service = new SiteAccessService(new FakeSiteAccessAdapter(), new OverlayRepository(new MemoryStorage()));
    const result = await service.ensureForUrl(new URL("https://example.com/page"));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("site-access-denied");
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
    expect(adapter.injected).toEqual([7]);
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

  it("does not create a registration from permission alone", async () => {
    const adapter = new FakeSiteAccessAdapter();
    adapter.grants.add("https://example.com/*");
    const service = new SiteAccessService(adapter, new OverlayRepository(new MemoryStorage()));

    expect((await service.reconcile()).ok).toBe(true);
    expect(adapter.registrations).toEqual([]);
  });

  it("removes malformed and revoked managed registrations", async () => {
    const adapter = new FakeSiteAccessAdapter();
    adapter.registrations.push({
      allFrames: false,
      id: `${OVERLAY_REGISTRATION_PREFIX}not-a-real-hash`,
      js: ["content-scripts/overlay.js"],
      matches: ["https://example.com/*"],
      persistAcrossSessions: true,
      runAt: "document_idle",
    });
    const service = new SiteAccessService(adapter, new OverlayRepository(new MemoryStorage()));

    expect((await service.reconcile()).ok).toBe(true);
    expect(adapter.registrations).toEqual([]);
  });
});
