import { AppError, type AccessError, type Origin, type Result } from "../shared/contracts";
import { deriveOrigin } from "../shared/keys";
import type { OverlayRepository } from "./repository";

export const OVERLAY_SCRIPT_PATH = "content-scripts/overlay.js";
export const OVERLAY_REGISTRATION_PREFIX = "pixel-pincher-overlay-";

export type RuntimeRegistration = Readonly<{
  allFrames: false;
  id: string;
  js: readonly string[];
  matches: readonly string[];
  persistAcrossSessions: true;
  runAt: "document_idle";
}>;

export type ObservedRegistration = Readonly<{
  allFrames: boolean;
  id: string;
  js: readonly string[];
  matches: readonly string[];
  persistAcrossSessions: boolean;
  runAt: string;
}>;

export interface SiteAccessAdapter {
  containsOrigin(originMatch: string): Promise<boolean>;
  executeScript(tabId: number, files: readonly string[]): Promise<void>;
  getGrantedOrigins(): Promise<readonly string[]>;
  getRegistrations(): Promise<readonly ObservedRegistration[]>;
  register(registration: RuntimeRegistration): Promise<void>;
  unregister(ids: readonly string[]): Promise<void>;
  update(registration: RuntimeRegistration): Promise<void>;
}

function accessFailure(code: AccessError["code"]): Result<never, AccessError> {
  return { ok: false, error: new AppError(code) };
}

function originMatch(origin: Origin): string {
  return `${origin}/*`;
}

function originFromMatch(value: string): Origin | undefined {
  if (!value.endsWith("/*")) return undefined;
  try {
    const origin = deriveOrigin(new URL(value.slice(0, -2)));
    return origin !== undefined && originMatch(origin) === value ? origin : undefined;
  } catch {
    return undefined;
  }
}

function isExpectedRegistration(registration: ObservedRegistration, expected: RuntimeRegistration): boolean {
  return registration.id === expected.id &&
    registration.allFrames === expected.allFrames &&
    registration.persistAcrossSessions === expected.persistAcrossSessions &&
    registration.runAt === expected.runAt &&
    registration.js.length === expected.js.length &&
    registration.js.every((value, index) => value === expected.js[index]) &&
    registration.matches.length === expected.matches.length &&
    registration.matches.every((value, index) => value === expected.matches[index]);
}

function bytesToHex(bytes: Uint8Array): string {
  let value = "";
  for (const byte of bytes) value += byte.toString(16).padStart(2, "0");
  return value;
}

export async function registrationIdForOrigin(origin: Origin): Promise<string> {
  const encoded = new TextEncoder().encode(origin);
  const digest = await crypto.subtle.digest("SHA-256", encoded);
  return `${OVERLAY_REGISTRATION_PREFIX}${bytesToHex(new Uint8Array(digest))}`;
}

export async function registrationForOrigin(origin: Origin): Promise<RuntimeRegistration> {
  return {
    allFrames: false,
    id: await registrationIdForOrigin(origin),
    js: [OVERLAY_SCRIPT_PATH],
    matches: [originMatch(origin)],
    persistAcrossSessions: true,
    runAt: "document_idle",
  };
}

/** Optional-host access and runtime-content-script lifecycle. Popup permission prompts stay outside this service. */
export class SiteAccessService {
  readonly #adapter: SiteAccessAdapter;
  readonly #repository: Pick<OverlayRepository, "clearOrigin" | "listOrigins">;

  constructor(adapter: SiteAccessAdapter, repository: Pick<OverlayRepository, "clearOrigin" | "listOrigins">) {
    this.#adapter = adapter;
    this.#repository = repository;
  }

  async ensureForUrl(url: URL): Promise<Result<void, AccessError>> {
    const origin = deriveOrigin(url);
    if (origin === undefined) return accessFailure("content-unavailable");
    return this.ensureOrigin(origin);
  }

  async ensureOrigin(origin: Origin): Promise<Result<void, AccessError>> {
    try {
      if (!await this.#adapter.containsOrigin(originMatch(origin))) return accessFailure("site-access-denied");
      const expected = await registrationForOrigin(origin);
      const registrations = await this.#adapter.getRegistrations();
      const current = registrations.find((registration) => registration.id === expected.id);
      if (current === undefined) {
        try {
          await this.#adapter.register(expected);
        } catch {
          // A racing/restarted worker can report a duplicate registration. Final-state
          // verification below makes that case idempotent without hiding a bad result.
        }
      } else if (!isExpectedRegistration(current, expected)) {
        await this.#adapter.update(expected);
      }
      const finalRegistrations = await this.#adapter.getRegistrations();
      const final = finalRegistrations.find((registration) => registration.id === expected.id);
      return final !== undefined && isExpectedRegistration(final, expected)
        ? { ok: true, value: undefined }
        : accessFailure("content-unavailable");
    } catch {
      return accessFailure("content-unavailable");
    }
  }

  async injectForUrl(url: URL, tabId: number): Promise<Result<void, AccessError>> {
    if (!Number.isSafeInteger(tabId) || tabId < 0) return accessFailure("content-unavailable");
    const ensured = await this.ensureForUrl(url);
    if (!ensured.ok) return ensured;
    try {
      await this.#adapter.executeScript(tabId, [OVERLAY_SCRIPT_PATH]);
      return { ok: true, value: undefined };
    } catch {
      return accessFailure("content-unavailable");
    }
  }

  async unregisterOrigin(origin: Origin): Promise<Result<void, AccessError>> {
    try {
      const id = await registrationIdForOrigin(origin);
      const registrations = await this.#adapter.getRegistrations();
      if (registrations.some((registration) => registration.id === id)) {
        await this.#adapter.unregister([id]);
      }
      return { ok: true, value: undefined };
    } catch {
      return accessFailure("content-unavailable");
    }
  }

  /** Reconcile persisted sites and valid managed registrations without creating state from permission alone. */
  async reconcile(): Promise<Result<void, AccessError>> {
    const stored = await this.#repository.listOrigins();
    if (!stored.ok) return accessFailure("content-unavailable");
    try {
      const registrations = await this.#adapter.getRegistrations();
      const storedOrigins = new Set(stored.value);
      const granted = new Set(await this.#adapter.getGrantedOrigins());

      for (const origin of stored.value) {
        if (granted.has(originMatch(origin))) {
          const ensured = await this.ensureOrigin(origin);
          if (!ensured.ok) return ensured;
        } else {
          const removed = await this.unregisterOrigin(origin);
          if (!removed.ok) return removed;
          const cleared = await this.#repository.clearOrigin(origin);
          if (!cleared.ok) return accessFailure("content-unavailable");
        }
      }

      for (const registration of registrations) {
        if (!registration.id.startsWith(OVERLAY_REGISTRATION_PREFIX)) continue;
        const match = registration.matches.length === 1 ? originFromMatch(registration.matches[0] ?? "") : undefined;
        if (match === undefined || registration.id !== await registrationIdForOrigin(match)) {
          await this.#adapter.unregister([registration.id]);
          continue;
        }
        if (!granted.has(originMatch(match))) {
          await this.#adapter.unregister([registration.id]);
          continue;
        }
        if (!storedOrigins.has(match)) {
          const ensured = await this.ensureOrigin(match);
          if (!ensured.ok) return ensured;
        }
      }
      return { ok: true, value: undefined };
    } catch {
      return accessFailure("content-unavailable");
    }
  }
}

export function createChromeSiteAccessAdapter(): SiteAccessAdapter {
  return {
    async containsOrigin(origin) {
      return chrome.permissions.contains({ origins: [origin] });
    },
    async executeScript(tabId, files) {
      await chrome.scripting.executeScript({ files: [...files], target: { frameIds: [0], tabId } });
    },
    async getGrantedOrigins() {
      const permissions = await chrome.permissions.getAll();
      return permissions.origins ?? [];
    },
    async getRegistrations() {
      const registrations = await chrome.scripting.getRegisteredContentScripts();
      return registrations.map((registration) => ({
        allFrames: registration.allFrames ?? false,
        id: registration.id,
        js: registration.js ?? [],
        matches: registration.matches ?? [],
        persistAcrossSessions: registration.persistAcrossSessions ?? true,
        runAt: registration.runAt ?? "document_idle",
      }));
    },
    async register(registration) {
      await chrome.scripting.registerContentScripts([{
        allFrames: registration.allFrames,
        id: registration.id,
        js: [...registration.js],
        matches: [...registration.matches],
        persistAcrossSessions: registration.persistAcrossSessions,
        runAt: registration.runAt,
      }]);
    },
    async unregister(ids) {
      await chrome.scripting.unregisterContentScripts({ ids: [...ids] });
    },
    async update(registration) {
      await chrome.scripting.updateContentScripts([{
        allFrames: registration.allFrames,
        id: registration.id,
        js: [...registration.js],
        matches: [...registration.matches],
        persistAcrossSessions: registration.persistAcrossSessions,
        runAt: registration.runAt,
      }]);
    },
  };
}
