import { spawn } from 'node:child_process';
const children = [spawn(process.execPath, ['server/server.ts'], {stdio:'inherit'}), spawn(process.execPath, ['node_modules/vite/bin/vite.js'], {stdio:'inherit'})];
function stop() { for(const c of children) c.kill(); }
for(const c of children) c.on('exit',()=>{ stop(); process.exitCode=1; });
process.on('SIGINT',stop); process.on('SIGTERM',stop);
