import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  server: {
    port: Number(process.env.WEB_PORT ?? 5173),
    proxy: {
      // Proxy API calls to apps/api so we don't fight CORS in dev.
      '/auth': 'http://localhost:3000',
      '/me': 'http://localhost:3000',
      '/network': 'http://localhost:3000',
      '/documents': 'http://localhost:3000',
      '/attachments': 'http://localhost:3000',
      '/health': 'http://localhost:3000',
    },
  },
});
