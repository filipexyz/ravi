/** bun scripts/prepare-desktop.ts /path/to/clean/ravi-desktop FULL_SHA
 * Installs the frozen lockfile and builds this exact revision through Bun.
 * Source and artifact are reviewed together; no network fetching or branch fallback.
 */
import { mkdir, readFile, readdir, copyFile, writeFile } from 'node:fs/promises';
import { resolve, relative } from 'node:path';
import { createHash } from 'node:crypto';
const [source,revision]=process.argv.slice(2);
if(!source || !/^[a-f0-9]{40}$/.test(revision??''))throw new Error('Supply source checkout and exact revision');
const git=(args:string[])=>{const p=Bun.spawnSync(['git','-C',source,...args]);if(p.exitCode)throw new Error('Git verification failed');return p.stdout.toString().trim();};
if(git(['rev-parse','HEAD'])!==revision || git(['status','--porcelain']))throw new Error('Desktop checkout must be clean at requested revision');
const bun = process.env.RAVI_DESKTOP_BUN ?? 'bun';
for (const args of [['install','--frozen-lockfile'], ['run','build']]) {
  const child = Bun.spawn([bun,...args], {cwd:source, env:{...process.env,RAVI_DESKTOP_BASE:'/desktop-assets/'},stdout:'inherit',stderr:'inherit'});
  if(await child.exited) throw new Error('Desktop build failed');
}
if(git(['rev-parse','HEAD'])!==revision || git(['status','--porcelain']))throw new Error('Desktop source changed during build');
const dist=resolve(source,'apps/web/dist');
const root=resolve('.desktop');
const files:Record<string,string>={};
async function copy(dir:string){for(const item of await readdir(dir,{withFileTypes:true})){const path=resolve(dir,item.name);if(item.isDirectory()){await copy(path);continue;}const name=relative(dist,path);if(name!=='connected.html' && !name.startsWith('assets/'))continue;const bytes=await readFile(path);const target=resolve(root,name);await mkdir(resolve(target,'..'),{recursive:true});await copyFile(path,target);files[name]=createHash('sha256').update(bytes).digest('hex');}}
await copy(dist);
if(!files['connected.html'])throw new Error('Missing connected Desktop build');
const html=await readFile(resolve(root,'connected.html'),'utf8');
if(!html.includes('/desktop-assets/assets/'))throw new Error('Build with RAVI_DESKTOP_BASE=/desktop-assets/');
await writeFile(resolve(root,'manifest.json'),JSON.stringify({revision,files},null,2));
console.log(`Prepared original Desktop ${revision} (${Object.keys(files).length} files)`);
