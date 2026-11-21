import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { collect, proposals, propose, validate, approve, activate, deactivate, rollback, learnedDiagnostics } from '../lib/learning.mjs';
import { qualityReport, recordMetrics } from '../lib/metrics.mjs';

function context() {
  const data = new Map();
  return {
    config: { learning: { enabled: true } },
    read: (category, key, fallback) => structuredClone(data.get(category)?.get(key) ?? fallback),
    write(category, key, value) {
      if (!data.has(category)) data.set(category, new Map());
      data.get(category).set(key, structuredClone(value));
    },
    list: category => [...(data.get(category)?.values() ?? [])].map(value => structuredClone(value)),
  };
}

const finding = { source: 'lint', severity: 'error', file: 'src/index.js', line: 4, rule: 'no-legacy', message: 'Legacy boundary', evidence: 'legacyAdapter' };
const rule = { id: 'no-legacy', title: 'Keep new adapters independent', type: 'architecture', rootCause: 'A retired dependency was copied into new modules', fix: 'Use current adapter', matcher: { extensions: ['.js'], literal: 'legacyAdapter' } };
const fixtures = [{ text: 'legacyAdapter()', matches: true }, { text: 'currentAdapter()', matches: false }];

test('learning requires distinct tasks and isolates project data', () => {
  const first = context();
  collect(first, [finding, finding], { taskId: 'a' });
  collect(first, [{ ...finding, line: 5 }], { taskId: 'a' });
  assert.deepEqual(proposals(first), []);
  collect(first, [finding], { taskId: 'b' });
  assert.equal(proposals(first)[0].occurrences, 2);
  assert.deepEqual(proposals(context()), []);
});

test('rule lifecycle rejects invalid transitions and supports versions and rollback', () => {
  const ctx = context();
  assert.equal(propose(ctx, rule).version, 1);
  assert.throws(() => approve(ctx, 'no-legacy', { approvedBy: 'maintainer' }));
  assert.equal(validate(ctx, 'no-legacy', [{ text: 'wrong', matches: true }, fixtures[1]]).passed, false);
  assert.throws(() => activate(ctx, 'no-legacy'));
  assert.equal(validate(ctx, 'no-legacy', fixtures).passed, true);
  assert.throws(() => approve(ctx, 'no-legacy', {}));
  approve(ctx, 'no-legacy', { approvedBy: 'maintainer' });
  assert.equal(activate(ctx, 'no-legacy').activeVersion, 1);
  assert.throws(() => propose(ctx, { ...rule, id: 'duplicate' }));
  assert.equal(propose(ctx, { ...rule, title: 'Updated title' }).version, 2);
  validate(ctx, 'no-legacy', fixtures);
  approve(ctx, 'no-legacy', { approvedBy: 'maintainer' });
  assert.equal(activate(ctx, 'no-legacy').activeVersion, 2);
  assert.equal(rollback(ctx, 'no-legacy').activeVersion, 1);
  assert.equal(deactivate(ctx, 'no-legacy').activeVersion, null);
});

test('reports aggregate only observed events and preserve unknowns', () => {
  const ctx = context();
  for (const taskId of ['a', 'b']) {
    collect(ctx, [finding], { taskId });
    recordMetrics(ctx, { taskId, kind: 'lint', diagnostics: [finding, finding], durationMs: 10 });
  }
  recordMetrics(ctx, { taskId: 'a', kind: 'fix', operationId: 'first', attempts: 1, status: 'FAIL' });
  recordMetrics(ctx, { taskId: 'a', kind: 'fix', operationId: 'first', attempts: 2, status: 'PASS' });
  recordMetrics(ctx, { taskId: 'b', kind: 'fix', attempts: 1, status: 'FAIL' });
  recordMetrics(ctx, { taskId: 'a', kind: 'validation', checks: { lint: { diagnostics: [finding], checks: [{ durationMs: 3 }] } } });
  const report = qualityReport(ctx);
  assert.equal(report.lintErrorCount, 2);
  assert.equal(report.errorRecurrenceRate, 0.5);
  assert.equal(report.autoFixSuccessRate, 0.5);
  assert.equal(report.averageFixAttempts, 1.5);
  assert.equal(report.validationDurationMs, 23);
  assert.equal(report.estimatedTokenUsage, null);
  assert.equal(qualityReport(ctx, { taskId: 'b' }).lintErrorCount, 1);
  assert.match(qualityReport(ctx, { format: 'markdown' }), /unavailable/);
});

test('CLI preserves the rule lifecycle across invocations and isolates different roots', t => {
  const root = mkdtempSync(join(tmpdir(), 'agent-quality-lifecycle-'));
  t.after(() => rmSync(root, { force: true, recursive: true }));
  const first = join(root, 'first');
  const second = join(root, 'second');
  mkdirSync(first);
  mkdirSync(second);
  writeFileSync(join(first, 'src.js'), 'legacyAdapter()');
  const cli = fileURLToPath(new URL('../bin/quality.mjs', import.meta.url));
  function run(args, input, cwd = first) {
    const result = spawnSync(process.execPath, [cli, ...args], {
      cwd, input: input == null ? '' : JSON.stringify(input), encoding: 'utf8', windowsHide: true,
    });
    assert.equal(result.status, 0, result.stderr);
    return JSON.parse(result.stdout);
  }
  run(['collect', '--task', 'test-a'], [finding]);
  run(['collect', '--task', 'test-b'], [finding]);
  const [candidate] = run(['proposals']);
  assert.equal(candidate.occurrences, 2);
  assert.deepEqual(run(['proposals'], null, second), []);
  assert.equal(run(['propose'], { ...rule, signal: candidate.signal }).evidence.length, 2);
  assert.equal(run(['validate-rule', 'no-legacy'], fixtures).passed, true);
  run(['approve-rule', 'no-legacy'], { approvedBy: 'maintainer' });
  assert.equal(run(['activate-rule', 'no-legacy']).activeVersion, 1);
  assert.equal(run(['architecture', '--', 'src.js']).status, 'FAIL');
  assert.equal(run(['report']).ruleAdoptionRate, 1);
  assert.equal(run(['rollback-rule', 'no-legacy']).activeVersion, null);
  assert.deepEqual(run(['architecture', '--', 'src.js']).diagnostics, []);
});

test('only active rules emit diagnostics from real project files', t => {
  const root = mkdtempSync(join(tmpdir(), 'agent-quality-learning-'));
  t.after(() => rmSync(root, { force: true, recursive: true }));
  writeFileSync(join(root, 'changed.JS'), 'currentAdapter()\nlegacyAdapter()');
  mkdirSync(join(root, 'node_modules'));
  writeFileSync(join(root, 'node_modules', 'ignored.js'), 'legacyAdapter()');
  const ctx = { ...context(), root, resolveFile: file => resolve(root, file) };
  ctx.config.architecture = { boundaries: [{ id: 'configured-boundary' }] };
  assert.throws(() => propose(ctx, { ...rule, id: 'configured-boundary' }), /conflicts/);
  propose(ctx, rule);
  validate(ctx, 'no-legacy', fixtures);
  approve(ctx, 'no-legacy', { approvedBy: 'maintainer' });
  assert.deepEqual(learnedDiagnostics(ctx, ['changed.JS']), []);
  activate(ctx, 'no-legacy');
  assert.deepEqual(learnedDiagnostics(ctx, ['changed.JS', 'ignored.py']), [{
    source: 'learned-rule', severity: 'error', file: 'changed.JS', line: 2,
    rule: 'no-legacy', message: rule.title, evidence: 'legacyAdapter',
  }]);
  assert.deepEqual(learnedDiagnostics(ctx), learnedDiagnostics(ctx, ['changed.JS']));
  deactivate(ctx, 'no-legacy');
  assert.deepEqual(learnedDiagnostics(ctx, ['changed.JS']), []);
});
