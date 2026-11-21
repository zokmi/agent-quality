---
name: rule-learning
description: Track recurring diagnostics and propose testable project rules.
---

Use `node "${CLAUDE_PLUGIN_ROOT}/bin/quality.mjs" proposals` to inspect recurrence candidates. Pipe a normalized diagnostics array to `node "${CLAUDE_PLUGIN_ROOT}/bin/quality.mjs" collect --task ${CLAUDE_SESSION_ID}` for external type-check, review, test or BDD findings. Trace repeated issues to a concrete root cause and fix, then use `propose` and `validate-rule` as described in the learning guide. Compare the proposal with current project rules and fixtures for false positives.

For any new lint rule or lint rule revision produced by learning, present the proposed rule ID and version, why it is needed, the recurring evidence, which files or patterns it affects, and the validation results to a human maintainer. Ask explicitly whether they approve that specific version. Keep the rule pending until they affirmatively approve it. A passing fixture, general permission to fix lint, or approval of an older version does not count. After approval, record the actual approver with `approve-rule` and then run `activate-rule`. Existing lint checks continue normally while approval is pending.

Obtain explicit human approval for other executable learned rules before running `approve-rule` and `activate-rule`. Use `rollback-rule` or `deactivate-rule` to undo enforcement.
