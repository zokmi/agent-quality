---
name: rule-learning
description: Track recurring diagnostics and propose testable project rules.
---

Run the CLI yourself from the target project root using the absolute path to `bin/quality.mjs` in this skill's plugin. A Codex hook can supply the plugin root and recurring candidate signals. Run `proposals` to inspect the evidence. Use `collect --task <task-id>` for external type-check, review, test or BDD findings. Trace repeated issues to a concrete root cause and fix, then use `propose` and `validate-rule` as described in the learning guide. Compare the proposal with current project rules and fixtures for false positives.

For any executable learned rule, present the proposed rule ID and version, why it is needed, the recurring evidence, which files or patterns it affects, and the validation results to a human maintainer. Ask explicitly whether they approve that specific version. Keep the rule pending until they affirmatively approve it in their own message. A passing fixture, general permission to fix lint, a synthetic continuation prompt, or approval of an older version does not count. If the approver's identity is unknown, ask for the name to record.

After explicit approval, execute `approve-and-activate-rule <rule-id>` yourself, with `{"version": <approved-version>, "approvedBy": "<actual approver>"}` on standard input. The command rejects a stale version and synchronizes the project Markdown when activation succeeds. Report the active version and document path. Use `rollback-rule` or `deactivate-rule` to undo enforcement.
