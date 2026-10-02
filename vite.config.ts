import { defineConfig } from 'vite';
export default defineConfig({
  server: { host: '0.0.0.0', proxy: { '/wfs': 'http://127.0.0.1:8787', '/health': 'http://127.0.0.1:8787' } },
  worker: { format: 'es' },
  build: { target: 'es2022' }
});
