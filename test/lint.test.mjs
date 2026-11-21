import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import test from 'node:test';
import { detectLanguage, lint, previewFix } from '../lib/lint.mjs';

function fixture(t, execute) {
  const root = mkdtempSync(join(tmpdir(), 'agent-quality-lint-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const state = new Map();
  const calls = [];
  return {
    root, calls, config: { lint: {}, autoFix: {} },
    add(file, contents = '') {
      const target = join(root, file);
      mkdirSync(dirname(target), { recursive: true });
      writeFileSync(target, contents);
      return target;
    },
    resolveFile: file => resolve(root, file),
    read: (category, key, fallback) => state.get(`${category}/${key}`) ?? fallback,
    write: (category, key, value) => state.set(`${category}/${key}`, value),
    run(command, args, options) {
      calls.push({ command, args, options });
      return execute?.(command, args, options) ?? {
        status: 'PASS', exitCode: 0, stdout: '[]', stderr: '', durationMs: 1,
      };
    },
  };
}

test('detects a supported language without considering directory names', () => {
  assert.deepEqual(['x.mts', 'x.cjs', 'x.rs', 'x.pyi', 'x.go', 'x.java', 'x.cs', 'x.txt'].map(detectLanguage),
    ['typescript', 'javascript', 'rust', 'python', 'go', 'java', 'csharp', null]);
});

test('runs local ESLint for a single source file and invalidates cache on changes', t => {
  const ctx = fixture(t, () => ({ status: 'FAIL', exitCode: 1, stdout: JSON.stringify([
    { filePath: join(ctx.root, 'pkg/a.ts'), messages: [{ ruleId: 'sample', severity: 2, line: 4, message: 'problem' }] },
  ]), stderr: '', durationMs: 2 }));
  ctx.add('pkg/eslint.config.mjs');
  ctx.add('node_modules/eslint/bin/eslint.js');
  ctx.add('pkg/a.ts', 'a');
  ctx.add('pkg/b.ts', 'b');
  const first = lint(ctx, ['pkg/a.ts']);
  assert.equal(first.status, 'FAIL');
  assert.deepEqual(first.diagnostics[0], {
    source: 'eslint', severity: 'error', file: 'pkg/a.ts', line: 4, rule: 'sample',
    message: 'problem', evidence: 'problem',
  });
  assert.equal(ctx.calls[0].options.cwd, join(ctx.root, 'pkg'));
  assert.equal(ctx.calls[0].command, process.execPath);
  assert.equal(ctx.calls[0].args.at(-1), join(ctx.root, 'pkg/a.ts'));
  assert.equal(lint(ctx, ['pkg/a.ts']).status, 'FAIL');
  assert.equal(ctx.calls.length, 1);
  ctx.add('pkg/eslint.config.mjs', 'new config');
  lint(ctx, ['pkg/a.ts']);
  assert.equal(ctx.calls.length, 2);
  ctx.add('pkg/a.ts', 'updated');
  lint(ctx, ['pkg/a.ts']);
  assert.equal(ctx.calls.length, 3);
});

test('discovers multiple package scopes for a full check', t => {
  const ctx = fixture(t);
  ctx.add('a/pyproject.toml', '[tool.ruff]');
  ctx.add('a/source.py');
  ctx.add('b/ruff.toml');
  ctx.add('b/source.py');
  const result = lint(ctx);
  assert.equal(result.status, 'PASS');
  assert.equal(result.durationMs, 2);
  assert.deepEqual(ctx.calls.map(call => call.options.cwd), [join(ctx.root, 'a'), join(ctx.root, 'b')]);
});

test('runs golangci-lint for the containing package with fixes and downloads disabled', t => {
  const ctx = fixture(t, (_command, args) => {
    if (args.includes('--output.json.path=stdout')) {
      return { status: 'FAIL', exitCode: 3, stdout: '', stderr: 'Error: unknown flag: --output.json.path' };
    }
    return { status: 'FAIL', exitCode: 1, stderr: '', stdout: JSON.stringify({
      Issues: [{ FromLinter: 'unused', Text: 'unused symbol', Pos: { Filename: 'pkg/source.go', Line: 7 } }],
    }) };
  });
  ctx.add('go.mod');
  ctx.add('pkg/source.go');
  const result = lint(ctx, ['pkg/source.go']);
  assert.equal(result.status, 'FAIL');
  assert.equal(result.diagnostics[0].line, 7);
  assert.equal(ctx.calls.length, 2);
  assert.equal(ctx.calls[1].args.at(-1), './pkg');
  assert.ok(ctx.calls[1].args.includes('--fix=false'));
  assert.equal(ctx.calls[1].options.env.GOPROXY, 'off');
});

test('keeps normal source directories in the full scan', t => {
  const ctx = fixture(t);
  ctx.add('ruff.toml');
  ctx.add('bin/source.py');
  assert.equal(lint(ctx).status, 'PASS');
  assert.equal(ctx.calls.length, 1);
});

test('distinguishes timeout, missing config and an invalid tool response', t => {
  const ctx = fixture(t, () => ({ status: 'BLOCKED', exitCode: null, stdout: '', stderr: '', error: 'timeout' }));
  ctx.add('a.py');
  assert.equal(lint(ctx, ['a.py']).status, 'NOT_CONFIGURED');
  ctx.add('ruff.toml');
  assert.equal(lint(ctx, ['a.py']).status, 'BLOCKED');
  const malformed = fixture(t, () => ({ status: 'PASS', exitCode: 0, stdout: '{}', stderr: '' }));
  malformed.add('ruff.toml');
  malformed.add('a.py');
  assert.equal(lint(malformed, ['a.py']).status, 'BLOCKED');
});

test('requests an explicitly safe Ruff patch preview and disables Ruff fixes during lint', t => {
  const ctx = fixture(t, (_command, args) => ({
    status: args.includes('--diff') ? 'FAIL' : 'PASS',
    exitCode: args.includes('--diff') ? 1 : 0,
    stdout: args.includes('--diff') ? '--- a.py\n+++ a.py\n@@ -1 +1 @@\n-x=1\n+x = 1\n' : '[]',
    stderr: '',
  }));
  ctx.add('ruff.toml');
  ctx.add('a.py');
  assert.equal(lint(ctx, ['a.py']).status, 'PASS');
  assert.ok(ctx.calls[0].args.includes('--no-fix'));
  const result = previewFix(ctx, ['a.py']);
  assert.equal(result.status, 'PASS');
  assert.ok(result.previews[0].patch.includes('+x = 1'));
  assert.ok(ctx.calls[1].args.includes('--no-unsafe-fixes'));
});
