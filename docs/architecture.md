# Architecture checks and test selection

Define the dependency direction for your project's layers or modules in .agent-quality.json. The same dependency constraints work for layered, clean, and hexagonal architectures and modular monoliths. The project supplies the boundaries and decides which violations should fail.

~~~json
{
  "architecture": {
    "enabled": true,
    "cycles": true,
    "graph": {
      "src/domain/order.ts": [],
      "src/application/place-order.ts": ["src/domain/order.ts"],
      "src/adapters/api.ts": ["src/application/place-order.ts"]
    },
    "boundaries": [
      { "id": "domain-isolated", "from": "src/domain/", "to": "src/adapters/" },
      { "id": "application-isolated", "from": "src/application/", "to": "src/adapters/", "severity": "warning" }
    ],
    "exceptions": [
      {
        "rule": "domain-isolated",
        "from": "src/domain/legacy.ts",
        "to": "src/adapters/legacy.ts",
        "reason": "Legacy dependency retained until the migration ships."
      }
    ]
  },
  "testSelection": {
    "enabled": true,
    "mapping": [
      { "paths": ["src/domain/"], "tests": ["test/order.test.ts"] },
      { "paths": ["src/application/", "src/adapters/"], "tests": ["test/place-order.test.ts"] }
    ],
    "mediumRiskPaths": ["src/adapters/"],
    "highRiskPaths": ["src/adapters/auth.ts"]
  }
}
~~~

- A graph entry lists the project-relative files it imports. Include files with no imports as empty arrays. Supply a graph from the project's language-aware dependency tool for any language.
- For JS and TS, set architecture.scan to an array of project-relative directories to discover literal relative imports automatically. Set it to ["."] to scan from the project root. Explicit graph entries override scanned edges for the same files. Use an explicit graph for projects with aliases, computed imports, or compiler-specific resolution.
- Boundary and test mapping paths match a whole file or a directory prefix ending in /. Boundary rules prohibit edges from the first path to the second. error is the default severity. warning adds a diagnostic while permitting a pass.
- An exception matches an exact rule ID and directed edge and requires a reason. Use circular-dependency as the rule ID to exclude the specified edge from cycle validation. Reports include in-scope exceptions.
- Incremental validation checks boundary edges with a changed endpoint and cyclic components containing changed files. Cycle detection uses the full configured graph to preserve multi-hop cycles. Explicit scans read the configured directories to rebuild their portion of the graph.
- Test selection reuses the architecture graph unless testSelection defines its own graph or scan. It walks the reverse dependency graph, maps affected files to tests, and sorts previously failing tests first when failure records are available. Tests and module paths are relative to the project root.
- Low risk runs incremental lint and relevant unit tests. Medium risk adds type checking and review. High risk includes formatting, architecture, integration tests and BDD through the quality gate. If impact or mappings are incomplete, selection returns fullSuite true. The project's configured test command is responsible for running the broader suite.
