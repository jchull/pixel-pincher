import { defineConfig } from 'wxt';

export default defineConfig({
  manifest: {
    name: 'Pixel Pincher',
    description: 'Overlay and compare reference images on web pages.',
    incognito: 'not_allowed',
    optional_host_permissions: ['http://*/*', 'https://*/*'],
    permissions: [
      'activeTab',
      'storage',
      'unlimitedStorage',
      'scripting',
      'webNavigation',
    ],
  },
});
