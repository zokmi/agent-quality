import assert from 'node:assert/strict';
import {mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {spawnSync} from 'node:child_process';
import {test} from 'node:test';
import {fileURLToPath} from 'node:url';

const plugin = fileURLToPath(new URL('../', import.meta.url));
const cli = join(plugin, 'bin', 'quality.mjs');
const json = path => JSON.parse(readFileSync(path, 'utf8'));
function call(cwd, args, input) {
  const result = spawnSync(process.execPath, [cli, ...args], {
    cwd, encoding:'utf8', input:input === undefined ? undefined : JSON.stringify(input)
  });
  return {...result, data: result.stdout ? JSON.parse(result.stdout) : null};
}
function project(t, config) {
  const root = mkdtempSync(join(tmpdir(),'agent-quality-'));
  t.after(() => rmSync(root,{recursive:true,force:true}));
  if (config) writeFileSync(join(root,'.agent-quality.json'),JSON.stringify(config));
  return root;
}
test('manifest, skills and hook discovery', () => {
  assert.equal(json(join(plugin,'.claude-plugin','plugin.json')).name,'agent-quality');
  const skills = readdirSync(join(plugin,'skills'));
  assert.equal(skills.length,9);
  for (const skill of skills) assert.ok(readFileSync(join(plugin,'skills',skill,'SKILL.md'),'utf8').includes('name: '+skill+'\n'));
  assert.deepEqual(Object.keys(json(join(plugin,'hooks','hooks.json')).hooks),['PostToolUse','Stop']);
  const codex = json(join(plugin,'.codex-plugin','plugin.json'));
  assert.equal(codex.version,json(join(plugin,'package.json')).version);
  assert.deepEqual(Object.keys(json(join(plugin,codex.hooks)).hooks),['PostToolUse','Stop','UserPromptSubmit']);
});

test('init discovers project tools and preserves existing configuration', t => {
  const root = project(t);
  writeFileSync(join(root,'package.json'),JSON.stringify({scripts:{test:'node --test'}}));
  writeFileSync(join(root,'eslint.config.js'),'');
  const result = call(root,['init']);
  assert.equal(result.status,0,result.stderr);
  assert.equal(result.data.status,'CREATED');
  const config = json(join(root,'.agent-quality.json'));
  assert.deepEqual(config.qualityGate.required,['lint','unit']);
  assert.deepEqual(config.qualityGate.commands.unit,['node','--test']);
  const before = readFileSync(join(root,'.agent-quality.json'),'utf8');
  assert.equal(call(root,['init']).data.status,'EXISTS');
  assert.equal(readFileSync(join(root,'.agent-quality.json'),'utf8'),before);
});

test('init leaves checks without reliable tooling unconfigured', t => {
  const root = project(t);
  writeFileSync(join(root,'index.js'),'');
  assert.equal(call(root,['init']).data.status,'CREATED');
  assert.equal(json(join(root,'.agent-quality.json')).qualityGate.required,undefined);
});
test('gate fails for missing or failing BDD evidence', t => {
  const root = project(t,{qualityGate:{required:['bdd']}});
  const result = call(root,['gate']);
  assert.equal(result.status,1,result.stderr);
  assert.equal(result.data.checks.bdd.status,'NOT_CONFIGURED');
  const configured = project(t,{qualityGate:{required:['bdd'],commands:{bdd:[process.execPath,'-e','process.exit(4)']}}});
  assert.equal(call(configured,['gate']).data.checks.bdd.status,'FAIL');
});
test('review detects the live skill and deduplicates findings', t => {
  const root = project(t);
  assert.equal(call(root,['review'],{}).data.status,'NOT_CONFIGURED');
  const finding = {file:'a.js',line:2,rule:'same',message:'Check this'};
  const result = call(root,['review'],{skills:['superpowers:requesting-code-review'],findings:[finding,finding]});
  assert.equal(result.data.diagnostics.length,1,result.stderr);
});
test('hooks reject outside paths and stop recursion', t => {
  const root = project(t);
  const other = project(t);
  const outside = join(other,'a.js');
  writeFileSync(outside,'x');
  const base = {cwd:root,session_id:'abc'};
  assert.equal(call(root,['hook'],{...base,hook_event_name:'PostToolUse',tool_name:'Edit',tool_input:{file_path:outside}}).status,1);
  assert.deepEqual(call(root,['hook'],{...base,hook_event_name:'Stop',stop_hook_active:true}).data,{});
  assert.deepEqual(call(other,['hook'],{...base,cwd:other,hook_event_name:'Stop'}).data,{});
});
test('fix retries are bounded and project local', t => {
  const first = project(t);
  const second = project(t);
  for (const root of [first,second]) writeFileSync(join(root,'x.js'),'x');
  const attempt = root => call(root,['fix-attempt'],{taskId:'t',file:'x.js',rule:'r'}).data;
  assert.equal(attempt(first).attempts,1);
  assert.equal(attempt(first).attempts,2);
  assert.equal(attempt(first).attempts,3);
  assert.equal(attempt(first).status,'BLOCKED');
  assert.equal(attempt(second).attempts,1);
});

test('nested hook finds root config and reports lint before bounded Stop', t => {
  const root = project(t,{qualityGate:{required:['lint','unit'],commands:{unit:[process.execPath,'--version']}}});
  const nested = join(root,'src');
  mkdirSync(nested);
  writeFileSync(join(nested,'x.js'),'bad');
  writeFileSync(join(root,'eslint.config.js'),'');
  const bin = join(root,'node_modules','eslint','bin');
  mkdirSync(bin,{recursive:true});
  writeFileSync(join(bin,'eslint.js'),`
    const filePath = process.argv.at(-1);
    console.log(JSON.stringify([{filePath,messages:[{severity:2,line:1,ruleId:'demo',message:'Failure'}]}]));
    process.exitCode = 1;
  `);
  const base = {cwd:nested,session_id:'nested'};
  const edit = call(root,['hook'],{...base,hook_event_name:'PostToolUse',tool_name:'Edit',tool_input:{file_path:'x.js'}});
  assert.match(edit.data.hookSpecificOutput.additionalContext,/"rule":"demo"/);
  const stop = call(root,['hook'],{...base,hook_event_name:'Stop'});
  assert.equal(stop.data.decision,'block');
  assert.deepEqual(call(root,['hook'],{...base,hook_event_name:'Stop',stop_hook_active:true}).data,{});
  const patch = {taskId:'nested',file:'src/x.js',rule:'demo'};
  assert.equal(call(root,['fix-attempt'],patch).data.status,'PASS');
  assert.match(call(root,['fix-verify'],patch).data.reason,/original finding persists/);
});

test('manual-only gate checks produce a Stop notice without extending the turn', t => {
  const root = project(t,{qualityGate:{required:['unit'],commands:{unit:[process.execPath,'--version']}}});
  writeFileSync(join(root,'a.md'),'example');
  const base = {cwd:root,session_id:'manual'};
  call(root,['hook'],{...base,hook_event_name:'PostToolUse',tool_name:'Write',tool_input:{file_path:'a.md'}});
  const stop = call(root,['hook'],{...base,hook_event_name:'Stop'});
  assert.equal(stop.data.decision,undefined);
  assert.match(stop.data.systemMessage,/unit BLOCKED/);
});

test('Codex patch events run lint, surface recurrence, and gate the changed turn', t => {
  const root = project(t,{
    qualityGate:{required:['lint','unit'],hookCommands:true,commands:{
      unit:[process.execPath,'-e','require("fs").writeFileSync("gate-ran","yes");process.exit(1)']
    }}
  });
  mkdirSync(join(root,'node_modules','eslint','bin'),{recursive:true});
  writeFileSync(join(root,'eslint.config.js'),'');
  writeFileSync(join(root,'a.js'),'bad');
  writeFileSync(join(root,'node_modules','eslint','bin','eslint.js'),`
    const filePath = process.argv.at(-1);
    console.log(JSON.stringify([{filePath,messages:[{severity:1,line:1,ruleId:'demo',message:'Warning'}]}]));
  `);
  const base = {cwd:root,session_id:'codex',turn_id:'first'};
  const patch = {...base,hook_event_name:'PostToolUse',tool_name:'apply_patch',
    tool_input:{command:'*** Begin Patch\n*** Update File: a.js\n@@\n-old\n+bad\n*** End Patch'}};
  const first = call(root,['hook'],patch);
  assert.match(first.data.hookSpecificOutput?.additionalContext ?? '', /"rule":"demo"/);
  assert.deepEqual(call(root,['hook'],{...base,turn_id:'unrelated',hook_event_name:'Stop'}).data,{});
  const stop = call(root,['hook'],{...base,hook_event_name:'Stop'});
  assert.equal(stop.data.decision,'block');
  assert.equal(readFileSync(join(root,'gate-ran'),'utf8'),'yes');
  assert.deepEqual(call(root,['proposals']).data,[]);
  const second = call(root,['hook'],{...patch,turn_id:'second'});
  assert.match(second.data.hookSpecificOutput.additionalContext, /"occurrences":2/);
  assert.equal(call(root,['proposals']).data.length,1);
});

test('Codex prompt hook surfaces pending versions and explicit versioned approval publishes memory', t => {
  const root = project(t);
  const id = 'no-old-api';
  const draft = {id,type:'lint',title:'Avoid old API',rootCause:'Recurring stale example',
    fix:'Use current API',matcher:{extensions:['.js'],literal:'oldApi()'}};
  const input = {cwd:root,session_id:'codex',turn_id:'approval',hook_event_name:'UserPromptSubmit',prompt:'I approve'};
  call(root,['propose'],draft);
  assert.deepEqual(call(root,['hook'],input).data,{});
  const fixtures = [{text:'oldApi()',matches:true},{text:'currentApi()',matches:false}];
  call(root,['validate-rule',id],fixtures);
  assert.match(call(root,['hook'],input).data.hookSpecificOutput.additionalContext,/"version":1/);
  assert.throws(() => readFileSync(join(root,'docs','agent-quality-rules.md')), {code:'ENOENT'});
  call(root,['propose'],draft);
  call(root,['validate-rule',id],fixtures);
  assert.equal(call(root,['approve-and-activate-rule',id],{version:1,approvedBy:'maintainer'}).status,1);
  const result = call(root,['approve-and-activate-rule',id],{version:2,approvedBy:'maintainer'});
  assert.equal(result.status,0,result.stderr);
  assert.equal(result.data.activeVersion,2);
  assert.deepEqual(call(root,['hook'],input).data,{});
  assert.match(readFileSync(join(root,'docs','agent-quality-rules.md'),'utf8'),/Version 2/);
});
