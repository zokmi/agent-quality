---
name: quality-gate
description: Run and interpret the required checks before reporting completion.
---

Run `node "${CLAUDE_PLUGIN_ROOT}/bin/quality.mjs" gate --task ${CLAUDE_SESSION_ID} -- <changed-files>`. Use --markdown for a report. When Superpowers review is required, invoke the review skill and supply the current result as {"review":{"skills":[...],"findings":[...]}} through stdin with --stdin. Run BDD via the project's loaded BDD plugin or its configured existing command. Treat only PASS for every required check as success. Report each unresolved check and retain evidence.
