import {mkdir,copyFile,readdir,writeFile,stat} from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';
import {readFile} from 'node:fs/promises';
const root=fileURLToPath(new URL('../',import.meta.url));
const target=process.argv[2];if(!target||!path.isAbsolute(target))throw Error('Provide a new absolute export directory.');
await mkdir(target);const files=[];
async function add(relative){const src=path.join(root,relative),info=await stat(src);if(info.isDirectory()){for(const child of await readdir(src)){if(child.startsWith('.'))continue;await add(path.join(relative,child));}return;}if(!/\.(mjs|js|jsx|css|sql|json|html|md|yml|yaml)$/.test(relative)&&relative!=='.node-version')throw Error('Unexpected export type: '+relative);await mkdir(path.dirname(path.join(target,relative)),{recursive:true});await copyFile(src,path.join(target,relative));files.push({path:relative,sha256:createHash('sha256').update(await readFile(src)).digest('hex')});}
for(const name of ['hosted','server','shared','src','tests','scripts','package.json','package-lock.json','vite.config.js','index.html','.node-version','render.yaml','DEPLOYMENT.md','.github/workflows/verify.yml'])await add(name);
await writeFile(path.join(target,'.gitignore'),'node_modules/\ndist/\n.env*\n.data/\n.runtime/\n*.log\n');
await writeFile(path.join(target,'deployment-manifest.json'),JSON.stringify(files,null,2)+'\n');console.log(`Exported ${files.length} source files. No environment, payment records or deployment evidence included.`);
