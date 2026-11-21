---
name: auto-fix
description: Apply bounded, minimal fixes and verify regressions.
---

For each lint issue, identify the root cause and affected API. Run `node "${CLAUDE_PLUGIN_ROOT}/bin/quality.mjs" fix-preview -- <file>` to see available safe previews. Inspect the proposal and apply only the minimal relevant patch through Edit. Before each patch, pipe JSON with taskId, file and rule into `node "${CLAUDE_PLUGIN_ROOT}/bin/quality.mjs" fix-attempt`. A BLOCKED result ends attempts for that issue. Pipe the same JSON into `node "${CLAUDE_PLUGIN_ROOT}/bin/quality.mjs" fix-verify` after editing. Include review evidence when the gate requires it. Report remaining failures when the budget is exhausted. Preserve public APIs, enabled rules, existing code and unrelated files.
