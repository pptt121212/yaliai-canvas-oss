import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  build: {
    // ONNX Runtime is loaded only when the background-removal tool is used.
    chunkSizeWarningLimit: 900,
    rollupOptions: {
      output: {
        manualChunks(id) {
          if (id.includes('onnxruntime-web')) {
            return 'onnx-runtime';
          }
          if (id.includes('@imgly/background-removal')) {
            return 'background-removal';
          }
          if (id.includes('@xyflow/react') || id.includes('@xyflow/system')) {
            return 'react-flow';
          }
          if (id.includes('packages/canvas-core')) {
            return 'canvas-core';
          }
          if (id.includes('lucide-react')) {
            return 'icons';
          }
          if (id.includes('jszip')) {
            return 'zip-tools';
          }
          if (id.includes('node_modules')) {
            if (id.includes('/react/') || id.includes('/react-dom/') || id.includes('/scheduler/')) {
              return 'react-vendor';
            }
            return 'vendor';
          }
          return undefined;
        },
      },
    },
  },
});
