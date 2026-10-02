import { execFileSync } from 'node:child_process';
import { readFileSync, openSync, writeSync, closeSync, renameSync } from 'node:fs';
import { createHash } from 'node:crypto';
// Small committed binary parts keep the exact npm cache portable over repository APIs.
const directory='vendor/npm-cache-parts',manifest=JSON.parse(readFileSync(directory+'/manifest.json','utf8'));
const target='vendor/npm-cache.tar.gz',file=openSync(target+'.tmp','w'),hash=createHash('sha256');
let bytes=0;
try{for(const name of manifest.parts){if(!/^\d{3}\.bin$/.test(name))throw Error('Invalid vendor part name');const part=readFileSync(directory+'/'+name);hash.update(part);writeSync(file,part);bytes+=part.length;}}finally{closeSync(file);}
if(bytes!==manifest.bytes||hash.digest('hex')!==manifest.sha256)throw Error('Vendored npm cache checksum mismatch');
renameSync(target+'.tmp',target);
execFileSync('tar',['-xzf',target,'-C','vendor'],{stdio:'inherit'});
execFileSync('npm',['ci','--offline','--cache','vendor/npm-cache','--no-audit','--no-fund'],{stdio:'inherit'});
