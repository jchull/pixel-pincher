import { defineConfig } from "wxt";

export default defineConfig({
  outDir: "dist",
  manifest: {
    name: "Pixel Pincher",
    description: "Overlay and compare reference images on web pages.",
    icons: {
      16: "/icon/16.png",
      32: "/icon/32.png",
      48: "/icon/48.png",
      128: "/icon/128.png",
    },
    action: {
      default_icon: {
        16: "/icon/16.png",
        32: "/icon/32.png",
        48: "/icon/48.png",
        128: "/icon/128.png",
      },
    },
    content_security_policy: {
      extension_pages:
        "script-src 'self'; object-src 'self'; img-src 'self' blob: data:",
    },
    incognito: "not_allowed",
    minimum_chrome_version: "130",
    optional_host_permissions: ["http://*/*", "https://*/*"],
    commands: {
      "toggle-visibility": {
        description: "Toggle reference visibility",
        suggested_key: { default: "Alt+Shift+P" },
      },
      "nudge-left": { description: "Nudge reference left" },
      "nudge-right": { description: "Nudge reference right" },
      "nudge-up": { description: "Nudge reference up" },
      "nudge-down": { description: "Nudge reference down" },
    },
    permissions: [
      "activeTab",
      "storage",
      "unlimitedStorage",
      "scripting",
      "webNavigation",
    ],
  },
});
