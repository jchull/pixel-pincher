import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it, vi } from "vitest";

import { BackgroundCoordinator, type ActiveTab, type TabResolver } from "../../src/background/coordinator";
import { TabMessenger } from "../../src/background/tab-messenger";
import { type Hydration, type ImportError, type ImportedReference, type MimeType, type OverlaySnapshot, type PopupRequest, type Result } from "../../src/shared/contracts";
import { deriveOrigin, derivePageKey } from "../../src/shared/keys";
import { parseImportedReference, parsePopupRequest } from "../../src/shared/parse";
import { createImportReference, type ImportDependencies, type ImportFileLike, type ImportedDimensions } from "../../src/popup/import-reference";

const pageUrl = "https://example.test/import";
const IMPORTED_ID = "123e4567-e89b-42d3-a456-426614174000";
const IMPORTED_AT = 1_700_000_000_000;
const MAX_ENCODED = 8 * 1024 * 1024;

function fixtureBytes(name: string): Uint8Array {
  return new Uint8Array(readFileSync(resolve(process.cwd(), "tests/fixtures/import", name)));
}

/** Synthetic bytes that carry the PNG magic so type sniffing passes and the size checks run. */
function pngLikeBytes(size: number): Uint8Array {
  const bytes = new Uint8Array(size).fill(1);
  bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0);
  return bytes;
}

function base64Decode(payload: string): Uint8Array {
  return new Uint8Array(Buffer.from(payload, "base64"));
}

type FixtureCase = Readonly<{
  file: string;
  declaredType: string;
  mimeType: MimeType;
  width: number;
  height: number;
}>;

const ACCEPTED_FIXTURES: FixtureCase[] = [
  { file: "image.png", declaredType: "image/png", mimeType: "image/png", width: 1, height: 1 },
  { file: "photo.jpg", declaredType: "image/jpeg", mimeType: "image/jpeg", width: 1, height: 1 },
  { file: "picture.webp", declaredType: "image/webp", mimeType: "image/webp", width: 1, height: 1 },
  { file: "graphic.svg", declaredType: "image/svg+xml", mimeType: "image/svg+xml", width: 20, height: 10 },
  { file: "graphic-prolog.svg", declaredType: "image/svg+xml", mimeType: "image/svg+xml", width: 30, height: 15 },
  { file: "graphic-script.svg", declaredType: "image/svg+xml", mimeType: "image/svg+xml", width: 20, height: 10 },
];

type Harness = Readonly<{
  importer: ReturnType<typeof createImportReference>;
  deps: ImportDependencies;
  readFile: ReturnType<typeof vi.fn>;
  decodeImage: ReturnType<typeof vi.fn>;
  randomReferenceId: ReturnType<typeof vi.fn>;
  currentTimestamp: ReturnType<typeof vi.fn>;
}>;

function createHarness(options: Readonly<{ dimensions?: ImportedDimensions; decodeError?: boolean }> = {}): Harness {
  const readFile = vi.fn(async (file: ImportFileLike) => fixtureBytes(file.name));
  const decodeImage = vi.fn(async (): Promise<ImportedDimensions> => {
    if (options.decodeError) throw new Error("decode failed");
    return options.dimensions ?? { width: 1, height: 1 };
  });
  const randomReferenceId = vi.fn(() => IMPORTED_ID);
  const currentTimestamp = vi.fn(() => IMPORTED_AT);
  const deps: ImportDependencies = { readFile, decodeImage, randomReferenceId, currentTimestamp };
  return { importer: createImportReference(deps), deps, readFile, decodeImage, randomReferenceId, currentTimestamp };
}

function expectImportError(result: Result<ImportedReference, ImportError>, code: string): void {
  expect(result.ok).toBe(false);
  if (result.ok) throw new Error("Expected an import failure.");
  expect(result.error.code).toBe(code);
  expect(result.error.message.length).toBeGreaterThan(0);
}

describe("import-reference", () => {
  it("accepts every supported image type with byte-sniffed metadata", async () => {
    for (const fixture of ACCEPTED_FIXTURES) {
      const { importer, decodeImage } = createHarness({ dimensions: { width: fixture.width, height: fixture.height } });
      const result = await importer({ name: fixture.file, type: fixture.declaredType });
      expect(result.ok, fixture.file).toBe(true);
      if (!result.ok) continue;
      const { metadata, dataUrl } = result.value;
      expect(metadata).toEqual({
        id: IMPORTED_ID,
        name: fixture.file,
        mimeType: fixture.mimeType,
        width: fixture.width,
        height: fixture.height,
        encodedBytes: dataUrl.length,
        importedAt: IMPORTED_AT,
      });
      expect(dataUrl.startsWith(`data:${fixture.mimeType};base64,`)).toBe(true);
      // The payload round-trips to the exact fixture bytes: SVG stays opaque data, never markup.
      expect(base64Decode(dataUrl.split(",")[1]!)).toEqual(fixtureBytes(fixture.file));
      expect(decodeImage).toHaveBeenCalledOnce();
      expect(decodeImage).toHaveBeenCalledWith(fixtureBytes(fixture.file), fixture.mimeType);
    }
  });

  it("accepts an SVG whose script content is carried only as opaque data URL bytes", async () => {
    const { importer } = createHarness({ dimensions: { width: 20, height: 10 } });
    const result = await importer({ name: "graphic-script.svg", type: "image/svg+xml" });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const source = Buffer.from(result.value.dataUrl.split(",")[1]!, "base64").toString("utf8");
    expect(source).toContain("<script>alert(1)</script>");
    // The produced data URL is a strict base64 payload: no raw markup can appear in it.
    expect(result.value.dataUrl).toMatch(/^data:image\/svg\+xml;base64,[A-Za-z0-9+/]+={0,2}$/);
    // The reference parses at the shared contract boundary used by the background.
    expect(parseImportedReference({ metadata: result.value.metadata, dataUrl: result.value.dataUrl }).ok).toBe(true);
  });

  it("tolerates declared MIME case and surrounding whitespace but rejects every mismatch", async () => {
    const lenient = createHarness();
    await expect(lenient.importer({ name: "image.png", type: "  Image/PNG  " })).resolves.toMatchObject({ ok: true });

    const mismatches: Array<Readonly<{ file: string; declaredType: string }>> = [
      { file: "image.png", declaredType: "image/jpeg" },
      { file: "image.png", declaredType: "image/svg+xml" },
      { file: "photo.jpg", declaredType: "image/png" },
      { file: "picture.webp", declaredType: "image/jpeg" },
      { file: "graphic.svg", declaredType: "image/png" },
      { file: "graphic.svg", declaredType: "" },
      { file: "graphic.svg", declaredType: "text/html" },
    ];
    for (const mismatch of mismatches) {
      const { importer, decodeImage } = createHarness();
      const result = await importer({ name: mismatch.file, type: mismatch.declaredType });
      expectImportError(result, "invalid-image-type");
      expect(decodeImage).not.toHaveBeenCalled();
    }
  });

  it("rejects unknown image types before decoding", async () => {
    for (const file of ["image.gif", "notes.txt"]) {
      const { importer, decodeImage } = createHarness();
      const result = await importer({ name: file, type: "image/png" });
      expectImportError(result, "invalid-image-type");
      expect(decodeImage).not.toHaveBeenCalled();
    }
  });

  it("rejects a truncated PNG whose magic passes sniffing but whose decode fails", async () => {
    const { importer, decodeImage } = createHarness({ decodeError: true });
    const result = await importer({ name: "truncated.png", type: "image/png" });
    expectImportError(result, "image-decode-failed");
    expect(decodeImage).toHaveBeenCalledOnce();
  });

  it("rejects unreadable files and malformed decode results", async () => {
    const failingRead = createHarness();
    failingRead.readFile.mockRejectedValueOnce(new Error("read failed"));
    expectImportError(await failingRead.importer({ name: "image.png", type: "image/png" }), "image-decode-failed");

    const nonBytes = createHarness();
    nonBytes.readFile.mockResolvedValueOnce("not bytes" as unknown as Uint8Array);
    expectImportError(await nonBytes.importer({ name: "image.png", type: "image/png" }), "image-decode-failed");

    const decodeFailure = createHarness({ decodeError: true });
    expectImportError(await decodeFailure.importer({ name: "image.png", type: "image/png" }), "image-decode-failed");

    for (const dimensions of [
      { width: 0, height: 10 },
      { width: 10, height: 0 },
      { width: -1, height: 10 },
      { width: 1.5, height: 10 },
      { width: Number.NaN, height: 10 },
      { width: 10, height: Number.POSITIVE_INFINITY },
    ]) {
      const { importer } = createHarness({ dimensions });
      expectImportError(await importer({ name: "image.png", type: "image/png" }), "image-decode-failed");
    }

    const badId = createHarness();
    badId.randomReferenceId.mockReturnValueOnce("not-a-uuid");
    expectImportError(await badId.importer({ name: "image.png", type: "image/png" }), "image-decode-failed");

    const badTimestamp = createHarness();
    badTimestamp.currentTimestamp.mockReturnValueOnce(-1);
    expectImportError(await badTimestamp.importer({ name: "image.png", type: "image/png" }), "image-decode-failed");
  });

  it("rejects malformed file shapes as invalid image types", async () => {
    const { importer } = createHarness();
    expectImportError(await importer({ name: "", type: "image/png" }), "invalid-image-type");
    expectImportError(await importer({ name: "image.png", type: 42 as unknown as string }), "invalid-image-type");
    expectImportError(await importer(null as unknown as ImportFileLike), "invalid-image-type");
  });

  it("rejects files whose decoded pixels exceed the limit, accepting the boundary", async () => {
    const oversized = createHarness({ dimensions: { width: 7_000, height: 6_000 } });
    expectImportError(await oversized.importer({ name: "image.png", type: "image/png" }), "image-too-many-pixels");

    const justOver = createHarness({ dimensions: { width: 40_001, height: 1_000 } });
    expectImportError(await justOver.importer({ name: "image.png", type: "image/png" }), "image-too-many-pixels");

    const boundary = createHarness({ dimensions: { width: 20_000, height: 2_000 } });
    await expect(boundary.importer({ name: "image.png", type: "image/png" })).resolves.toMatchObject({ ok: true });
  });

  it("enforces the encoded data URL limit both before and after base64 expansion", async () => {
    const rawOversized = createHarness();
    rawOversized.readFile.mockResolvedValueOnce(pngLikeBytes(MAX_ENCODED + 1));
    const rawResult = await rawOversized.importer({ name: "big.png", type: "image/png" });
    expectImportError(rawResult, "image-too-large");
    expect(rawOversized.decodeImage).not.toHaveBeenCalled();

    // 6 MiB of raw bytes fits the input limit but expands past 8 MiB as base64.
    const expanding = createHarness({ dimensions: { width: 1, height: 1 } });
    expanding.readFile.mockResolvedValueOnce(pngLikeBytes(6 * 1024 * 1024));
    expectImportError(await expanding.importer({ name: "big.png", type: "image/png" }), "image-too-large");
  });

  describe("Task 4 handoff", () => {
    function known<T>(value: T | null | undefined, message: string): T {
      if (value === null || value === undefined) throw new Error(message);
      return value;
    }

    function snapshot(input: Readonly<{ reference?: ImportedReference | null; revision?: number }> = {}): OverlaySnapshot {
      const url = new URL(pageUrl);
      return {
        revision: input.revision ?? 3,
        origin: known(deriveOrigin(url), "Known URL must have an origin."),
        pageKey: known(derivePageKey(url), "Known URL must have a page key."),
        settings: {
          visible: true,
          opacity: 0.5,
          inverted: false,
          placement: { x: 0, y: 0 },
          sizing: { kind: "fit-width", lastScalePercent: 100 },
          interactionMode: "click-through",
        },
        reference: input.reference === undefined || input.reference === null ? null : input.reference.metadata,
      };
    }

    class FakeTabs implements TabResolver {
      readonly tabs = new Map<number, ActiveTab>([[9, { id: 9, url: pageUrl }]]);

      async getActiveTab(): Promise<ActiveTab | null> {
        return this.tabs.get(9) ?? null;
      }

      async getTab(tabId: number): Promise<ActiveTab | null> {
        return this.tabs.get(tabId) ?? null;
      }

      async getTabs(): Promise<readonly ActiveTab[]> {
        return [...this.tabs.values()];
      }
    }

    function createCoordinatorHarness() {
      const tabs = new FakeTabs();
      let currentSnapshot = snapshot();
      let hydrationReference: ImportedReference | null = null;
      const hydration = (): Hydration => currentSnapshot.reference === null
        ? { snapshot: { ...currentSnapshot, reference: null }, reference: null }
        : { snapshot: { ...currentSnapshot, reference: known(hydrationReference, "Reference must be available.").metadata }, reference: known(hydrationReference, "Reference must be available.") };
      const repository = {
        cleanupOrphans: vi.fn().mockResolvedValue({ ok: true, value: undefined }),
        clearOrigin: vi.fn().mockResolvedValue({ ok: true, value: undefined }),
        readHydration: vi.fn().mockImplementation(async () => ({ ok: true as const, value: hydration() })),
        readSnapshot: vi.fn().mockImplementation(async () => ({ ok: true as const, value: currentSnapshot })),
        replaceReference: vi.fn().mockImplementation(async ({ reference: next }: { reference: ImportedReference }) => {
          hydrationReference = next;
          currentSnapshot = snapshot({ reference: next, revision: currentSnapshot.revision + 1 });
          return { ok: true as const, value: currentSnapshot };
        }),
        updatePlacement: vi.fn().mockResolvedValue({ ok: true, value: currentSnapshot }),
        updateSettings: vi.fn().mockResolvedValue({ ok: true, value: currentSnapshot }),
      };
      const siteAccess = {
        ensureForUrl: vi.fn().mockResolvedValue({ ok: true, value: undefined }),
        has: vi.fn().mockResolvedValue({ ok: true, value: true }),
        injectForUrl: vi.fn().mockResolvedValue({ ok: true, value: undefined }),
        reconcile: vi.fn().mockResolvedValue({ ok: true, value: undefined }),
        unregisterOrigin: vi.fn().mockResolvedValue({ ok: true, value: undefined }),
      };
      const send = vi.fn().mockResolvedValue(undefined);
      const messenger = new TabMessenger({ send }, { inject: vi.fn().mockResolvedValue({ ok: true, value: undefined }) }, tabs);
      const coordinator = new BackgroundCoordinator({ repository, siteAccess, tabs, messenger });
      return { coordinator, repository, send };
    }

    /**
     * Mirrors the future popup flow: build and send the replace-reference
     * request only after a successful import. Returns the import result so
     * callers can discriminate success from failure.
     */
    async function importOrDispatch(
      importer: ReturnType<typeof createImportReference>,
      file: ImportFileLike,
      harness: ReturnType<typeof createCoordinatorHarness>,
    ): Promise<Result<ImportedReference, ImportError>> {
      const result = await importer(file);
      if (!result.ok) return result;
      const request: Extract<PopupRequest, { kind: "replace-reference" }> = { kind: "replace-reference", requestId: "import-1", url: pageUrl, reference: result.value };
      expect(parsePopupRequest(request as unknown).ok).toBe(true);
      await harness.coordinator.handlePopup(request);
      return result;
    }

    it("hands a successful import to Task 4 replace-reference and delivers exactly one hydration", async () => {
      const { importer, decodeImage } = createHarness({ dimensions: { width: 1, height: 1 } });
      const harness = createCoordinatorHarness();
      const result = await importOrDispatch(importer, { name: "image.png", type: "image/png" }, harness);
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      const { reference } = { reference: result.value };

      expect(harness.repository.replaceReference).toHaveBeenCalledOnce();
      const call = harness.repository.replaceReference.mock.calls[0]?.[0] as { url: URL; reference: ImportedReference };
      expect(call.url.toString()).toBe(pageUrl);
      expect(call.reference.dataUrl).toBe(reference.dataUrl);
      expect(call.reference.metadata.id).toBe(IMPORTED_ID);

      expect(harness.send).toHaveBeenCalledOnce();
      const [tabId, request] = harness.send.mock.calls[0] as [number, { kind: string; hydration?: Hydration }];
      expect(tabId).toBe(9);
      expect(request.kind).toBe("hydrate-overlay");
      expect(request.hydration?.reference?.dataUrl).toBe(reference.dataUrl);
      expect(request.hydration?.snapshot.reference?.id).toBe(IMPORTED_ID);
      expect(request.hydration?.snapshot.revision).toBe(4);
      expect(decodeImage).toHaveBeenCalledOnce();
    });

    it("never dispatches replace-reference for rejected imports", async () => {
      const rejected: Array<Readonly<{ file: ImportFileLike; code: string; dimensions?: ImportedDimensions; failRead?: boolean; decodeError?: boolean }>> = [
        { file: { name: "image.png", type: "image/jpeg" }, code: "invalid-image-type" },
        { file: { name: "graphic.svg", type: "image/png" }, code: "invalid-image-type" },
        { file: { name: "graphic.svg", type: "" }, code: "invalid-image-type" },
        { file: { name: "image.gif", type: "image/gif" }, code: "invalid-image-type" },
        { file: { name: "notes.txt", type: "text/plain" }, code: "invalid-image-type" },
        { file: { name: "truncated.png", type: "image/png" }, code: "image-decode-failed", decodeError: true },
        { file: { name: "image.png", type: "image/png" }, code: "image-decode-failed", failRead: true },
        { file: { name: "image.png", type: "image/png" }, code: "image-decode-failed", dimensions: { width: 0, height: 1 } },
        { file: { name: "image.png", type: "image/png" }, code: "image-too-many-pixels", dimensions: { width: 7_000, height: 6_000 } },
        { file: { name: "big.png", type: "image/png" }, code: "image-too-large" },
      ];

      for (const testCase of rejected) {
        const { importer, readFile } = createHarness({ dimensions: testCase.dimensions, decodeError: testCase.decodeError ?? false });
        if (testCase.failRead) readFile.mockRejectedValueOnce(new Error("read failed"));
        if (testCase.file.name === "big.png") readFile.mockResolvedValueOnce(pngLikeBytes(MAX_ENCODED + 1));
        const harness = createCoordinatorHarness();
        const result = await importOrDispatch(importer, testCase.file, harness);
        expect(result.ok, `${testCase.file.name} [${testCase.code}]`).toBe(false);
        if (result.ok) throw new Error("Rejected import must not produce a dispatch.");
        expect(result.error.code).toBe(testCase.code);
        expect(harness.repository.replaceReference).not.toHaveBeenCalled();
        expect(harness.send).not.toHaveBeenCalled();
      }
    });
  });
});
