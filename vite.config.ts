import { defineConfig } from 'vite';
export default defineConfig({
  server: { host: '0.0.0.0', proxy: { '/wfs': 'http://127.0.0.1:8787', '/health': 'http://127.0.0.1:8787', '/api/test-wfs': 'http://127.0.0.1:8787', '/test-wfs': 'http://127.0.0.1:8787', '/api': 'http://127.0.0.1:8788' } },
  worker: { format: 'es' },
  build: { target: 'es2022' }
});
