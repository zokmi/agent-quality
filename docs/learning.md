# Rule learning and quality reports

Run these commands from the target project. Replace `/path/to/agent-quality` with the plugin directory. The same workflow is available in Claude Code through `/agent-quality:rule-learning` and `/agent-quality:quality-report`.

## Collect recurring evidence

Use the same task ID for repeated checks within a task. PostToolUse and Stop use the Claude Code session ID. CLI checks use `--task`.

```sh
node /path/to/agent-quality/bin/quality.mjs lint --task refactor-42 -- src/index.js
node /path/to/agent-quality/bin/quality.mjs collect --task verify-43 < diagnostics.json
node /path/to/agent-quality/bin/quality.mjs proposals
```

In PowerShell, pipe the file with `Get-Content -Raw diagnostics.json | node /path/to/agent-quality/bin/quality.mjs collect --task verify-43`. The same pattern works for the JSON inputs below.

The collector accepts an array of normalized diagnostics from lint, type checking, code review, tests, BDD or previous fixes. Each entry can include `source`, `severity`, `file`, `line`, `rule`, `message` and `evidence`. Keep the same source and rule ID across tasks for the same failure family. An error and its retries in one task count as one observation. The report marks a candidate after two distinct tasks by default. Set `learning.minimumOccurrences` to increase that threshold.

## Write and validate a proposal

Review candidate evidence, confirm the shared root cause and choose a minimal prevention strategy. Use this example as `proposal.json`:

```json
{
  "id": "no-legacy-adapter",
  "title": "Use the current adapter entry point",
  "type": "architecture",
  "taskId": "refactor-42",
  "rootCause": "New modules copied imports from a retired example.",
  "fix": "Use the current adapter entry point.",
  "evidence": ["src/index.js imported the retired module"],
  "matcher": {
    "extensions": [".js", ".ts"],
    "literal": "from './legacyAdapter'"
  }
}
```

Use `signal` from `proposals` in place of inline `evidence` to attach recurring observations automatically. Omitting `taskId` leaves a proposal in project-level reports only. Reusing the rule ID creates a separate version with its own validation and approval.

Save this input as `fixtures.json`. Include representative violations and examples that should remain valid.

```json
[
  {"extension": ".js", "text": "import adapter from './legacyAdapter'", "matches": true},
  {"extension": ".ts", "text": "import adapter from './currentAdapter'", "matches": false},
  {"extension": ".md", "text": "import adapter from './legacyAdapter'", "matches": false}
]
```

```sh
node /path/to/agent-quality/bin/quality.mjs propose < proposal.json
node /path/to/agent-quality/bin/quality.mjs validate-rule no-legacy-adapter < fixtures.json
```

Inspect the returned `passed` field and fixture outcomes. The matcher uses case-sensitive literal text, including comments and strings, within allowed extensions. Use a project linter or a tested dependency parser for syntax-sensitive rules. The engine rejects identical matchers with overlapping extensions when another rule is active and rejects IDs used by configured architecture boundaries. Compare other potential overlaps manually before approval.

Supported proposal types are `lint`, `architecture`, `guideline`, `regression-test`, `claude-rule` and `skill`. The built-in validator and activation apply to literal `lint` and `architecture` rules. Other proposal types record the evidence and intended fix for project-specific implementation and review.

## Approve, activate and roll back

After a human approves the validated version, save their recorded identity in `approval.json` as `{"approvedBy":"maintainer-name"}` and run:

```sh
node /path/to/agent-quality/bin/quality.mjs approve-rule no-legacy-adapter < approval.json
node /path/to/agent-quality/bin/quality.mjs activate-rule no-legacy-adapter
node /path/to/agent-quality/bin/quality.mjs architecture -- src/index.js
```

The approval field records an audit identity. The project filesystem controls who can modify that record. Approved, activated rules emit errors in architecture checks and in gates that require architecture. Use these commands to suspend enforcement or restore the previous active version:

```sh
node /path/to/agent-quality/bin/quality.mjs deactivate-rule no-legacy-adapter
node /path/to/agent-quality/bin/quality.mjs rollback-rule no-legacy-adapter
```

State lives in the target project's `.agent-quality/` directory. Preserve the directory if you want the historical evidence and activation log to survive a workspace reset. Set `learning.enabled: false` to suspend collection and learned-rule enforcement for the project.

## Read reports

```sh
node /path/to/agent-quality/bin/quality.mjs report --task refactor-42 --markdown
node /path/to/agent-quality/bin/quality.mjs report
```

The project report includes a chronological task series. Lint errors and review findings are deduplicated by task and diagnostic location. Error recurrence measures repeat source-and-rule observations across recorded tasks. Fix rates and average attempts use completed verification observations. Adoption measures proposal versions activated at least once. Duration comes from measured runs. Estimated tokens remain `null` in JSON and `unavailable` in Markdown when no token measurements were recorded. Set `metrics.enabled: false` to stop collecting new metrics.
