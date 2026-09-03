# Chrome Web Store release plan

## Candidate preparation

1. Start from a clean candidate commit.
2. Run `scripts/validate-release-candidate.sh`.
3. Record the archive filename and SHA-256 in `docs/release-checklist.md`.
4. Use only the generated `dist/chrome-mv3` archive. Do not archive the repository root.

## Browser validation

Use Chrome stable and a second Chromium browser. Both must be version 130 or later.

1. Load the exact `dist/chrome-mv3` directory as an unpacked extension.
2. Run M01 through M17 in `docs/release-checklist.md` for each browser.
3. Test URL imports with same-origin, CORS-allowed, CORS-blocked, oversized declared, oversized streamed, `data:`, current-page `blob:`, HTTP-on-HTTPS, and credential-like query inputs.
4. Inspect DevTools Network. URL import requests must send no cookie and no referrer.
5. After clear and permission revocation, inspect extension storage. The origin record, image bytes, index entry, registration, and overlay must be absent.
6. Record every result. Do not mark a row passed from automated evidence.

## Store draft

1. Upload the generated archive as a Chrome Web Store draft. Do not submit it.
2. Compare the Store permission summary with `dist/chrome-mv3/manifest.json`.
3. Compare the privacy questionnaire and listing with the disclosure in `docs/release-checklist.md`.
4. Record upload warnings and resolve every warning affecting permissions, privacy, packaging, or policy.
5. Keep the draft unsubmitted until the final ship decision.
