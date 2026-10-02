import { defineConfig } from '@playwright/test';
export default defineConfig({
  testDir:'./tests/browser',timeout:180_000,workers:1,
  use:{baseURL:'http://127.0.0.1:8787',viewport:{width:1440,height:900},launchOptions:{args:['--use-gl=angle','--use-angle=swiftshader','--enable-unsafe-swiftshader']}},
  webServer:{command:'npm start',url:'http://127.0.0.1:8787/health',reuseExistingServer:true}
});
