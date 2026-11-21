---
name: quality-gate
description: Run and interpret the required checks before reporting completion.
---

Locate the absolute path to `bin/quality.mjs` in the installed plugin using this skill's location. Run `gate --task <task-id> -- <changed-files>` through that CLI from the target project root. Use --markdown for a report. When Superpowers review is required, invoke the review skill and supply the current result as {"review":{"skills":[...],"findings":[...]}} through stdin with --stdin. Run BDD via the project's loaded BDD plugin or its configured existing command. Treat only PASS for every required check as success. Report each unresolved check and retain evidence.
