import {readFileSync} from 'node:fs';
import {relative,resolve} from 'node:path';
import {context,hash,projectRoot} from '../lib/core.mjs';
import {lint,previewFix} from '../lib/lint.mjs';
import {architecture} from '../lib/architecture.mjs';
import {select} from '../lib/selection.mjs';
import {review} from '../lib/review.mjs';
import {gate,formatGate} from '../lib/gate.mjs';
import {dispatch} from '../lib/hooks.mjs';
import {initialize} from '../lib/init.mjs';
import * as learning from '../lib/learning.mjs';
import {recordMetrics,qualityReport} from '../lib/metrics.mjs';

function readInput() {
  const raw = readFileSync(0,'utf8');
  if (raw.length > 2*1024*1024) throw new Error('Request exceeds size limit');
  return raw.trim() ? JSON.parse(raw) : {};
}
function observe(ctx,kind,result,taskId) {
  if (result.diagnostics?.length && ctx.config.learning.enabled) learning.collect(ctx,result.diagnostics,{taskId});
  if (ctx.config.metrics.enabled) recordMetrics(ctx,{kind,taskId,...result});
  return result;
}
function changedFiles(ctx) {
  const result = ctx.run('git',['status','--porcelain=v1','-z','--untracked-files=all']);
  if (result.status !== 'PASS') throw new Error('Cannot determine Git changes: '+(result.error || result.stderr));
  const records = result.stdout.split('\0').filter(Boolean);
  const changes = [];
  for (let index=0; index<records.length; index++) {
    const record = records[index];
    const status = record.slice(0,2);
    const path = record.slice(3);
    if (/[RC]/.test(status)) changes.push(records[++index]);
    if (!path.startsWith('.agent-quality/')) changes.push(path);
  }
  return [...new Set(changes)];
}
function metadata(args) {
  const files = [];
  const options = {format:'json'};
  for (let index=0; index<args.length; index++) {
    const arg = args[index];
    if (arg === '--') return {...options,files:[...files,...args.slice(index+1)]};
    if (arg === '--stdin') options.stdin = true;
    else if (arg === '--changed') options.changed = true;
    else if (arg === '--markdown') options.format = 'markdown';
    else if (arg === '--task' && args[index+1]) options.taskId = args[++index];
    else if (arg.startsWith('--')) throw new Error('Unknown or incomplete option: '+arg);
    else files.push(arg);
  }
  return {...options,files};
}

function fix(ctx,input,complete=false) {
  if (!ctx.config.autoFix.enabled) return {status:'SKIPPED'};
  if (typeof input.taskId !== 'string' || !input.taskId || typeof input.rule !== 'string' || !input.rule) {
    throw new Error('Expected taskId, file and rule');
  }
  const file = ctx.resolveFile(input.file);
  const key = hash(JSON.stringify([input.taskId,file,input.rule]));
  const state = ctx.read('fixes',key,{attempts:0});
  const maximum = ctx.config.autoFix.maxRetries;
  if (!Number.isInteger(maximum) || maximum < 1 || maximum > 10) throw new Error('maxRetries must be between 1 and 10');
  if (complete) {
    if (!state.attempts || state.closed) return {status:'BLOCKED',reason:'No open attempt to verify'};
    const lintEvidence = observe(ctx,'lint',lint(ctx,ctx.config.lint.incremental ? [file] : []),input.taskId);
    const stillPresent = lintEvidence.diagnostics?.some(d => d.file && resolve(ctx.root,d.file) === file && d.rule === input.rule);
    if (stillPresent || !['PASS','FAIL'].includes(lintEvidence.status)) {
      return observe(ctx,'fix',{status:'FAIL',attempts:state.attempts,operationId:key,lint:lintEvidence,
        diagnostics:lintEvidence.diagnostics,reason:'The original finding persists or lint could not verify it.'},input.taskId);
    }
    const evidence = gate(ctx,[file],input);
    if (evidence.status === 'PASS') ctx.write('fixes',key,{...state,closed:true});
    return observe(ctx,'fix',{...evidence,attempts:state.attempts,operationId:key,lint:lintEvidence},input.taskId);
  }
  if (state.closed || state.attempts >= maximum) return {status:'BLOCKED',attempts:state.attempts,
    reason:state.closed ? 'Fix has already been verified' : 'Retry budget exhausted',
    diagnostics:[{source:'fix',severity:'error',file:relative(ctx.root,file),line:null,rule:input.rule,message:'Automatic fix retry budget exhausted',evidence:''}]};
  const attempts = state.attempts+1;
  ctx.write('fixes',key,{attempts});
  return {status:'PASS',attempts};
}

function main() {
  const [command,...args] = process.argv.slice(2);
  if (command === 'hook') return dispatch(readInput(),observe);
  const ctx = context(projectRoot(process.cwd()));
  const {files:paths,format,stdin,taskId,changed} = metadata(args);
  if (changed && !['select','gate'].includes(command)) throw new Error('--changed is available for select and gate');
  const files = changed ? [...new Set([...paths,...changedFiles(ctx)])] : paths;
  switch (command) {
    case 'init': return initialize(ctx);
    case 'lint': return observe(ctx,'lint',lint(ctx,files),taskId);
    case 'fix-preview': return ctx.config.autoFix.enabled ? previewFix(ctx,files) : {status:'SKIPPED'};
    case 'fix-attempt':
    case 'fix-verify': {
      const input = readInput();
      if (!ctx.config.autoFix.enabled) return {status:'SKIPPED'};
      const key = hash(JSON.stringify([input.taskId,ctx.resolveFile(input.file),input.rule]));
      return ctx.lock('fix-'+key,() => fix(ctx,input,command === 'fix-verify'));
    }
    case 'review': return observe(ctx,'review',review(ctx,readInput()),taskId);
    case 'architecture': {
      const result = architecture(ctx,files);
      const active = ctx.config.architecture.enabled && ctx.config.learning.enabled ? learning.activeLearnedRules(ctx) : [];
      const learned = active.length ? learning.learnedDiagnostics(ctx,files) : [];
      const status = result.status === 'NOT_CONFIGURED' && active.length ? 'PASS' : result.status;
      return observe(ctx,'validation',{...result,diagnostics:[...(result.diagnostics ?? []),...learned],
        status:learned.some(d => d.severity === 'error') ? 'FAIL' : status},taskId);
    }
    case 'select': return select(ctx,files);
    case 'gate': {
      const result = observe(ctx,'validation',gate(ctx,files,stdin ? readInput() : {}),taskId);
      if (result.status !== 'PASS') process.exitCode = 1;
      return format === 'markdown' ? formatGate(result) : result;
    }
    case 'report': return qualityReport(ctx,{taskId,format});
    case 'collect': return learning.collect(ctx,readInput(),{taskId});
    case 'proposals': return learning.proposals(ctx);
    case 'propose': {
      const input = readInput();
      return ctx.lock('rules',() => learning.propose(ctx,input));
    }
    case 'validate-rule':
    case 'approve-rule': {
      const input = readInput();
      const handler = command === 'validate-rule' ? learning.validate : learning.approve;
      return ctx.lock('rules',() => handler(ctx,files[0],input));
    }
    case 'activate-rule': return ctx.lock('rules',() => learning.activate(ctx,files[0]));
    case 'deactivate-rule': return ctx.lock('rules',() => learning.deactivate(ctx,files[0]));
    case 'rollback-rule': return ctx.lock('rules',() => learning.rollback(ctx,files[0]));
    default: throw new Error('Expected a command. See README.md for usage.');
  }
}
try {
  const output = main();
  console.log(typeof output === 'string' ? output : JSON.stringify(output ?? null));
} catch (error) {
  console.error('agent-quality: '+error.message);
  process.exitCode = 1;
}

