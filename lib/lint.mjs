import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, extname, join, relative } from 'node:path';
import { parseLint, parsePreview } from './lint-adapters.mjs';

const extensions = {
  '.ts': 'typescript', '.tsx': 'typescript', '.mts': 'typescript', '.cts': 'typescript',
  '.js': 'javascript', '.jsx': 'javascript', '.mjs': 'javascript', '.cjs': 'javascript',
  '.py': 'python', '.pyi': 'python', '.rs': 'rust', '.go': 'go', '.java': 'java', '.cs': 'csharp',
};
const eslintMarkers = [
  ...['js', 'mjs', 'cjs', 'ts', 'mts', 'cts'].map(ext => 'eslint.config.' + ext),
  '.eslintrc', '.eslintrc.js', '.eslintrc.cjs', '.eslintrc.json', '.eslintrc.yml', '.eslintrc.yaml',
];
const biomeMarkers = ['biome.json', 'biome.jsonc'];
const ruffMarkers = ['.ruff.toml', 'ruff.toml', 'pyproject.toml'];
const goMarkers = ['.golangci.yml', '.golangci.yaml', '.golangci.toml', '.golangci.json'];
const javaMarkers = ['config/checkstyle/checkstyle.xml', 'checkstyle.xml', 'config/checkstyle.xml'];
const cacheInputs = [
  ...eslintMarkers, ...biomeMarkers, ...ruffMarkers, '.eslintignore', '.editorconfig', '.gitignore',
  'package.json', 'package-lock.json', 'pnpm-lock.yaml', 'yarn.lock', 'bun.lock',
  'tsconfig.json', 'jsconfig.json', 'uv.lock', 'poetry.lock',
];
const excluded = new Set([
  '.git', '.claude', '.agent-quality', '.venv', '.ruff_cache', '__pycache__', 'node_modules',
  'vendor', 'target', 'dist', 'build', 'obj', 'coverage',
]);
const statusRank = ['SKIPPED', 'PASS', 'NOT_CONFIGURED', 'FAIL', 'BLOCKED'];
const MAX_DISCOVERY_ENTRIES = 100_000;

export function detectLanguage(file) {
  return extensions[extname(file).toLowerCase()] ?? null;
}

function ancestors(start, root) {
  const folders = [];
  for (let directory = start; ; directory = dirname(directory)) {
    folders.push(directory);
    if (directory === root) return folders;
    if (directory === dirname(directory)) throw new Error('Source file is outside the project');
  }
}

function findMarker(folders, names, isAccepted = () => true) {
  for (const folder of folders) {
    for (const name of names) {
      const file = join(folder, name);
      if (existsSync(file) && statSync(file).isFile() && isAccepted(file, name)) return { folder, file };
    }
  }
  return null;
}

function configured(file, key) {
  try { return Object.hasOwn(JSON.parse(readFileSync(file, 'utf8')), key); }
  catch { return false; }
}

function javascriptTarget(folders, settings) {
  const preferences = settings.jsTool ? [settings.jsTool] : ['eslint', 'biome'];
  const candidates = preferences.map(tool => {
    const marker = tool === 'eslint'
      ? findMarker(folders, [...eslintMarkers, 'package.json'],
        (path, name) => name !== 'package.json' || configured(path, 'eslintConfig'))
      : tool === 'biome' ? findMarker(folders, biomeMarkers) : null;
    if (!marker) return null;
    const script = tool === 'eslint' ? 'node_modules/eslint/bin/eslint.js' : 'node_modules/@biomejs/biome/bin/biome';
    const local = findMarker(folders, [script]);
    const flags = tool === 'eslint' ? ['--format', 'json'] : ['lint', '--reporter=json'];
    return {
      tool, cwd: marker.folder, command: local ? process.execPath : tool,
      args: local ? [local.file, ...flags] : flags, local: local?.file,
    };
  }).filter(Boolean);
  return candidates.sort((a, b) => folders.indexOf(a.cwd) - folders.indexOf(b.cwd) ||
    Number(Boolean(b.local)) - Number(Boolean(a.local)))[0] ?? null;
}

function targetFor(ctx, file) {
  const language = detectLanguage(file);
  const folders = ancestors(dirname(file), ctx.root);
  const settings = ctx.config.lint ?? {};
  if (language === 'typescript' || language === 'javascript') {
    return javascriptTarget(folders, settings);
  }
  if (language === 'python') {
    const marker = findMarker(folders, ruffMarkers, (path, name) =>
      name !== 'pyproject.toml' || /^\s*\[tool\.ruff(?:[.\]])/m.test(readFileSync(path, 'utf8')));
    if (!marker) return null;
    const location = process.platform === 'win32' ? '.venv/Scripts/ruff.exe' : '.venv/bin/ruff';
    const local = findMarker(folders, [location]);
    return {
      tool: 'ruff', cwd: marker.folder, command: local?.file ?? 'ruff', local: local?.file,
      args: ['check', '--no-fix', '--no-fix-only', '--force-exclude', '--output-format=json'],
    };
  }
  if (language === 'rust') {
    const marker = findMarker(folders, ['Cargo.toml']);
    return marker && {
      tool: 'clippy', command: 'cargo', cwd: marker.folder, mode: 'project',
      args: ['clippy', '--frozen', '--message-format=json'],
    };
  }
  if (language === 'go') {
    const module = findMarker(folders, ['go.mod']);
    if (!module) return null;
    const marker = findMarker(folders, goMarkers);
    return {
      tool: 'golangci-lint', command: 'golangci-lint', cwd: module.folder, mode: 'package',
      args: ['run', '--fix=false', ...(marker ? ['--config', marker.file] : []), '--output.json.path=stdout'],
      env: { GOPROXY: 'off', GOSUMDB: 'off', GOTOOLCHAIN: 'local' },
    };
  }
  if (language === 'java') {
    const marker = settings.checkstyleConfig
      ? { folder: ctx.root, file: ctx.resolveFile(settings.checkstyleConfig) }
      : findMarker(folders, javaMarkers);
    if (!marker) return null;
    const jar = settings.checkstyleJar ? ctx.resolveFile(settings.checkstyleJar) : null;
    return {
      tool: 'checkstyle', command: jar ? 'java' : 'checkstyle', cwd: marker.folder,
      args: [...(jar ? ['-jar', jar] : []), '-c', marker.file, '-f', 'sarif'],
      markers: [marker.file, ...(jar ? [jar] : [])],
    };
  }
  if (language === 'csharp') {
    const project = settings.roslynProject ? ctx.resolveFile(settings.roslynProject) : findCsProject(folders);
    return project && {
      tool: 'roslyn', command: 'dotnet', cwd: dirname(project), mode: 'project',
      args: ['build', project, '--no-restore', '--nologo', '--verbosity', 'quiet'],
      env: { DOTNET_CLI_WORKLOAD_UPDATE_NOTIFY_DISABLE: 'true', DOTNET_CLI_TELEMETRY_OPTOUT: 'true' },
    };
  }
  return null;
}

function findCsProject(folders) {
  for (const folder of folders) {
    const entries = readdirSync(folder, { withFileTypes: true });
    const projects = entries.filter(entry => entry.isFile() && entry.name.toLowerCase().endsWith('.csproj'));
    if (projects.length > 1) throw new Error('Set lint.roslynProject for a directory with multiple .csproj files');
    if (projects.length) return join(folder, projects[0].name);
  }
  return null;
}

function discover(root) {
  const found = [];
  const directories = [root];
  let scanned = 0;
  while (directories.length) {
    const directory = directories.pop();
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      if (++scanned > MAX_DISCOVERY_ENTRIES) throw new Error('Full lint discovery exceeded the workspace limit');
      if (entry.isDirectory() && !excluded.has(entry.name)) directories.push(join(directory, entry.name));
      if (entry.isFile() && detectLanguage(entry.name)) found.push(join(directory, entry.name));
    }
  }
  return found.sort();
}

function summarize(checks) {
  let status = 'SKIPPED';
  const diagnostics = new Map();
  for (const check of checks) {
    if (statusRank.indexOf(check.status) > statusRank.indexOf(status)) status = check.status;
    for (const issue of check.diagnostics ?? []) {
      const key = JSON.stringify([issue.file, issue.line, issue.rule, issue.message]);
      diagnostics.set(key, issue);
    }
  }
  return {
    status, diagnostics: [...diagnostics.values()], checks,
    durationMs: checks.reduce((total, check) => total + (check.durationMs ?? 0), 0),
  };
}

function unavailable(status, reason, file) {
  return { status, reason, file, diagnostics: [] };
}

function originFile(root, file) {
  return relative(root, file).split('\\').join('/');
}

function cacheKey(ctx, target, files) {
  const key = createHash('sha256');
  key.update(JSON.stringify([2, target.tool, target.command, target.args, process.env.PATH]));
  for (const file of files) {
    key.update(file).update('\0').update(readFileSync(file)).update('\0');
    for (const folder of ancestors(dirname(file), ctx.root)) {
      for (const name of cacheInputs) {
        const configFile = join(folder, name);
        if (!existsSync(configFile)) continue;
        const stat = statSync(configFile);
        if (stat.isFile()) key.update(configFile).update('\0').update(readFileSync(configFile)).update('\0');
      }
    }
  }
  for (const input of [target.local, ...(target.markers ?? [])].filter(Boolean)) {
    const stat = statSync(input);
    key.update(JSON.stringify([input, stat.mtimeMs, stat.size]));
  }
  return key.digest('hex');
}

function invocation(ctx, target, files, full) {
  const options = { cwd: target.cwd, timeoutMs: ctx.config.lint?.timeoutMs ?? 15_000, env: target.env };
  let paths = ['--', ...files];
  if (target.mode === 'project') paths = [];
  if (target.mode === 'package') {
    paths = full ? ['./...'] : [...new Set(files.map(file => {
      const directory = originFile(target.cwd, dirname(file));
      return directory ? './' + directory : '.';
    }))];
  }
  if (target.tool === 'checkstyle') paths = files;
  let result = ctx.run(target.command, [...target.args, ...paths], options);
  if (target.tool === 'golangci-lint' && /unknown flag: --output\.json\.path\b/i.test(result.stderr ?? '')) {
    result = ctx.run(target.command, [...target.args.slice(0, -1), '--out-format=json', ...paths], options);
  }
  return result;
}

function runGroup(ctx, target, files, full) {
  const result = invocation(ctx, target, files, full);
  const outcome = { tool: target.tool, scope: originFile(ctx.root, target.cwd) || '.', exitCode: result.exitCode,
    durationMs: result.durationMs ?? 0, diagnostics: [] };
  if (result.status === 'BLOCKED' || !Number.isInteger(result.exitCode)) {
    return { ...outcome, status: 'BLOCKED', reason: result.error ?? result.stderr ?? 'Tool unavailable' };
  }
  try {
    const diagnostics = parseLint(target.tool, result.stdout, target.cwd, ctx.root);
    const failed = diagnostics.some(issue => issue.severity === 'error') || result.exitCode !== 0;
    const toolFailed = result.exitCode !== 0 && (
      diagnostics.length === 0 || (['eslint', 'ruff'].includes(target.tool) && result.exitCode !== 1)
    );
    return {
      ...outcome, diagnostics, status: toolFailed ? 'BLOCKED' : failed ? 'FAIL' : 'PASS',
      ...(toolFailed && { reason: (result.stderr || result.stdout || 'Unexpected tool exit').slice(0, 600) }),
    };
  } catch {
    return { ...outcome, status: 'BLOCKED', reason: 'Invalid ' + target.tool + ' diagnostic report' +
      (result.stderr ? ': ' + result.stderr.slice(0, 400) : '') };
  }
}

function runIncremental(ctx, target, files) {
  const useCache = ctx.config.lint?.cache !== false && !target.mode;
  const key = useCache ? JSON.stringify([target.tool, files]) : null;
  const fingerprint = key && cacheKey(ctx, target, files);
  const cached = key && ctx.read('lint', key, null);
  if (cached && cached.fingerprint === fingerprint && Date.now() - cached.cachedAt < 60 * 60 * 1000) {
    return { ...cached.result, durationMs: 0, cached: true };
  }
  const result = runGroup(ctx, target, files, false);
  if (key && ['PASS', 'FAIL'].includes(result.status)) {
    ctx.write('lint', key, { result, fingerprint, cachedAt: Date.now() });
  }
  return result;
}

export function lint(ctx, files = []) {
  if (ctx.config.lint?.enabled === false) return summarize([unavailable('SKIPPED', 'Lint disabled')]);
  if (files.length && ctx.config.lint?.incremental === false) {
    return summarize([unavailable('SKIPPED', 'Incremental lint disabled')]);
  }
  const full = files.length === 0;
  const groups = new Map();
  const checks = [];
  let sources;
  try { sources = full ? discover(ctx.root) : files; }
  catch (error) { return summarize([unavailable('BLOCKED', error.message)]); }
  const missing = new Set();
  for (const input of new Set(sources)) {
    try {
      const file = ctx.resolveFile(input);
      const language = detectLanguage(file);
      if (!language) continue;
      const target = targetFor(ctx, file);
      if (!target) {
        if (!missing.has(language)) {
          checks.push(unavailable('NOT_CONFIGURED', 'No project linter configured for ' + language, originFile(ctx.root, file)));
          missing.add(language);
        }
        continue;
      }
      const key = JSON.stringify([target.tool, target.cwd, target.command, target.args]);
      if (!groups.has(key)) groups.set(key, { target, files: [] });
      groups.get(key).files.push(file);
    } catch (error) {
      checks.push(unavailable('BLOCKED', error.message, input));
    }
  }
  for (const { target, files: groupFiles } of groups.values()) {
    try {
      if (target.mode) {
        checks.push(runGroup(ctx, target, groupFiles, full));
        continue;
      }
      // Keep native invocation below the Windows command-line length limit, even for deep paths.
      for (let start = 0; start < groupFiles.length; start += 16) {
        const batch = groupFiles.slice(start, start + 16);
        checks.push(full ? runGroup(ctx, target, batch, true) : runIncremental(ctx, target, batch));
      }
    } catch (error) {
      checks.push(unavailable('BLOCKED', error.message));
    }
  }
  if (checks.length === 0) checks.push(unavailable('SKIPPED', 'No supported source files'));
  return summarize(checks);
}

export function previewFix(ctx, files = []) {
  if (ctx.config.autoFix?.enabled === false) return { status: 'SKIPPED', previews: [], reason: 'Auto fix disabled' };
  const previews = [];
  const checks = [];
  for (const input of new Set(files)) {
    try {
      const file = ctx.resolveFile(input);
      const target = targetFor(ctx, file);
      if (!target || !['eslint', 'ruff'].includes(target.tool)) continue;
      const args = target.tool === 'ruff'
        ? ['check', '--diff', '--no-unsafe-fixes', '--force-exclude', '--', file]
        : [...target.args, '--fix-dry-run', '--fix-type', 'layout', '--', file];
      const result = ctx.run(target.command, args, {
        cwd: target.cwd, timeoutMs: ctx.config.lint?.timeoutMs ?? 15_000,
      });
      if (result.status === 'BLOCKED' || ![0, 1].includes(result.exitCode)) {
        checks.push(unavailable('BLOCKED', result.error ?? result.stderr ?? 'Preview unavailable', input));
        continue;
      }
      for (const preview of parsePreview(target.tool, result.stdout, [file])) {
        previews.push({ ...preview, file: originFile(ctx.root, preview.file), tool: target.tool });
      }
    } catch (error) {
      checks.push(unavailable('BLOCKED', error.message, input));
    }
  }
  return {
    status: checks.length ? 'BLOCKED' : previews.length ? 'PASS' : 'SKIPPED',
    previews, checks,
  };
}
