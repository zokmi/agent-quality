---
name: test-selector
description: Select relevant tests from changed files and project dependencies.
---

Run `node "${CLAUDE_PLUGIN_ROOT}/bin/quality.mjs" select -- <changed-files>`. Use the returned tests and checks. When fullSuite is true, use the configured full suite. For BDD verification, invoke the existing project's BDD plugin and preserve its Gherkin features. Use the quality gate for a reproducible completion decision.
