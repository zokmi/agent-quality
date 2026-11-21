import {spawnSync} from 'node:child_process';
import {createHash, randomUUID} from 'node:crypto';
import {lstatSync, mkdirSync, readFileSync, readdirSync, realpathSync, renameSync, rmdirSync, statSync, writeFileSync} from 'node:fs';
import {dirname, isAbsolute, join, relative, resolve, sep} from 'node:path';

export const hash = value => createHash('sha256').update(value).digest('hex');
export function inside(root, path) {
  const rel = relative(root,path);
  return rel !== '..' && !rel.startsWith('..'+sep) && !isAbsolute(rel);
}
const defaults = {
  lint:{enabled:true,incremental:true}, autoFix:{enabled:true,maxRetries:3},
  review:{enabled:true,provider:'superpowers'}, learning:{enabled:true},
  architecture:{enabled:true}, qualityGate:{enabled:true,hookCommands:false},
  metrics:{enabled:true}, testSelection:{enabled:true}
};
function optional(path, fallback) {
  try { return readFileSync(path,'utf8'); }
  catch (error) { if (error.code === 'ENOENT') return fallback; throw error; }
}
function localEntry(path) {
  try {
    if (lstatSync(path).isSymbolicLink()) throw new Error('Symbolic links are forbidden for configuration and state');
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  return path;
}
function component(value) {
  if (typeof value !== 'string' || !/^[a-zA-Z][a-zA-Z0-9_-]{0,63}$/.test(value)) throw new Error('Invalid state category');
  return value;
}
export function projectRoot(cwd) {
  const original = realpathSync(cwd);
  for (let candidate = original; ; candidate = dirname(candidate)) {
    for (const marker of ['.agent-quality.json','.git']) {
      try { lstatSync(join(candidate,marker)); return candidate; }
      catch (error) { if (error.code !== 'ENOENT') throw error; }
    }
    if (candidate === dirname(candidate)) return original;
  }
}
export function context(cwd, {hook=false}={}) {
  const root = realpathSync(cwd);
  const deadline = hook ? Date.now()+27000 : Infinity;
  const user = JSON.parse(optional(localEntry(join(root,'.agent-quality.json')),'{}'));
  if (!user || typeof user !== 'object' || Array.isArray(user)) throw new Error('Configuration must be an object');
  const config = Object.fromEntries(Object.entries(defaults).map(([key,base]) => {
    const value = user[key];
    if (value !== undefined && (!value || typeof value !== 'object' || Array.isArray(value))) {
      throw new Error('Invalid configuration section: '+key);
    }
    return [key,{...base,...value}];
  }));
  const base = localEntry(join(root,'.agent-quality'));
  function folder(category) {
    localEntry(base);
    return localEntry(join(base,component(category)));
  }
  function resolveFile(path) {
    if (typeof path !== 'string' || !path || /[\x00-\x1f]/u.test(path)) throw new Error('Invalid file path');
    const candidate = resolve(root,path);
    if (!inside(root,candidate)) throw new Error('File is outside project');
    const actual = realpathSync(candidate);
    if (!inside(root,actual) || !statSync(actual).isFile()) throw new Error('Expected a project file');
    return actual;
  }
  function run(command,args,{cwd=root,timeoutMs=5000,env={}}={}) {
    if (typeof command !== 'string' || !command || !Array.isArray(args) ||
        [command,...args].some(arg => typeof arg !== 'string' || arg.includes('\0'))) throw new Error('Invalid command or arguments');
    const actual = realpathSync(cwd);
    if (!inside(root,actual)) throw new Error('Execution cwd is outside project');
    const start = Date.now();
    if (start >= deadline) return {status:'BLOCKED',stdout:'',stderr:'',exitCode:null,durationMs:0,error:'HOOK_DEADLINE'};
    const result = spawnSync(command,args,{cwd:actual,timeout:Math.min(deadline-start,25000,Math.max(1,Number(timeoutMs)||5000)),
      shell:false,encoding:'utf8',windowsHide:true,maxBuffer:2*1024*1024,killSignal:'SIGKILL',
      env:{...process.env,...env,AGENT_QUALITY_RUNNING:'1'}});
    return {status:result.error || result.signal ? 'BLOCKED' : result.status === 0 ? 'PASS' : 'FAIL',
      stdout:result.stdout || '',stderr:result.stderr || '',exitCode:result.status,
      durationMs:Date.now()-start,error:result.error?.code || result.signal || null};
  }
  function read(category,key,fallback) {
    const raw = optional(localEntry(join(folder(category),hash(String(key))+'.json')),null);
    return raw === null ? fallback : JSON.parse(raw);
  }
  function write(category,key,value) {
    const dir = folder(category);
    mkdirSync(dir,{recursive:true,mode:0o700});
    const target = localEntry(join(dir,hash(String(key))+'.json'));
    const temporary = join(dir,randomUUID()+'.tmp');
    writeFileSync(temporary,JSON.stringify(value),{flag:'wx',mode:0o600});
    renameSync(temporary,target);
  }
  function list(category) {
    const dir = folder(category);
    let entries;
    try { entries = readdirSync(dir); } catch (error) { if (error.code === 'ENOENT') return []; throw error; }
    return entries.filter(name => /^[a-f0-9]{64}\.json$/.test(name)).map(name =>
      JSON.parse(readFileSync(localEntry(join(dir,name)),'utf8')));
  }
  function lock(key,operation) {
    const dir = folder('locks');
    mkdirSync(dir,{recursive:true,mode:0o700});
    const token = join(dir,hash(String(key))+'.lock');
    try { mkdirSync(token,{mode:0o700}); }
    catch (error) {
      if (error.code === 'EEXIST') throw new Error('Another state update is in progress for '+key);
      throw error;
    }
    try { return operation(); }
    finally { rmdirSync(token); }
  }
  return {root,config,hook,resolveFile,run,read,write,list,lock};
}

export function uniqueDiagnostics(findings) {
  const byLocation = new Map();
  for (const finding of findings) {
    const key = JSON.stringify([finding.file,finding.line,finding.rule || finding.message]);
    const previous = byLocation.get(key);
    if (!previous || previous.source === 'review' && finding.source !== 'review') byLocation.set(key,finding);
  }
  return [...byLocation.values()];
}
export const snippet = (value, limit=400) => String(value ?? '').slice(0,limit);

