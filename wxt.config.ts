import { defineConfig } from 'wxt';

export default defineConfig({
  outDir: "dist",
  manifest: {
    name: 'Pixel Pincher',
    description: 'Overlay and compare reference images on web pages.',
    incognito: 'not_allowed',
    optional_host_permissions: ['http://*/*', 'https://*/*'],
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
      'activeTab',
      'storage',
      'unlimitedStorage',
      'scripting',
      'webNavigation',
    ],
  },
});
