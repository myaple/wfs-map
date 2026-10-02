import { readFileSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { createHash } from 'node:crypto';
const archive=readFileSync('vendor/npm-cache.tar.gz');
const directory='vendor/npm-cache-parts';
rmSync(directory,{recursive:true,force:true});mkdirSync(directory,{recursive:true});
const parts=[];
for(let offset=0;offset<archive.length;offset+=750000){const name=String(parts.length).padStart(3,'0')+'.bin';writeFileSync(directory+'/'+name,archive.subarray(offset,offset+750000));parts.push(name);}
writeFileSync(directory+'/manifest.json',JSON.stringify({bytes:archive.length,sha256:createHash('sha256').update(archive).digest('hex'),parts},null,2)+'\n');
