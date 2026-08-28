import { defineContentScript } from "wxt/utils/define-content-script";

/** Runtime-only entrypoint. Task 6 supplies the overlay controller. */
export default defineContentScript({
  allFrames: false,
  registration: "runtime",
  runAt: "document_idle",
  main() {},
});
