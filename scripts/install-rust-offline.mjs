import { execFileSync } from 'node:child_process';
import { readFileSync, openSync, writeSync, closeSync, renameSync } from 'node:fs';
import { createHash } from 'node:crypto';
const directory='backend/vendor-parts', manifest=JSON.parse(readFileSync(directory+'/manifest.json','utf8'));
const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
if(hash(readFileSync('backend/Cargo.lock'))!==manifest.cargoLockSha256) throw Error('Rust vendor bundle does not match Cargo.lock. Run npm run vendor:rust on a connected build machine.');
const target='backend/rust-vendor.tar.gz', file=openSync(target+'.tmp','w'), digest=createHash('sha256'); let bytes=0;
try { for(const name of manifest.parts) { if(!/^\d{3}\.bin$/.test(name)) throw Error('Invalid Rust vendor part name');const part=readFileSync(directory+'/'+name);digest.update(part);writeSync(file,part);bytes+=part.length; } } finally { closeSync(file); }
if(bytes!==manifest.bytes||digest.digest('hex')!==manifest.sha256) throw Error('Rust vendor bundle checksum mismatch');
renameSync(target+'.tmp',target);
execFileSync('tar',['-xzf',target,'-C','backend'],{stdio:'inherit'});
