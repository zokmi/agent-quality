---
name: rule-learning
description: Track recurring diagnostics and propose testable project rules.
---

Use `node "${CLAUDE_PLUGIN_ROOT}/bin/quality.mjs" proposals` to inspect recurrence candidates. Pipe a normalized diagnostics array to `node "${CLAUDE_PLUGIN_ROOT}/bin/quality.mjs" collect --task ${CLAUDE_SESSION_ID}` for external type-check, review, test or BDD findings. Trace repeated issues to a concrete root cause and fix, then use propose and validate-rule as described in the learning guide. Compare the proposal with current project rules and fixtures for false positives. Obtain explicit human approval before approve-rule and activate-rule. Use rollback-rule or deactivate-rule to undo enforcement.
