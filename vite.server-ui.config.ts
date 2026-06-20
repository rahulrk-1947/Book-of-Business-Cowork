import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { resolve } from 'node:path';

// Builds the hosted-edition single-page app served by the Fastify server.
export default defineConfig({
  plugins: [react()],
  root: '.',
  build: {
    outDir: 'dist-server-ui',
    emptyOutDir: true,
    rollupOptions: { input: resolve(__dirname, 'server-ui.html') },
  },
});
