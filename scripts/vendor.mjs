// Populate an npm integrity cache from the exact lockfile, including optional native
// packages installed on this platform. npm ci --offline reads the vendored cache.
import { readFile, mkdir, readdir, copyFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { execFileSync, spawn } from 'node:child_process';
const lock=JSON.parse(await readFile('package-lock.json','utf8'));
const packages=Object.entries(lock.packages).filter(([path,p])=>path&&p.resolved&&existsSync(path));
await mkdir('vendor/licenses',{recursive:true});
const manifest=[];
let next=0;
async function collect() {
  while(next<packages.length) {
    const [path,p]=packages[next++];
    await new Promise((resolve,reject)=>{
      const args=['cache','add',p.resolved,'--cache','vendor/npm-cache','--prefer-offline','--fetch-retries=1'];
      const child=process.platform==='win32'?spawn(process.env.ComSpec??'cmd.exe',['/d','/s','/c','npm',...args],{stdio:'pipe'}):spawn('npm',args,{stdio:'pipe'});
      let err='';child.stderr.on('data',v=>err+=v);child.on('error',reject);child.on('exit',code=>code===0?resolve():reject(new Error(err)));
    });
    const name=path.replace(/^node_modules\//,'').replaceAll('/','_');
    for(const filename of await readdir(path))if(/^(licen[cs]e|copying|notice|thirdparty)/i.test(filename)) {
      try{await copyFile(path+'/'+filename,`vendor/licenses/${name}-${p.version}-${filename}`);}catch{}
    }
    manifest.push({name:path.replace(/^node_modules\//,''),version:p.version,integrity:p.integrity,license:p.license});
    console.log(`Vendored ${name}@${p.version}`);
  }
}
await Promise.all(Array.from({length:4},collect));
await writeFile('vendor/manifest.json',JSON.stringify({platform:process.platform,arch:process.arch,node:process.version,packages:manifest.sort((a,b)=>a.name.localeCompare(b.name))},null,2));
console.log(`Offline source build prepared for ${process.platform}/${process.arch}. Built dist/ runs on any supported Node platform without npm install.`);

execFileSync('tar',['-czf','vendor/npm-cache.tar.gz','-C','vendor','npm-cache/_cacache'],{stdio:'inherit'});

execFileSync(process.execPath,['scripts/split-vendor.mjs'],{stdio:'inherit'});
