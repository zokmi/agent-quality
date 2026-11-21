import { dependencyGraph, impactedFiles, matchesPath, projectPath } from './architecture.mjs';

const checksByRisk = {
  low: ['lint', 'unit'],
  medium: ['lint', 'typeCheck', 'unit', 'review'],
  high: ['lint', 'format', 'typeCheck', 'unit', 'integration', 'review', 'bdd', 'architecture'],
};

function report(risk, modules, tests, reasons, fullSuite) {
  return { risk, modules: [...modules].sort(), tests, reasons, fullSuite, checks: [...checksByRisk[risk]] };
}

export function select(ctx, files = []) {
  const config = ctx.config.testSelection ?? {};
  const changed = new Set();
  try {
    for (const file of files) changed.add(projectPath(ctx.root, file));
    if (config.enabled === false || !changed.size) {
      return report('high', changed, [], [
        config.enabled === false ? 'Test selection disabled' : 'No changed files were available',
      ], true);
    }
    const architectureConfig = ctx.config.architecture;
    const graphConfig = config.graph || config.scan ? config
      : architectureConfig?.enabled === false ? {} : architectureConfig;
    const graph = dependencyGraph(ctx, graphConfig);
    const affected = impactedFiles(graph, changed);
    const tests = new Set();
    const covered = new Set();
    for (const entry of config.mapping ?? []) {
      if (!Array.isArray(entry.paths) || !Array.isArray(entry.tests) || !entry.tests.length) {
        throw new Error('Each test mapping needs paths and tests arrays');
      }
      for (const file of affected) {
        if (!entry.paths.some((pattern) => matchesPath(file, pattern))) continue;
        covered.add(file);
        for (const test of entry.tests) tests.add(projectPath(ctx.root, test));
      }
    }

    const unmapped = [...affected].filter((file) => !covered.has(file));
    const known = new Set(graph.keys());
    for (const dependencies of graph.values()) {
      for (const { target } of dependencies) known.add(target);
    }
    if (!graph.size || unmapped.length || !tests.size
        || [...changed].some((file) => !known.has(file))) {
      return report('high', affected, [], ['Dependency or test coverage could not be established for all affected files'], true);
    }
    const highRisk = (config.highRiskPaths ?? []).some((pattern) =>
      [...affected].some((file) => matchesPath(file, pattern)));
    const mediumRisk = (config.mediumRiskPaths ?? []).some((pattern) =>
      [...affected].some((file) => matchesPath(file, pattern)));
    const history = ctx.read?.('tests', 'failures', []) ?? [];
    const priorFailures = Array.isArray(history) ? new Set(history.map((entry) => entry.test)) : new Set();
    const prioritized = [...tests].sort((left, right) => Number(priorFailures.has(right)) - Number(priorFailures.has(left)));
    if (highRisk) return report('high', affected, prioritized, ['Affected files match a high-risk path'], false);
    if (affected.size > changed.size || mediumRisk || prioritized.some((test) => priorFailures.has(test))) {
      return report('medium', affected, prioritized, ['Dependent modules, a medium-risk path, or a previous failure requires additional validation'], false);
    }
    return report('low', affected, prioritized, ['Changed files have test mappings and no dependent modules'], false);
  } catch (error) {
    return report('high', changed, [], ['Test selection could not establish impact: ' + error.message], true);
  }
}
