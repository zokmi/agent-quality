import { readdirSync, readFileSync, realpathSync } from 'node:fs';
import path from 'node:path';

const sourceExtension = /\.(?:[cm]?[jt]s|[jt]sx)$/i;
const ignoredDirectories = new Set(['.git', '.agent-quality', 'node_modules', 'dist', 'build', 'vendor']);
const extensions = ['.ts', '.tsx', '.mts', '.cts', '.js', '.jsx', '.mjs', '.cjs'];

export function projectPath(root, file) {
  if (typeof file !== 'string' || !file || file.includes('\0')) {
    throw new Error('Expected a nonempty project path');
  }
  const relative = path.relative(root, path.resolve(root, file.replaceAll('\\', '/')));
  if (!relative || relative === '..' || relative.startsWith('..' + path.sep) || path.isAbsolute(relative)) {
    throw new Error('Path must refer to an entry inside the project: ' + file);
  }
  return relative.split(path.sep).join('/');
}

export function matchesPath(file, pattern) {
  if (typeof pattern !== 'string' || !pattern) {
    throw new Error('Expected a nonempty exact path or directory prefix');
  }
  const normalized = pattern.replaceAll('\\', '/');
  return normalized.endsWith('/') ? file.startsWith(normalized) : file === normalized;
}

function configuredGraph(root, spec = {}) {
  if (!spec || typeof spec !== 'object' || Array.isArray(spec)) {
    throw new Error('graph must be an object of project paths mapped to dependency arrays');
  }
  const graph = new Map();
  for (const [file, dependencies] of Object.entries(spec)) {
    if (!Array.isArray(dependencies)) throw new Error('Expected a dependency array for ' + file);
    graph.set(projectPath(root, file), dependencies.map((target) => ({
      target: projectPath(root, target),
      line: null,
    })));
  }
  return graph;
}

function* sourceFiles(ctx, directory) {
  const siblings = readdirSync(path.join(ctx.root, directory), { withFileTypes: true });
  for (const entry of siblings.sort((left, right) => left.name.localeCompare(right.name))) {
    const file = path.posix.join(directory, entry.name);
    if (entry.isDirectory() && !ignoredDirectories.has(entry.name)) {
      yield* sourceFiles(ctx, file);
    } else if (entry.isFile() && sourceExtension.test(entry.name)) {
      yield projectPath(ctx.root, ctx.resolveFile(file));
    }
  }
}

function resolveImport(ctx, file, specifier) {
  const target = path.posix.normalize(path.posix.join(path.posix.dirname(file), specifier));
  if (target.startsWith('../') || target === '..') return null;
  const substitute = { '.js': '.ts', '.jsx': '.tsx', '.mjs': '.mts', '.cjs': '.cts' };
  const extension = path.posix.extname(target);
  const alternate = substitute[extension];
  const candidates = extension
    ? [target, ...(alternate ? [target.slice(0, -extension.length) + alternate] : [])]
    : [target, ...extensions.flatMap((suffix) => [target + suffix, target + '/index' + suffix])];
  for (const candidate of candidates) {
    try {
      return projectPath(ctx.root, ctx.resolveFile(candidate));
    } catch {
      // The next extension or index candidate may exist.
    }
  }
  return null;
}

function imports(ctx, file) {
  const source = readFileSync(ctx.resolveFile(file), 'utf8');
  const tokens = /\/\*[\s\S]*?\*\/|\/\/[^\r\n]*|"(?:\\[\s\S]|[^"\\])*"|'(?:\\[\s\S]|[^'\\])*'|\x60(?:\\[\s\S]|[^\x60\\])*\x60|\b(?:import|export|from|require)\b|[;()=]|\S/g;
  const significant = [...source.matchAll(tokens)].filter(([token]) => !token.startsWith('//') && !token.startsWith('/*'));
  const dependencies = [];
  for (let index = 0; index < significant.length - 1; index += 1) {
    const [keyword] = significant[index];
    const previous = significant[index - 1]?.[0];
    const next = significant[index + 1][0];
    if (previous === '.' || !['import', 'from', 'require'].includes(keyword)) continue;
    if (keyword === 'require' && next !== '(') continue;
    const specifier = significant[index + (next === '(' ? 2 : 1)]?.[0];
    if (!specifier || !/^['"]\.\.?\//.test(specifier)) continue;
    const target = resolveImport(ctx, file, specifier.slice(1, -1));
    if (target) {
      const line = source.slice(0, significant[index].index).split('\n').length;
      dependencies.push({ target, line });
    }
  }
  return dependencies;
}

export function dependencyGraph(ctx, config) {
  const graph = configuredGraph(ctx.root, config?.graph);
  if (config?.scan !== undefined && !Array.isArray(config.scan)) throw new Error('scan must be an array');
  for (const directory of config?.scan ?? []) {
    const relative = directory === '.' ? '.' : projectPath(ctx.root, realpathSync(path.join(ctx.root, projectPath(ctx.root, directory))));
    for (const file of sourceFiles(ctx, relative)) {
      if (!graph.has(file)) graph.set(file, imports(ctx, file));
    }
  }
  return graph;
}

function reverseGraph(graph) {
  const reverse = new Map();
  for (const [from, edges] of graph) {
    if (!reverse.has(from)) reverse.set(from, []);
    for (const { target } of edges) {
      if (!reverse.has(target)) reverse.set(target, []);
      reverse.get(target).push(from);
    }
  }
  return reverse;
}

export function impactedFiles(graph, changed) {
  const reverse = reverseGraph(graph);
  const impacted = new Set(changed);
  for (const file of impacted) {
    for (const importer of reverse.get(file) ?? []) impacted.add(importer);
  }
  return impacted;
}

function cyclicComponents(graph) {
  const seen = new Set();
  const complete = [];
  for (const root of graph.keys()) {
    if (seen.has(root)) continue;
    seen.add(root);
    const stack = [{ file: root, edges: (graph.get(root) ?? []).values() }];
    while (stack.length) {
      const { file, edges } = stack.at(-1);
      const next = edges.next();
      if (next.done) {
        complete.push(file);
        stack.pop();
      } else if (!seen.has(next.value.target)) {
        const target = next.value.target;
        seen.add(target);
        stack.push({ file: target, edges: (graph.get(target) ?? []).values() });
      }
    }
  }
  const reverse = reverseGraph(graph);
  const visited = new Set();
  const cyclic = [];
  for (const file of complete.reverse()) {
    if (visited.has(file)) continue;
    const component = new Set([file]);
    for (const current of component) {
      visited.add(current);
      for (const parent of reverse.get(current) ?? []) {
        if (!visited.has(parent)) component.add(parent);
      }
    }
    if (component.size > 1 || graph.get(file)?.some(({ target }) => target === file)) {
      cyclic.push([...component].sort());
    }
  }
  return cyclic;
}

function diagnostic(severity, file, line, rule, message, evidence) {
  return { source: 'architecture', severity, file, line, rule, message, evidence };
}

export function architecture(ctx, files = []) {
  const config = ctx.config.architecture ?? {};
  const diagnostics = [];
  const exceptions = [];
  if (config.enabled === false) return { status: 'SKIPPED', diagnostics, exceptions };
  if (!config.graph && !config.scan?.length) return { status: 'NOT_CONFIGURED', diagnostics, exceptions };

  try {
    const graph = dependencyGraph(ctx, config);
    const changed = new Set(files.map((file) => projectPath(ctx.root, file)));
    const inScope = (from, to) => !changed.size || changed.has(from) || changed.has(to);
    const ignored = (rule, from, to) => {
      const exception = (config.exceptions ?? []).find((item) =>
        item.rule === rule && item.from === from && item.to === to && item.reason?.trim());
      if (exception && inScope(from, to)) exceptions.push({ rule, from, to, reason: exception.reason });
      return Boolean(exception);
    };
    const boundaries = config.boundaries ?? [];
    for (const { id, from, to, severity = 'error' } of boundaries) {
      if (typeof id !== 'string' || !id || id === 'circular-dependency'
          || !['error', 'warning'].includes(severity)) {
        throw new Error('Expected boundary id and severity of error or warning');
      }
      matchesPath('', from);
      matchesPath('', to);
    }

    for (const [file, edges] of graph) {
      for (const { target, line } of edges) {
        if (!inScope(file, target)) continue;
        for (const { id, from, to, severity = 'error' } of boundaries) {
          if (!matchesPath(file, from) || !matchesPath(target, to) || ignored(id, file, target)) continue;
          diagnostics.push(diagnostic(severity, file, line, id, 'Dependency violates a module boundary', file + ' -> ' + target));
        }
      }
    }
    if (config.cycles !== false) {
      const cycleGraph = new Map([...graph].map(([file, edges]) => [
        file, edges.filter(({ target }) => !ignored('circular-dependency', file, target)),
      ]));
      for (const component of cyclicComponents(cycleGraph)) {
        if (changed.size && !component.some((file) => changed.has(file))) continue;
        const file = component.find((candidate) => changed.has(candidate)) ?? component[0];
        diagnostics.push(diagnostic('error', file, null, 'circular-dependency',
          'Modules participate in a circular dependency', component.join(', ')));
      }
    }
    return { status: diagnostics.some(({ severity }) => severity === 'error') ? 'FAIL' : 'PASS', diagnostics, exceptions };
  } catch (error) {
    diagnostics.push(diagnostic('error', null, null, 'configuration', 'Architecture check could not run', error.message));
    return { status: 'BLOCKED', diagnostics, exceptions };
  }
}
