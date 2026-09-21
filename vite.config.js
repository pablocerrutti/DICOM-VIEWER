import { defineConfig } from 'vite';

export default defineConfig({
  base: './',
  optimizeDeps: {
    exclude: ['@cornerstonejs/dicom-image-loader', '@icr/polyseg-wasm'],
    include: ['dicom-parser']
  },
  worker: {
    format: 'es',
    rollupOptions: {
      external: ['@icr/polyseg-wasm']
    }
  },
  build: {
    target: 'es2020',
    rollupOptions: {
      external: ['@icr/polyseg-wasm']
    }
  }
});
