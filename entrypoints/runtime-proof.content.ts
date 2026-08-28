import { defineContentScript } from "wxt/utils/define-content-script";

import { mountRuntimeProof } from "../src/proof/runtime-content";

export default defineContentScript({
  allFrames: false,
  registration: "runtime",
  runAt: "document_idle",
  main() {
    mountRuntimeProof(document);
  },
});
