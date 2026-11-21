import {snippet, uniqueDiagnostics} from './core.mjs';
import {lint} from './lint.mjs';
import {architecture} from './architecture.mjs';
import {select} from './selection.mjs';
import {activeLearnedRules,learnedDiagnostics} from './learning.mjs';
import {review} from './review.mjs';

const names = new Set(['lint','format','typeCheck','unit','integration','review','bdd','architecture']);

export function gate(ctx, files, input={}) {
  const started = Date.now();
  const config = ctx.config.qualityGate;
  if (!config.enabled) return {status:'SKIPPED',checks:{},diagnostics:[]};
  const plan = select(ctx,files);
  const existing = ctx.hook ? input.hookFiles ?? files : files;
  const required = config.required ?? plan.checks ?? ['lint','unit'];
  if (!Array.isArray(required) || required.length === 0 || required.some(name => !names.has(name))) {
    throw new Error('qualityGate.required must list recognized checks');
  }
  const hasRules = ctx.config.architecture.enabled && ctx.config.learning.enabled && activeLearnedRules(ctx).length > 0;
  const checks = {};
  for (const name of new Set(required)) {
    const command = config.commands?.[name];
    const features = {lint:'lint',architecture:'architecture',review:'review'};
    if (features[name] && ctx.config[features[name]].enabled === false) {
      checks[name] = {status:'SKIPPED',reason:'Feature disabled'};
      continue;
    }
    if (command !== undefined) {
      if (!Array.isArray(command) || !command.length || command.some(arg => typeof arg !== 'string')) {
        throw new Error('Expected an argv array for '+name);
      }
      if (ctx.hook && config.hookCommands !== true) {
        checks[name] = {status:'BLOCKED',manual:true,reason:'Configured command requires explicit hook opt-in. Run the gate directly.'};
      } else {
        const args = command.slice(1).flatMap(arg => arg === '{tests}' ? plan.tests ?? [] : [arg]);
        if (command.includes('{tests}') && (plan.fullSuite || !plan.tests?.length)) {
          checks[name] = {status:'BLOCKED',reason:'No reliable targeted test selection. Configure a full-suite command.'};
          continue;
        }
        const result = ctx.run(command[0],args,{timeoutMs:config.timeoutMs});
        checks[name] = {status:result.status,exitCode:result.exitCode,durationMs:result.durationMs,
          reason:snippet(result.error || result.stderr || result.stdout,900)};
        if (name === 'unit' && result.status === 'FAIL' && plan.tests?.length) {
          ctx.write('tests','failures',plan.tests.map(test => ({test})));
        }
      }
      continue;
    }
    if (name === 'lint') checks[name] = lint(ctx, (!ctx.hook && plan.risk === 'high') || !ctx.config.lint.incremental ? [] : existing);
    else if (name === 'architecture') {
      const checkedFiles = plan.risk === 'high' && !ctx.hook ? [] : files;
      const validation = architecture(ctx,checkedFiles);
      checks[name] = validation.status === 'NOT_CONFIGURED' && hasRules ? {...validation,status:'PASS'} : validation;
    } else if (name === 'review') {
      checks[name] = review(ctx,input.review ?? {});
      if (ctx.hook && checks[name].status === 'NOT_CONFIGURED') checks[name].manual = true;
    }
    else checks[name] = {status:'NOT_CONFIGURED',reason:'Configure an existing project check.'};
  }
  if (hasRules) {
    const diagnostics = learnedDiagnostics(ctx,plan.risk === 'high' && !ctx.hook ? [] : existing);
    checks.learnedRules = {status:diagnostics.some(d => d.severity === 'error') ? 'FAIL' : 'PASS',diagnostics};
  }
  const diagnostics = uniqueDiagnostics(Object.values(checks).flatMap(result => result.diagnostics ?? []));
  return {status:Object.values(checks).every(result => result.status === 'PASS') ? 'PASS' : 'FAIL',
    risk:plan.risk,checks,diagnostics,durationMs:Date.now()-started};
}
export function formatGate(result) {
  return ['# Quality gate — '+result.status,'',...Object.entries(result.checks).map(([name,check]) =>
    '- '+name+' — '+check.status+(check.reason ? ' · '+check.reason.split('\n')[0] : ''))].join('\n');
}

