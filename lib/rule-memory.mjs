import { randomUUID } from 'node:crypto';
import { lstatSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

const start = '<!-- agent-quality:rules:start -->';
const end = '<!-- agent-quality:rules:end -->';

function localEntry(path, kind) {
  const stats = lstatSync(path, { throwIfNoEntry: false });
  if (stats && !(kind === 'directory' ? stats.isDirectory() : stats.isFile())) {
    throw new Error(`Expected a local ${kind}: ${path}`);
  }
  return stats;
}

function plain(value) {
  return value.replace(/\s+/gu, ' ').replace(/[\\`*_{}\[\]<>~|&!]/gu, '\\$&');
}

function example(label, text) {
  const longest = Math.max(2, ...Array.from(text.matchAll(/`+/g), match => match[0].length));
  const fence = '`'.repeat(longest + 1);
  const quoted = [fence, ...text.split(/\r\n?|\n/gu), fence].map(line => `> ${line}`);
  return [`**${label}**`, '', ...quoted].join('\n');
}

function renderRules(records, previous) {
  const sections = new Map();
  for (const match of previous.matchAll(/^<!-- agent-quality:rule:([a-z0-9-]+) -->\r?\n([\s\S]*?)^<!-- agent-quality:rule:end -->\r?$/gmu)) {
    sections.set(match[1], match[2].trimEnd());
  }
  for (const record of records) {
    sections.delete(record.id);
    const version = record.versions.find(item => item.version === record.activeVersion);
    if (!version?.approval || !version.validation?.passed) continue;
    const lines = [
      `### ${plain(version.title)}`,
      `Rule ID: \`${record.id}\` · Version ${version.version}`,
      `**Rule** ${plain(version.fix)}`,
      `**Reason** ${plain(version.rootCause)}`,
    ];
    const examples = version.validation.examples;
    if (examples) {
      lines.push(example(`Violation (${examples.violation.extension})`, examples.violation.text));
      lines.push(example(`Allowed (${examples.allowed.extension})`, examples.allowed.text));
    }
    sections.set(record.id, lines.join('\n\n'));
  }
  const entries = [...sections].sort(([a], [b]) => a.localeCompare(b)).map(([id, body]) =>
    `<!-- agent-quality:rule:${id} -->\n${body}\n<!-- agent-quality:rule:end -->`);
  return ['## Active learned rules', ...(entries.length ? entries : ['No active learned rules.'])].join('\n\n');
}

function document(path, body, initial = '') {
  const stats = localEntry(path, 'file');
  const previous = stats ? readFileSync(path, 'utf8') : null;
  const content = previous ?? initial;
  const eol = content.includes('\r\n') ? '\r\n' : '\n';
  const markers = [...content.matchAll(/^<!-- agent-quality:rules:(start|end) -->(?=\r?$)/gmu)];
  if (markers.length && (markers.length !== 2 || markers[0][1] !== 'start' || markers[1][1] !== 'end')) {
    throw new Error(`Invalid agent-quality section markers in ${path}`);
  }
  const managed = markers.length ? content.slice(markers[0].index + start.length, markers[1].index) : '';
  const block = [start, body(managed), end].join('\n').replace(/\r?\n/g, eol);
  const next = !markers.length
    ? content + (content ? (content.endsWith('\n') ? eol : eol + eol) : '') + block + eol
    : content.slice(0, markers[0].index) + block + content.slice(markers[1].index + end.length);
  return { path, previous, next, mode: stats?.mode };
}

function replace(path, content, mode) {
  if (content === null) {
    rmSync(path);
    return;
  }
  const temporary = join(dirname(path), `.agent-quality-${randomUUID()}.tmp`);
  try {
    writeFileSync(temporary, content, { flag: 'wx', mode });
    renameSync(temporary, path);
  } finally {
    rmSync(temporary, { force: true });
  }
}

export function syncRuleMemory(ctx, record, save) {
  const docs = join(ctx.root, 'docs');
  localEntry(docs, 'directory');
  const records = ctx.list('rules').filter(item => item.id !== record.id);
  records.push(record);
  const updates = [
    document(join(docs, 'agent-quality-rules.md'), previous => renderRules(records, previous), '# Agent quality rules\n'),
    document(join(ctx.root, 'AGENTS.md'),
      () => 'Read [the active project quality rules](docs/agent-quality-rules.md) before changing code.'),
  ];
  const written = [];
  try {
    mkdirSync(docs, { recursive: true });
    for (const update of updates) {
      if (update.next === update.previous) continue;
      replace(update.path, update.next, update.mode);
      written.push(update);
    }
    return save();
  } catch (error) {
    for (const update of written.reverse()) {
      replace(update.path, update.previous, update.mode);
    }
    throw error;
  }
}
