import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

const buildId = String(process.env.YALI_ADMIN_BUILD_ID || Date.now().toString(36))
  .replace(/[^a-zA-Z0-9_-]+/g, '')
  .slice(0, 32);

export default defineConfig({
  plugins: [react()],
  base: '/admin/',
  build: {
    rollupOptions: {
      output: {
        entryFileNames: `assets/[name]-${buildId}-[hash].js`,
        chunkFileNames: `assets/[name]-${buildId}-[hash].js`,
        assetFileNames: `assets/[name]-${buildId}-[hash][extname]`,
        manualChunks(id) {
          if (
            id.includes('/react/')
            || id.includes('/react-dom/')
            || id.includes('/scheduler/')
          ) {
            return 'react-vendor';
          }
          return undefined;
        },
      },
    },
  },
});
