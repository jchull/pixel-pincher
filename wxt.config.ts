import { defineConfig } from 'wxt';

export default defineConfig({
  manifest: {
    name: 'Pixel Pincher',
    description: 'Overlay and compare reference images on web pages.',
    permissions: ['storage', 'activeTab', 'scripting'],
  },
});
