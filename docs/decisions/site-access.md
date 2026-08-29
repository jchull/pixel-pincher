# Optional site access and runtime registration

**Date:** 2026-08-28
**Status:** passed; temporary manual harness deleted.

Task 3 uses optional exact-origin permission (`<origin>/*`) with a deterministic,
persisted top-frame runtime content-script registration. The registration is
managed only after an explicit enable operation; permission alone does not
create repository data or a registration.

## Dated manual Chrome results (2026-08-28)

Verified in unpacked Chrome from `dist/chrome-mv3` with a temporary local
same-origin iframe fixture. The temporary popup, background listener, marker,
and fixtures were deleted after verification.

1. **Permission-only state:** granting an exact optional origin directly from
   the popup click handler left runtime registration and stored-origin state
   absent. Reloading the extension and reconciling retained that absence.
2. **Enable and inject:** enabling the active origin registered the real
   Task 3 runtime script and injected it into the already-open active tab.
   The top frame showed the temporary marker; its same-origin child frame did
   not, confirming `allFrames: false` behavior.
3. **Exact-origin isolation:** the unrelated `http://127.0.0.1:8080` origin
   had no optional permission, registration, or stored-origin state after
   enabling `http://localhost:8080`.
4. **Persistence:** after a page reload and a full Chrome restart, the
   enabled origin's registration remained present and injected the runtime
   script on page load without another popup action.
5. **Revocation cleanup:** removing the exact optional permission reconciled
   the runtime registration and stored-origin data away. Reloading the page
   showed no marker.

These results confirm the Task 3 acceptance behavior: an enabled origin
restores after reload, another origin remains inaccessible, and revocation
removes registration and stored site data.
