---
name: architecture-guard
description: Check configured dependency boundaries and cycles.
---

Run `node "${CLAUDE_PLUGIN_ROOT}/bin/quality.mjs" architecture --task ${CLAUDE_SESSION_ID} -- <changed-files>`. Omit paths for full verification. Separate warnings and exception records from error diagnostics. Ask for project-specific evidence before proposing additional boundaries. Use the architecture guide to configure the dependency graph and approved exceptions.
