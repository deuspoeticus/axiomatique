import { defineConfig } from 'vite';

export default defineConfig({
  base: '/axiomatique/',
  server: {
    port: 1420,
    strictPort: true,
  },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
  },
});
