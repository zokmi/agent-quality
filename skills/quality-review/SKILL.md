---
name: quality-review
description: Use the loaded Superpowers review skill and normalize its findings.
---

Inspect the currently available Claude Code skills. If superpowers:requesting-code-review or superpowers:code-review is listed, invoke it using the Skill tool for the current changes. Pipe JSON with skills (an array of observed skill names) and findings into `node "${CLAUDE_PLUGIN_ROOT}/bin/quality.mjs" review --task ${CLAUDE_SESSION_ID}`. Each finding includes severity, file, line, rule, message and evidence. Supply an empty findings array only after a real clean review. If no skill is loaded, omit findings and let the CLI run the configured fallback or report NOT_CONFIGURED. Consult lint evidence before repeating equivalent findings. Record repeatable root causes for rule-learning.
