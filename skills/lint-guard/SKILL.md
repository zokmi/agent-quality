---
name: lint-guard
description: Run incremental or full lint using the project's installed tools.
---

Run `node "${CLAUDE_PLUGIN_ROOT}/bin/quality.mjs" lint --task ${CLAUDE_SESSION_ID} -- <changed-files>` from the project root. Omit paths for a full scan. Read status and normalized diagnostics. For missing tooling, report the required existing tool. Preserve lint rules and dependencies. Hand actionable diagnostics to auto-fix.
