---
name: quality-report
description: Report actual task metrics and historical trends.
---

Run `node "${CLAUDE_PLUGIN_ROOT}/bin/quality.mjs" report --task ${CLAUDE_SESSION_ID} --markdown` for a task report. Omit the task ID for project history and omit --markdown for JSON. Report unavailable values explicitly. Use the same task ID when recording CLI checks.
