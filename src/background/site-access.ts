import { AppError, type AccessError, type Origin, type Result } from "../shared/contracts";
import { deriveOrigin } from "../shared/keys";
import type { OverlayRepository } from "./repository";

export const OVERLAY_SCRIPT_PATH = "content-scripts/overlay.js";
export const OVERLAY_REGISTRATION_PREFIX = "pixel-pincher-overlay-";

export type RuntimeRegistration = Readonly<{
  allFrames: false;
  css: readonly string[];
  excludeMatches: readonly string[];
  id: string;
  js: readonly string[];
  matchOriginAsFallback: false;
  matches: readonly string[];
  persistAcrossSessions: true;
  runAt: "document_idle";
  world: "ISOLATED";
}>;

export type ObservedRegistration = Readonly<{
  allFrames: boolean;
  css: readonly string[];
  excludeMatches: readonly string[];
  id: string;
  js: readonly string[];
  matchOriginAsFallback: boolean;
  matches: readonly string[];
  persistAcrossSessions: boolean;
  runAt: string;
  world: string;
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

export function originFromMatch(value: string): Origin | undefined {
  if (!value.endsWith("/*")) return undefined;
  try {
    const url = new URL(value.slice(0, -2));
    if (url.hostname === "*") return undefined;
    const origin = deriveOrigin(url);
    return origin !== undefined && originMatch(origin) === value ? origin : undefined;
  } catch {
    return undefined;
  }
}

function sameStrings(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function isExpectedRegistration(registration: ObservedRegistration, expected: RuntimeRegistration): boolean {
  return registration.id === expected.id &&
    registration.allFrames === expected.allFrames &&
    registration.persistAcrossSessions === expected.persistAcrossSessions &&
    registration.runAt === expected.runAt &&
    registration.matchOriginAsFallback === expected.matchOriginAsFallback &&
    registration.world === expected.world &&
    sameStrings(registration.js, expected.js) &&
    sameStrings(registration.css, expected.css) &&
    sameStrings(registration.matches, expected.matches) &&
    sameStrings(registration.excludeMatches, expected.excludeMatches);
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
    css: [],
    excludeMatches: [],
    id: await registrationIdForOrigin(origin),
    js: [OVERLAY_SCRIPT_PATH],
    matchOriginAsFallback: false,
    matches: [originMatch(origin)],
    persistAcrossSessions: true,
    runAt: "document_idle",
    world: "ISOLATED",
  };
}

/** Optional-host access and runtime-content-script lifecycle. Popup permission prompts stay outside this service. */
export class SiteAccessService {
  readonly #adapter: SiteAccessAdapter;
  readonly #repository: Pick<OverlayRepository, "purgeOrigin" | "listOrigins">;
  #operation: Promise<void> = Promise.resolve();

  constructor(adapter: SiteAccessAdapter, repository: Pick<OverlayRepository, "purgeOrigin" | "listOrigins">) {
    this.#adapter = adapter;
    this.#repository = repository;
  }

  async ensureForUrl(url: URL): Promise<Result<void, AccessError>> {
    const origin = deriveOrigin(url);
    if (origin === undefined) return accessFailure("content-unavailable");
    return this.ensureOrigin(origin);
  }

  async ensureOrigin(origin: Origin): Promise<Result<void, AccessError>> {
    return this.#exclusive(() => this.#ensureOrigin(origin));
  }

  /** Read current permission and managed-registration state without changing it. */
  async has(origin: Origin): Promise<Result<boolean, AccessError>> {
    return this.#exclusive(async () => {
      try {
        if (!await this.#adapter.containsOrigin(originMatch(origin))) {
          return { ok: true, value: false };
        }
        const expected = await registrationForOrigin(origin);
        const registrations = await this.#adapter.getRegistrations();
        return {
          ok: true,
          value: registrations.some((registration) => isExpectedRegistration(registration, expected)),
        };
      } catch {
        return accessFailure("content-unavailable");
      }
    });
  }

  async injectForUrl(url: URL, tabId: number): Promise<Result<void, AccessError>> {
    const origin = deriveOrigin(url);
    if (origin === undefined || !Number.isSafeInteger(tabId) || tabId < 0) return accessFailure("content-unavailable");
    return this.#exclusive(async () => {
      try {
        if (!await this.#adapter.containsOrigin(originMatch(origin))) return accessFailure("site-access-revoked");
        const expected = await registrationForOrigin(origin);
        const registrations = await this.#adapter.getRegistrations();
        const current = registrations.find((registration) => registration.id === expected.id);
        if (current === undefined || !isExpectedRegistration(current, expected)) return accessFailure("content-unavailable");
        await this.#adapter.executeScript(tabId, [OVERLAY_SCRIPT_PATH]);
        return { ok: true, value: undefined };
      } catch {
        return accessFailure("content-unavailable");
      }
    });
  }

  async unregisterOrigin(origin: Origin): Promise<Result<void, AccessError>> {
    return this.#exclusive(() => this.#unregisterOrigin(origin));
  }

  /** Reconcile persisted sites and valid managed registrations without creating state from permission alone. */
  async reconcile(): Promise<Result<void, AccessError>> {
    return this.#exclusive(async () => {
      const stored = await this.#repository.listOrigins();

      try {
        const initialRegistrations = await this.#adapter.getRegistrations();
        const granted = new Set(await this.#adapter.getGrantedOrigins());
        const origins = new Set(stored.ok ? stored.value : []);
        let firstFailure: Result<never, AccessError> | undefined = stored.ok
          ? undefined
          : accessFailure("content-unavailable");
        const rememberFailure = (result: Result<void, AccessError>): void => {
          if (!result.ok && firstFailure === undefined) firstFailure = result;
        };

        for (const registration of initialRegistrations) {
          if (!registration.id.startsWith(OVERLAY_REGISTRATION_PREFIX)) continue;
          const origin = registration.matches.length === 1
            ? originFromMatch(registration.matches[0] ?? "")
            : undefined;
          if (origin === undefined || registration.id !== await registrationIdForOrigin(origin)) {
            rememberFailure(await this.#unregisterRegistrationId(registration.id));
            continue;
          }
          // A corrupt index cannot enumerate stored origins, but a managed
          // registration still identifies a revoked origin that must be purged.
          origins.add(origin);
        }

        for (const origin of origins) {
          if (granted.has(originMatch(origin))) {
            // A managed registration plus a grant is explicit enabled-without-reference
            // state. Repair its current packaged shape without creating repository data.
            rememberFailure(await this.#ensureOrigin(origin));
          } else {
            // Both operations are attempted even when the other fails so revocation
            // cannot leave storage behind because a registration is already absent/bad.
            rememberFailure(await this.#unregisterOrigin(origin));
            const cleared = await this.#repository.purgeOrigin(origin);
            if (!cleared.ok && firstFailure === undefined)
              firstFailure = accessFailure("content-unavailable");
          }
        }

        return firstFailure ?? { ok: true, value: undefined };
      } catch {
        return accessFailure("content-unavailable");
      }
    });
  }

  async #ensureOrigin(origin: Origin): Promise<Result<void, AccessError>> {
    try {
      if (!await this.#adapter.containsOrigin(originMatch(origin))) return accessFailure("site-access-revoked");
      const expected = await registrationForOrigin(origin);
      const registrations = await this.#adapter.getRegistrations();
      const current = registrations.find((registration) => registration.id === expected.id);
      if (current === undefined) {
        try {
          await this.#adapter.register(expected);
        } catch {
          // Duplicate registration can be a concurrent worker. Final-state verification
          // below is the authority and distinguishes it from a failed mutation.
        }
      } else if (!isExpectedRegistration(current, expected)) {
        try {
          await this.#adapter.update(expected);
        } catch {
          // A second worker may have repaired it. Verify the final shape below.
        }
      }
      if (!await this.#adapter.containsOrigin(originMatch(origin))) {
        await this.#bestEffortUnregister(expected.id);
        return accessFailure("site-access-revoked");
      }
      const final = (await this.#adapter.getRegistrations()).find((registration) => registration.id === expected.id);
      return final !== undefined && isExpectedRegistration(final, expected)
        ? { ok: true, value: undefined }
        : accessFailure("content-unavailable");
    } catch {
      return accessFailure("content-unavailable");
    }
  }

  async #unregisterOrigin(origin: Origin): Promise<Result<void, AccessError>> {
    try {
      return this.#unregisterRegistrationId(await registrationIdForOrigin(origin));
    } catch {
      return accessFailure("content-unavailable");
    }
  }

  async #bestEffortUnregister(id: string): Promise<void> {
    try {
      const registrations = await this.#adapter.getRegistrations();
      if (!registrations.some((registration) => registration.id === id)) return;
      try {
        await this.#adapter.unregister([id]);
      } catch {
        // Permission loss races can make unregister fail. A final read is useful
        // evidence but must never replace the authoritative revoked result.
      }
      await this.#adapter.getRegistrations();
    } catch {
      // Permission loss is already the public result; cleanup stays best effort.
    }
  }

  async #unregisterRegistrationId(id: string): Promise<Result<void, AccessError>> {
    try {
      const registrations = await this.#adapter.getRegistrations();
      if (registrations.some((registration) => registration.id === id)) {
        try {
          await this.#adapter.unregister([id]);
        } catch {
          // Missing registrations and races are idempotent only after final verification.
        }
      }
      const final = await this.#adapter.getRegistrations();
      return final.some((registration) => registration.id === id)
        ? accessFailure("content-unavailable")
        : { ok: true, value: undefined };
    } catch {
      return accessFailure("content-unavailable");
    }
  }

  async #exclusive<T>(operation: () => Promise<T>): Promise<T> {
    const previous = this.#operation;
    let release: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    this.#operation = previous.then(() => gate);
    await previous;
    try {
      return await operation();
    } finally {
      release?.();
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
        css: registration.css ?? [],
        excludeMatches: registration.excludeMatches ?? [],
        id: registration.id,
        js: registration.js ?? [],
        matchOriginAsFallback: registration.matchOriginAsFallback ?? false,
        matches: registration.matches ?? [],
        persistAcrossSessions: registration.persistAcrossSessions ?? true,
        runAt: registration.runAt ?? "document_idle",
        world: registration.world ?? "ISOLATED",
      }));
    },
    async register(registration) {
      await chrome.scripting.registerContentScripts([{
        allFrames: registration.allFrames,
        css: [...registration.css],
        excludeMatches: [...registration.excludeMatches],
        id: registration.id,
        js: [...registration.js],
        matchOriginAsFallback: registration.matchOriginAsFallback,
        matches: [...registration.matches],
        persistAcrossSessions: registration.persistAcrossSessions,
        runAt: registration.runAt,
        world: registration.world,
      }]);
    },
    async unregister(ids) {
      await chrome.scripting.unregisterContentScripts({ ids: [...ids] });
    },
    async update(registration) {
      await chrome.scripting.updateContentScripts([{
        allFrames: registration.allFrames,
        css: [...registration.css],
        excludeMatches: [...registration.excludeMatches],
        id: registration.id,
        js: [...registration.js],
        matchOriginAsFallback: registration.matchOriginAsFallback,
        matches: [...registration.matches],
        persistAcrossSessions: registration.persistAcrossSessions,
        runAt: registration.runAt,
        world: registration.world,
      }]);
    },
  };
}
