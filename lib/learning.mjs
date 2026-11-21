import { createHash } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { extname, join, relative } from 'node:path';
import { syncRuleMemory } from './rule-memory.mjs';

const ruleTypes = new Set(['lint', 'architecture', 'guideline', 'regression-test', 'claude-rule', 'skill']);
const ruleIds = /^[a-z0-9][a-z0-9-]{0,63}$/;
const excludedDirectories = new Set(['.agent-quality', '.git', '.hg', '.venv', 'node_modules', 'vendor', 'dist', 'build', 'coverage', 'target']);

function hash(value) {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

function required(value, field, max = 2000) {
  if (typeof value !== 'string' || !value.trim() || value.length > max) {
    throw new Error(`Invalid ${field}`);
  }
  return value.trim();
}

function assertEnabled(ctx) {
  if (ctx.config.learning?.enabled === false) throw new Error('Rule learning is disabled');
}

export function collect(ctx, diagnostics, { taskId } = {}) {
  if (ctx.config.learning?.enabled === false || !taskId) return [];
  required(taskId, 'taskId', 256);
  const observations = new Map();
  for (const diagnostic of diagnostics) {
    if (!diagnostic.rule || diagnostic.severity === 'info' || diagnostic.source === 'learned-rule') continue;
    const signal = hash([diagnostic.source, diagnostic.rule]);
    const key = hash([taskId, signal]);
    const saved = observations.get(key) ?? ctx.read('observations', key, null);
    const observation = saved && (saved.diagnostic.severity === 'error' || diagnostic.severity !== 'error') ? saved : {
      taskId, signal, at: new Date().toISOString(),
      diagnostic: {
        source: diagnostic.source, severity: diagnostic.severity, rule: diagnostic.rule,
        file: diagnostic.file, line: diagnostic.line,
        message: String(diagnostic.message ?? '').slice(0, 1000),
        evidence: String(diagnostic.evidence ?? '').slice(0, 1000),
      },
    };
    if (saved !== observation) ctx.write('observations', key, observation);
    observations.set(key, observation);
  }
  return [...observations.values()];
}

export function proposals(ctx) {
  if (ctx.config.learning?.enabled === false) return [];
  const groups = new Map();
  for (const observation of ctx.list('observations')) {
    const group = groups.get(observation.signal) ?? [];
    group.push(observation);
    groups.set(observation.signal, group);
  }
  const threshold = Math.max(2, ctx.config.learning?.minimumOccurrences ?? 2);
  return [...groups.entries()].flatMap(([signal, evidence]) => {
    const occurrences = new Set(evidence.map(item => item.taskId)).size;
    if (occurrences < threshold) return [];
    const { source, rule } = evidence[0].diagnostic;
    return [{ signal, source, rule, occurrences, evidence: evidence.slice(-10) }];
  }).sort((a, b) => b.occurrences - a.occurrences || a.signal.localeCompare(b.signal));
}

function matcherFor(value) {
  if (value == null) return null;
  if (!Array.isArray(value.extensions) || !value.extensions.length || value.extensions.length > 20 ||
      value.extensions.some(extension => typeof extension !== 'string' || !/^\.[a-z\d]{1,12}$/i.test(extension))) {
    throw new Error('matcher.extensions must contain file extensions such as .js');
  }
  required(value.literal, 'matcher.literal', 240);
  return {
    extensions: [...new Set(value.extensions.map(extension => extension.toLowerCase()))].sort(),
    literal: value.literal,
  };
}

function ruleRecord(ctx, id) {
  assertEnabled(ctx);
  if (!ruleIds.test(id)) throw new Error('Invalid rule id');
  const rule = ctx.read('rules', id, null);
  if (!rule) throw new Error(`Unknown proposal: ${id}`);
  return rule;
}

function save(ctx, record) {
  ctx.write('rules', record.id, record);
  return record;
}

function assertNoConflict(ctx, id, matcher) {
  if (!matcher) return;
  const boundaries = ctx.config.architecture?.boundaries;
  if (id === 'circular-dependency' || (Array.isArray(boundaries) && boundaries.some(rule => rule?.id === id))) {
    throw new Error(`Rule id conflicts with architecture configuration: ${id}`);
  }
  for (const other of ctx.list('rules')) {
    if (other.id === id) continue;
    const active = other.versions.find(version => version.version === other.activeVersion);
    const existing = active?.matcher;
    if (existing?.literal === matcher.literal &&
        existing.extensions.some(extension => matcher.extensions.includes(extension))) {
      throw new Error(`Matcher duplicates active rule ${other.id}`);
    }
  }
}

export function propose(ctx, input) {
  assertEnabled(ctx);
  const id = required(input.id, 'id', 64);
  if (!ruleIds.test(id)) throw new Error('Invalid rule id');
  if (!ruleTypes.has(input.type)) throw new Error('Unknown rule type');
  const matcher = matcherFor(input.matcher);
  if (matcher && !['architecture', 'lint'].includes(input.type)) {
    throw new Error('Literal matchers are supported for architecture and lint rules');
  }
  assertNoConflict(ctx, id, matcher);
  const evidence = input.signal
    ? proposals(ctx).find(candidate => candidate.signal === input.signal)?.evidence
    : input.evidence ?? [];
  if (!Array.isArray(evidence)) throw new Error('Evidence signal has insufficient recurrence');
  if (JSON.stringify(evidence.slice(0, 10)).length > 30000) throw new Error('Proposal evidence is too large');
  const record = ctx.read('rules', id, { id, activeVersion: null, activationHistory: [], versions: [] });
  const entry = {
    version: record.versions.length + 1, type: input.type, matcher,
    title: required(input.title, 'title', 200),
    rootCause: required(input.rootCause, 'rootCause'),
    fix: required(input.fix, 'fix'),
    signal: input.signal ?? null,
    taskId: input.taskId == null ? null : required(input.taskId, 'taskId', 256),
    evidence: evidence.slice(0, 10),
    createdAt: new Date().toISOString(), validation: null, approval: null,
  };
  record.versions.push(entry);
  save(ctx, record);
  return {id,...entry};
}

function matches(matcher, text, extension) {
  return matcher.extensions.includes(extension) && text.includes(matcher.literal);
}

export function validate(ctx, id, fixtures) {
  const record = ruleRecord(ctx, id);
  const version = record.versions.at(-1);
  if (version.approval) throw new Error('Create a new version to change an approved rule');
  if (!version.matcher) throw new Error('This proposal needs project-specific validation and implementation');
  if (!Array.isArray(fixtures) || fixtures.length > 100 ||
      !fixtures.some(fixture => fixture?.matches === true) ||
      !fixtures.some(fixture => fixture?.matches === false)) {
    throw new Error('Supply both violation and false-positive fixtures');
  }
  assertNoConflict(ctx, id, version.matcher);
  const results = fixtures.map(fixture => {
    if (typeof fixture?.text !== 'string' || fixture.text.length > 65000 || typeof fixture.matches !== 'boolean') {
      throw new Error('Each fixture needs bounded text and a boolean matches');
    }
    const extension = fixture.extension ?? version.matcher.extensions[0];
    if (typeof extension !== 'string' || !/^\.[a-z\d]{1,12}$/i.test(extension)) {
      throw new Error('Fixture extension must be a file extension such as .js');
    }
    const actual = matches(version.matcher, fixture.text, extension.toLowerCase());
    return { expected: fixture.matches, actual, extension, fixtureHash: hash(fixture.text) };
  });
  version.validation = {
    passed: results.every(item => item.actual === item.expected),
    results, at: new Date().toISOString(),
  };
  if (version.validation.passed) {
    const approvedExample = expected => {
      const index = results.findIndex(item => item.expected === expected);
      return { extension: results[index].extension, text: fixtures[index].text };
    };
    version.validation.examples = { violation: approvedExample(true), allowed: approvedExample(false) };
  }
  save(ctx, record);
  return version.validation;
}

export function approve(ctx, id, { approvedBy } = {}) {
  const record = ruleRecord(ctx, id);
  const version = record.versions.at(-1);
  if (!version.validation?.passed) throw new Error('Successful validation is required before approval');
  if (version.approval) throw new Error('This version is already approved');
  version.approval = { by: required(approvedBy, 'approvedBy', 200), at: new Date().toISOString() };
  save(ctx, record);
  return version.approval;
}

function setActive(ctx, record, version, action) {
  record.activationHistory.push({
    action, previousVersion: record.activeVersion, version, at: new Date().toISOString(),
  });
  record.activeVersion = version;
  return syncRuleMemory(ctx, record, () => save(ctx, record));
}

export function activate(ctx, id) {
  const record = ruleRecord(ctx, id);
  const version = record.versions.at(-1);
  if (!version.approval || !version.validation?.passed) throw new Error('An approved, validated version is required');
  assertNoConflict(ctx, id, version.matcher);
  if (record.activeVersion === version.version) return syncRuleMemory(ctx, record, () => record);
  return setActive(ctx, record, version.version, 'activate');
}

export function deactivate(ctx, id) {
  const record = ruleRecord(ctx, id);
  if (record.activeVersion === null) return record;
  return setActive(ctx, record, null, 'deactivate');
}

export function rollback(ctx, id) {
  const record = ruleRecord(ctx, id);
  const prior = record.activationHistory.at(-1);
  if (!prior) throw new Error('No previous activation state');
  if (prior.previousVersion !== null) {
    const version = record.versions.find(item => item.version === prior.previousVersion);
    assertNoConflict(ctx, id, version.matcher);
  }
  return setActive(ctx, record, prior.previousVersion, 'rollback');
}

export function activeLearnedRules(ctx) {
  if (ctx.config.learning?.enabled === false) return [];
  return ctx.list('rules').flatMap(record => {
    const version = record.versions.find(item => item.version === record.activeVersion);
    return version?.matcher && version.approval && version.validation?.passed
      ? [{ id: record.id, ...version }] : [];
  });
}

function* projectFiles(directory, extensions) {
  const entries = readdirSync(directory, { withFileTypes: true });
  entries.sort((left, right) => left.name.localeCompare(right.name));
  for (const entry of entries) {
    const path = join(directory, entry.name);
    if (entry.isDirectory() && !excludedDirectories.has(entry.name)) {
      yield* projectFiles(path, extensions);
    } else if (entry.isFile() && extensions.has(extname(entry.name).toLowerCase())) {
      yield path;
    }
  }
}

export function learnedDiagnostics(ctx, files = []) {
  const rules = activeLearnedRules(ctx);
  if (!rules.length) return [];
  const extensions = new Set(rules.flatMap(rule => rule.matcher.extensions));
  const inputs = files.length ? new Set(files) : projectFiles(ctx.root, extensions);
  const diagnostics = [];
  for (const file of inputs) {
    const extension = extname(file).toLowerCase();
    const candidates = rules.filter(rule => rule.matcher.extensions.includes(extension));
    if (!candidates.length) continue;
    const absolute = ctx.resolveFile(file);
    const contents = readFileSync(absolute, 'utf8');
    for (const rule of candidates) {
      const index = contents.indexOf(rule.matcher.literal);
      if (index === -1) continue;
      diagnostics.push({
        source: 'learned-rule', severity: 'error', file: relative(ctx.root, absolute).replaceAll('\\', '/'),
        line: contents.slice(0, index).split('\n').length,
        rule: rule.id, message: rule.title, evidence: rule.matcher.literal,
      });
    }
  }
  return diagnostics;
}
