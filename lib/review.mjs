import {snippet, uniqueDiagnostics} from './core.mjs';

export function review(ctx, input={}) {
  const config = ctx.config.review;
  if (!config.enabled) return {status:'SKIPPED',diagnostics:[]};
  if (!Array.isArray(input.skills ?? []) || !Array.isArray(input.findings ?? [])) throw new Error('Expected skills and findings arrays');
  const skill = (input.skills ?? []).find(name => /^superpowers:(requesting-code-review|code-review)$/.test(name));
  if (config.provider === 'superpowers' && skill) {
    if (!input.findings) return {status:'BLOCKED',provider:skill,diagnostics:[],reason:'Invoke the discovered skill and submit its findings.'};
    const diagnostics = uniqueDiagnostics(input.findings.map(finding => ({
      source:'review', severity:['error','warning','info'].includes(finding.severity) ? finding.severity : 'warning',
      file:snippet(finding.file), line:Number.isSafeInteger(finding.line) && finding.line > 0 ? finding.line : null,
      rule:snippet(finding.rule,120),message:snippet(finding.message),evidence:snippet(finding.evidence)
    })));
    return {status:diagnostics.some(d => d.severity === 'error') ? 'FAIL' : 'PASS',provider:skill,diagnostics};
  }
  if (Array.isArray(config.fallback) && (!ctx.hook || ctx.config.qualityGate.hookCommands === true)) {
    const result = ctx.run(config.fallback[0],config.fallback.slice(1));
    return {status:result.status,provider:'configured command',diagnostics:[],reason:snippet(result.error || result.stderr || result.stdout)};
  }
  return {status:'NOT_CONFIGURED',diagnostics:[],reason:'No supported Superpowers review skill was reported and no enabled fallback was configured.'};
}

