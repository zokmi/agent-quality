import {lstatSync,readFileSync,readdirSync,writeFileSync} from 'node:fs';
import {join} from 'node:path';

const ignored = new Set(['node_modules','vendor','target','dist','build','coverage','obj']);
const eslint = /^(eslint\.config\.[cm]?[jt]s|\.eslintrc(\..+)?)$/;
const markers = new Map([
  ['biome.json','biome'],['biome.jsonc','biome'],['ruff.toml','ruff'],['.ruff.toml','ruff'],
  ['Cargo.toml','clippy'],['go.mod','golangci-lint'],['checkstyle.xml','checkstyle']
]);

function readOptional(path) {
  try { return lstatSync(path).isFile() ? readFileSync(path,'utf8') : ''; }
  catch (error) { if (error.code === 'ENOENT') return ''; throw error; }
}

export function initialize(ctx) {
  const path = join(ctx.root,'.agent-quality.json');
  try { lstatSync(path); return {status:'EXISTS',path}; }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  const tools = new Set();
  const folders = [{path:ctx.root,depth:0}];
  for (let scanned=0; folders.length && scanned<400; scanned++) {
    const current = folders.shift();
    for (const entry of readdirSync(current.path,{withFileTypes:true})) {
      if (entry.isFile()) {
        const marker = markers.get(entry.name);
        if (marker) tools.add(marker);
        if (eslint.test(entry.name)) tools.add('eslint');
        if (entry.name.endsWith('.csproj')) tools.add('roslyn');
        if (entry.name === 'pyproject.toml' && /^\s*\[tool\.ruff(?:[.\]])/m.test(readOptional(join(current.path,entry.name)))) tools.add('ruff');
      } else if (entry.isDirectory() && current.depth < 3 && folders.length < 400 &&
        !entry.name.startsWith('.') && !ignored.has(entry.name)) {
        folders.push({path:join(current.path,entry.name),depth:current.depth+1});
      }
    }
  }
  const scripts = JSON.parse(readOptional(join(ctx.root,'package.json')) || '{}').scripts ?? {};
  const commands = {};
  if (typeof scripts.test === 'string' && scripts.test.trim() === 'node --test') commands.unit = ['node','--test'];
  const required = [...(tools.size ? ['lint'] : []),...Object.keys(commands)];
  const qualityGate = {enabled:true,hookCommands:false};
  if (required.length) qualityGate.required = required;
  if (Object.keys(commands).length) qualityGate.commands = commands;
  const config = {lint:{enabled:true,incremental:true},autoFix:{enabled:true,maxRetries:3},
    learning:{enabled:true,minimumOccurrences:2},qualityGate,testSelection:{enabled:true}};
  const pending = ['format','typeCheck','unit','integration','review','bdd','architecture'].filter(name => !commands[name]);
  try { writeFileSync(path,JSON.stringify(config,null,2)+'\n',{flag:'wx'}); }
  catch (error) { if (error.code === 'EEXIST') return {status:'EXISTS',path}; throw error; }
  return {status:'CREATED',path,detectedLintTools:[...tools].sort(),required,pending};
}
