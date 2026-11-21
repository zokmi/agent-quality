import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { architecture } from '../lib/architecture.mjs';
import { select } from '../lib/selection.mjs';

function fixture(t, config, files = {}, history = []) {
  const root = mkdtempSync(path.join(tmpdir(), 'agent-quality-architecture-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  for (const [file, source] of Object.entries(files)) {
    const target = path.join(root, file);
    mkdirSync(path.dirname(target), { recursive: true });
    writeFileSync(target, source);
  }
  return {
    root, config,
    resolveFile: (file) => realpathSync(path.join(root, file)),
    read: () => history,
  };
}

test('checks affected dependency edges, cycles, and documented exceptions', (t) => {
  const ctx = fixture(t, {
    architecture: {
      enabled: true,
      graph: {
        'domain/a.js': ['infra/b.js'],
        'infra/b.js': ['domain/a.js'],
        'domain/c.js': ['infra/d.js'],
      },
      boundaries: [{ id: 'domain-independent', from: 'domain/', to: 'infra/' }],
      exceptions: [{ rule: 'domain-independent', from: 'domain/a.js', to: 'infra/b.js', reason: 'Legacy adapter' }],
    },
  });
  const incremental = architecture(ctx, ['infra/b.js']);
  assert.equal(incremental.status, 'FAIL');
  assert.deepEqual(incremental.diagnostics.map(({ rule }) => rule), ['circular-dependency']);
  const full = architecture(ctx);
  assert.equal(full.diagnostics.length, 2);
  assert.equal(full.exceptions[0].reason, 'Legacy adapter');
});

test('resolves local TypeScript ESM imports and ignores commented imports', (t) => {
  const ctx = fixture(t, {
    architecture: {
      enabled: true,
      scan: ['src/'],
      boundaries: [{ id: 'isolated', from: 'src/domain/', to: 'src/infra/', severity: 'warning' }],
    },
  }, {
    'src/domain/a.ts': "/* import '../infra/ignored' */\nimport { value } from '../infra/b.js';",
    'src/infra/b.ts': 'export const value = 1;',
    'src/infra/ignored.ts': 'export {};',
  });
  const checked = architecture(ctx, ['src/infra/b.ts']);
  assert.equal(checked.status, 'PASS');
  assert.deepEqual(checked.diagnostics.map(({ file, line, severity }) => [file, line, severity]), [
    ['src/domain/a.ts', 2, 'warning'],
  ]);
});

test('selects transitive dependents and prior mapped failures', (t) => {
  const ctx = fixture(t, {
    testSelection: {
      graph: { 'core/a.ts': [], 'ui/b.ts': ['core/a.ts'], 'web/c.ts': ['ui/b.ts'] },
      mapping: [
        { paths: ['ui/', 'web/'], tests: ['web/c.test.ts'] },
        { paths: ['core/'], tests: ['core/a.test.ts'] },
      ],
    },
  }, {}, [{ test: 'web/c.test.ts' }]);
  const selected = select(ctx, ['core/a.ts']);
  assert.equal(selected.risk, 'medium');
  assert.deepEqual(selected.modules, ['core/a.ts', 'ui/b.ts', 'web/c.ts']);
  assert.deepEqual(selected.tests, ['web/c.test.ts', 'core/a.test.ts']);
  assert.ok(selected.checks.includes('review'));
});

test('escalates unmapped changes and allows explicit architecture opt-out', (t) => {
  const ctx = fixture(t, { architecture: { enabled: false } });
  assert.equal(architecture(ctx).status, 'SKIPPED');
  assert.equal(select(ctx, ['unknown.cs']).risk, 'high');
  assert.ok(select(ctx, ['unknown.cs']).checks.includes('bdd'));
});

test('requests the full suite when a known dependent has no test mapping', (t) => {
  const ctx = fixture(t, {
    testSelection: {
      graph: { 'src/core.ts': [], 'src/app.ts': ['src/core.ts'] },
      mapping: [{ paths: ['src/core.ts'], tests: ['test/core.ts'] }],
    },
  });
  assert.equal(select(ctx, ['src/core.ts']).fullSuite, true);
});

test('blocks invalid architecture configuration', (t) => {
  const ctx = fixture(t, {
    architecture: { graph: { '../outside.ts': [] } },
  });
  assert.equal(architecture(ctx).status, 'BLOCKED');
});
