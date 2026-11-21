import { readFileSync } from 'node:fs';
import { isAbsolute, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

function array(value, tool) {
  if (!Array.isArray(value)) throw new Error('Unexpected ' + tool + ' report format');
  return value;
}

function report(source, file, line, rule, message, severity = 'error') {
  return {
    source, severity, file: file || null, line: Number(line) || null,
    rule: rule || 'unknown', message: String(message ?? rule ?? 'Lint diagnostic'),
    evidence: String(message ?? ''),
  };
}

function json(text) {
  return JSON.parse(text.replace(/^\uFEFF/, ''));
}

function biomeFile(resource) {
  if (typeof resource === 'string') return resource;
  return resource?.file ?? (resource?.type === 'file' ? resource.data : null);
}

function biomeLine(location) {
  if (!Array.isArray(location?.span) || !Number.isInteger(location.span[0])) return null;
  const source = typeof location.sourceCode === 'string' ? Buffer.from(location.sourceCode) : null;
  return source ? source.subarray(0, location.span[0]).toString().split('\n').length : null;
}

const parsers = {
  eslint(text) {
    return array(json(text), 'ESLint').flatMap(file => array(file.messages, 'ESLint').map(issue =>
      report('eslint', file.filePath, issue.line, issue.ruleId ?? (issue.fatal ? 'parse' : 'configuration'),
        issue.message, issue.severity === 2 ? 'error' : 'warning')));
  },
  biome(text) {
    return array(json(text).diagnostics, 'Biome').map(issue => {
      const location = issue.location;
      const file = biomeFile(location?.path ?? issue.file_path);
      const message = issue.description ?? (typeof issue.message === 'string' ? issue.message : null);
      return report('biome', file, biomeLine(location), issue.category, message,
        issue.severity === 'error' || issue.severity === 'fatal' ? 'error' : 'warning');
    });
  },
  ruff(text) {
    return array(json(text), 'Ruff').map(issue =>
      report('ruff', issue.filename, issue.location?.row, issue.code, issue.message));
  },
  clippy(text) {
    return text.split(/\r?\n/).filter(Boolean).map(json)
      .filter(item => item.reason === 'compiler-message' && ['warning', 'error'].includes(item.message.level))
      .map(({ message }) => {
        const span = message.spans.find(item => item.is_primary) ?? message.spans[0];
        return report('clippy', span?.file_name, span?.line_start, message.code?.code, message.message, message.level);
      });
  },
  'golangci-lint'(text) {
    const issues = json(text).Issues;
    return (issues === null ? [] : array(issues, 'golangci-lint')).map(issue =>
      report('golangci-lint', issue.Pos?.Filename, issue.Pos?.Line, issue.FromLinter, issue.Text,
        issue.Severity === 'warning' ? 'warning' : 'error'));
  },
  checkstyle(text) {
    return array(json(text).runs, 'Checkstyle').flatMap(run =>
      array(run.results ?? [], 'Checkstyle').map(issue => {
        const location = issue.locations?.[0]?.physicalLocation;
        const uri = location?.artifactLocation?.uri;
        let file = uri;
        if (typeof uri === 'string') {
          try { file = uri.startsWith('file:') ? fileURLToPath(uri) : decodeURI(uri); }
          catch { /* preserve the reported URI */ }
        }
        return report('checkstyle', file, location?.region?.startLine, issue.ruleId, issue.message?.text,
          issue.level === 'error' ? 'error' : 'warning');
      }));
  },
  roslyn(text) {
    return text.split(/\r?\n/).map(line => line.match(/^(.*?)\((\d+),\d+\)\s*:\s*(error|warning)\s+(\S+):\s*(.+?)(?:\s+\[[^\]]+\])?\s*$/i))
      .filter(Boolean).map(([, file, line, severity, rule, message]) =>
        report('roslyn', file.trim(), line, rule, message, severity.toLowerCase()));
  },
};

export function parseLint(tool, stdout, cwd, root) {
  const findings = parsers[tool](stdout ?? '').map(issue => ({
    ...issue,
    file: issue.file && relative(root, resolve(cwd, issue.file)).split('\\').join('/'),
  }));
  return findings.map(issue => ({
    ...issue,
    file: !issue.file || isAbsolute(issue.file) || issue.file === '..' || issue.file.startsWith('../')
      ? null : issue.file,
  }));
}

export function parsePreview(tool, stdout, files) {
  if (tool === 'ruff') return stdout.trim() ? [{ file: files[0], patch: stdout }] : [];
  return array(json(stdout), 'ESLint').filter(result =>
    result.filePath === files[0] && typeof result.output === 'string' &&
    result.output !== readFileSync(files[0], 'utf8')).map(result =>
    ({ file: files[0], replacement: result.output }));
}
