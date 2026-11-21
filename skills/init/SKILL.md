---
name: init
description: Analyze a project after installation and create its agent-quality configuration.
---

Use this skill when the user wants to set up agent-quality in a project. Work from the target project root. Locate bin/quality.mjs inside the installed plugin, or use the absolute path to the plugin checkout, then run `node "<plugin-path>/bin/quality.mjs" init`. This creates .agent-quality.json using detected lint configuration and supported test commands. If the result is EXISTS, preserve the file and inspect its current settings. Review project manifests, CI workflows and testing scripts to identify any remaining configured checks. Add only commands verified against those files, preserving all user-written settings. Leave ambiguous checks and custom BDD or review integrations pending and explain what evidence is missing. Do not install dependencies or change project lint settings.
