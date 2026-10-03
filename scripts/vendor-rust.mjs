import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync, existsSync, renameSync, rmSync } from 'node:fs';
import { createHash } from 'node:crypto';
const config = 'backend/.cargo/config.toml', previous = config + '.previous';
const rootConfig = '.cargo/config.toml', rootPrevious = rootConfig + '.previous';
mkdirSync('backend/.cargo', { recursive: true });
if (existsSync(config)) renameSync(config, previous);
if (existsSync(rootConfig)) renameSync(rootConfig, rootPrevious);
try {
    const output = execFileSync('cargo', ['vendor', '--locked', 'vendor'], { cwd: 'backend', encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'] });
    writeFileSync(config, output);
    execFileSync('tar', ['--sort=name', '--mtime=2026-01-01T00:00:00Z', '--owner=0', '--group=0', '--numeric-owner', '-czf', 'rust-vendor.tar.gz', 'vendor'], { cwd: 'backend', stdio: 'inherit' });
    const data = readFileSync('backend/rust-vendor.tar.gz'), directory = 'backend/vendor-parts';
    rmSync(directory, { recursive: true, force: true }); mkdirSync(directory);
    const parts = [];
    for (let offset = 0; offset < data.length; offset += 750000) {
        const name = String(parts.length).padStart(3, '0') + '.bin'; parts.push(name); writeFileSync(directory + '/' + name, data.subarray(offset, offset + 750000));
    }
    const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
    writeFileSync(directory + '/manifest.json', JSON.stringify({ bytes: data.length, sha256: sha256(data), cargoLockSha256: sha256(readFileSync('backend/Cargo.lock')), parts }, null, 2) + '\n');
    rmSync(previous, { force: true });
    if (existsSync(rootPrevious)) renameSync(rootPrevious, rootConfig);
    console.log(`Vendored Rust dependencies: ${data.length} bytes in ${parts.length} parts. Licenses are included with each crate.`);
} catch (e) {
    if (existsSync(previous)) renameSync(previous, config);
    if (existsSync(rootPrevious)) renameSync(rootPrevious, rootConfig);
    throw e;
}
