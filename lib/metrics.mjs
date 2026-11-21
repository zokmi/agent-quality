import { randomUUID } from 'node:crypto';

const kinds = new Set(['lint', 'review', 'fix', 'validation', 'tokens']);
const nonnegative = value => typeof value === 'number' && Number.isFinite(value) && value >= 0;
const ratio = (numerator, denominator) => denominator > 0 ? numerator / denominator : null;
const markdownCell = value => String(value ?? 'unavailable').replace(/[|\r\n]/g, ' ').replaceAll('<', '&lt;');

function timedDuration(result) {
  if (nonnegative(result.durationMs)) return result.durationMs;
  const durations = Object.values(result.checks ?? {}).map(timedDuration).filter(nonnegative);
  return durations.length ? durations.reduce((sum, duration) => sum + duration, 0) : null;
}

function diagnosticsOf(event) {
  if (['lint', 'review'].includes(event.kind)) {
    return (event.diagnostics ?? []).map(finding => ({ ...finding, kind: event.kind }));
  }
  return ['lint', 'review'].flatMap(kind =>
    (event.checks?.[kind]?.diagnostics ?? []).map(finding => ({ ...finding, kind })));
}

export function recordMetrics(ctx, event) {
  if (ctx.config.metrics?.enabled === false || !event.taskId) return null;
  if (!kinds.has(event.kind) || typeof event.taskId !== 'string' || event.taskId.length > 256) {
    throw new Error('Invalid metrics event');
  }
  const saved = {
    at: new Date().toISOString(),
    taskId: event.taskId, kind: event.kind, status: event.status ?? null,
    operationId: typeof event.operationId === 'string' ? event.operationId.slice(0, 256) : null,
    attempts: Number.isInteger(event.attempts) && event.attempts > 0 ? event.attempts : null,
    durationMs: timedDuration(event),
    estimatedTokens: nonnegative(event.estimatedTokens) ? event.estimatedTokens : null,
    diagnostics: diagnosticsOf(event).map(({ kind, source, severity, file, line, column, rule, message }) =>
      ({ kind, source, severity, file, line, column, rule, message: String(message ?? '').slice(0, 500) })),
  };
  ctx.write('metrics', randomUUID(), saved);
  return saved;
}

function summarize(events, observations) {
  const lint = new Set();
  const review = new Set();
  const fixes = new Map();
  let validationDurationMs = 0;
  let measuredDurations = 0;
  const tokens = [];
  for (const event of events) {
    for (const finding of event.diagnostics) {
      const key = JSON.stringify([event.taskId, finding.source, finding.rule, finding.file, finding.line, finding.column, finding.message]);
      const kind = finding.kind ?? event.kind;
      if (kind === 'lint' && finding.severity === 'error') lint.add(key);
      if (kind === 'review') review.add(key);
    }
    if (event.kind === 'fix' && event.attempts !== null && ['PASS', 'FAIL'].includes(event.status)) {
      const key = event.operationId ? JSON.stringify([event.taskId, event.operationId]) : Symbol();
      const existing = fixes.get(key);
      if (!existing || (existing.status !== 'PASS' && (event.status === 'PASS' || event.attempts >= existing.attempts))) {
        fixes.set(key, event);
      }
    }
    if (['lint', 'validation', 'fix'].includes(event.kind) && event.durationMs !== null) {
      validationDurationMs += event.durationMs;
      measuredDurations++;
    }
    if (event.kind === 'tokens' && event.estimatedTokens !== null) tokens.push(event.estimatedTokens);
  }
  const errors = observations.filter(item => item.diagnostic.severity === 'error');
  const signals = new Set(errors.map(item => item.signal));
  const fixResults = [...fixes.values()];
  return {
    lintErrorCount: lint.size,
    errorRecurrenceRate: ratio(errors.length - signals.size, errors.length),
    autoFixSuccessRate: ratio(fixResults.filter(event => event.status === 'PASS').length, fixResults.length),
    averageFixAttempts: ratio(fixResults.reduce((sum, event) => sum + event.attempts, 0), fixResults.length),
    reviewFindings: review.size,
    validationDurationMs: measuredDurations ? validationDurationMs : null,
    estimatedTokenUsage: tokens.length ? tokens.reduce((sum, value) => sum + value, 0) : null,
    eventCount: events.length,
  };
}

export function qualityReport(ctx, { taskId, format = 'json' } = {}) {
  if (!['json', 'markdown'].includes(format)) throw new Error('Report format must be json or markdown');
  const scoped = item => !taskId || item.taskId === taskId;
  const events = ctx.list('metrics').filter(scoped);
  const observations = ctx.list('observations').filter(scoped);
  const rules = ctx.list('rules');
  const proposals = rules.flatMap(rule => rule.versions.filter(scoped).map(version => ({
    taskId: version.taskId, at: version.createdAt,
    activated: rule.activationHistory.some(entry => entry.action === 'activate' && entry.version === version.version),
  })));
  const tasks = new Map();
  for (const [key, entries] of Object.entries({ events, observations, proposals })) {
    for (const entry of entries) {
      if (!entry.taskId) continue;
      const task = tasks.get(entry.taskId) ?? { events: [], observations: [], proposals: [], firstSeen: entry.at };
      task[key].push(entry);
      if (entry.at < task.firstSeen) task.firstSeen = entry.at;
      tasks.set(entry.taskId, task);
    }
  }
  const ruleStats = versions => ({
    ruleProposalCount: versions.length,
    ruleAdoptionRate: ratio(versions.filter(version => version.activated).length, versions.length),
  });
  const report = {
    taskId: taskId ?? null,
    ...summarize(events, observations),
    ...ruleStats(proposals),
    trend: taskId ? [] : [...tasks.entries()]
      .sort(([leftId, left], [rightId, right]) => left.firstSeen.localeCompare(right.firstSeen) || leftId.localeCompare(rightId))
      .map(([id, task]) => ({ taskId: id, firstSeen: task.firstSeen, ...summarize(task.events, task.observations),
        ...ruleStats(task.proposals) })),
  };
  if (format === 'json') return report;
  const rows = Object.entries(report).filter(([key]) => key !== 'trend')
    .map(([key, value]) => `| ${key} | ${markdownCell(value)} |`);
  const trend = report.trend.map(item => `| ${markdownCell(item.taskId)} | ${item.lintErrorCount} | ${item.reviewFindings} | ${item.validationDurationMs ?? 'unavailable'} |`);
  return ['# Agent quality report', '', '| Metric | Value |', '| --- | --- |', ...rows,
    ...(trend.length ? ['', '## History', '', '| Task | Lint errors | Review findings | Validation time (ms) |',
      '| --- | --- | --- | --- |', ...trend] : []), ''].join('\n');
}
