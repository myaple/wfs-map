import { defineConfig } from '@playwright/test';
const baseURL = process.env.WFS_E2E_URL ?? 'http://127.0.0.1:8787';

// No webServer or API route mocks: this suite requires the real Compose stack.
export default defineConfig({
    testDir: './tests/e2e',
    timeout: 60_000,
    workers: 1,
    reporter: 'list',
    use: {
        baseURL,
        viewport: { width: 1440, height: 900 },
        trace: 'retain-on-failure',
        // Docker DNS names are not loopback origins. Keep the test browser's
        // secure-context APIs equivalent to localhost / the real HTTPS gateway.
        launchOptions: { args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', `--unsafely-treat-insecure-origin-as-secure=${new URL(baseURL).origin}`] }
    }
});
