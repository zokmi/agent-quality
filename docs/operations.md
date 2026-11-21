# Operations and integrations

## Hook lifecycle

PostToolUse handles Write, Edit and MultiEdit. It validates the actual project file, records it for the session and returns a bounded diagnostic summary after lint. The nearest project configuration or Git worktree marker identifies the root. Supply Bash-created changes to the standalone CLI. Stop evaluates tracked files and requests one continuation for actionable automatic failures. It displays a notice for manual checks. `stop_hook_active` bounds the continuation. CI uses the standalone CLI for enforcement. Hooks run without new model sessions.

The gate recognizes `lint`, `format`, `typeCheck`, `unit`, `integration`, `review`, `bdd` and `architecture`. Set `qualityGate.required` for a reproducible policy. Otherwise selection derives required checks from change risk. The `qualityGate.commands` map accepts argument arrays. An exact `{tests}` argument expands into selected test identifiers. When selection calls for the full suite, use a command without this placeholder. Missing checks are NOT_CONFIGURED. Unavailable execution, timeouts and unusable targeted selections are BLOCKED.

## Superpowers

Use `/agent-quality:quality-review` in Claude Code. It inspects the currently loaded skills, invokes the available Superpowers review workflow through Claude's Skill tool and adapts structured findings. The CLI does not inspect private plugin storage or invoke a hidden Superpowers endpoint. Its input includes the namespaces observed by Claude and findings from the actual review. `review.fallback` accepts an argv array for an existing project check when the review skill is unavailable.

For a required review at the gate, pipe a current review result through `gate --stdin` as `{"review":{"skills":["superpowers:requesting-code-review"],"findings":[]}}`. An empty list represents a completed review with zero findings. CI can instead configure `qualityGate.commands.review` to validate the project's published review evidence.

## Lint adapters

| Language | Existing tools and configuration | Incremental scope |
| --- | --- | --- |
| JavaScript and TypeScript | ESLint or Biome, selected from nearby configuration and local installation. Set `lint.jsTool` to choose explicitly. | Files |
| Python | Ruff with project configuration and optional local virtual environment | Files |
| Rust | Clippy with an existing Cargo manifest and available offline dependencies | Cargo project |
| Go | golangci-lint with an existing Go module and offline dependencies | Packages |
| Java | SARIF-capable Checkstyle. Set `lint.checkstyleConfig` and optionally `lint.checkstyleJar`. | Files |
| C# | Roslyn through `dotnet build --no-restore`. Set `lint.roslynProject` if project selection is ambiguous. | C# project |

Set `lint.timeoutMs` per invocation and `lint.cache: false` when project tools depend on inputs that the fingerprint cannot observe. Engines are tested with simulated linter reports. Validate adapter compatibility with the actual versions used by each project.

## Existing BDD plugin

Keep the existing BDD plugin enabled. Invoke its documented skill for interactive BDD verification and preserve Gherkin features. Configure `qualityGate.commands.bdd` with the project's existing noninteractive BDD command or a project-owned verifier for BDD evidence. The verifier must exit nonzero when required scenarios lack fresh passing evidence. The plugin checks the command's exit status and leaves scenario execution to the existing tooling. A missing verifier produces NOT_CONFIGURED. Interactive failures can be submitted to `collect` as normalized diagnostics with source `bdd`.

## Automated fix workflow

`fix-preview` returns safe previews where an adapter supports them. The Claude skill reviews evidence and edits the project through the normal Edit tool. `fix-attempt` and `fix-verify` take JSON on standard input with `taskId`, `file` and `rule`. Register each attempt before applying the patch. Verification runs the configured gate for regression coverage. Use matching task IDs for reports.

## Troubleshooting and execution boundaries

- For missing skills, run the official plugin validator and verify the plugin is enabled in Claude Code.
- For a BLOCKED spawn, check PATH, the exit evidence and the timeout. Use direct executables. On Windows, a Node-based tool can be launched using `node` and its installed JavaScript entry point.
- Hook dispatch avoids shell interpolation of file names. The process runner uses argument arrays, validates working directories, limits output and runtime, and marks nested calls to prevent recursion.
- Treat the project and its tool configuration as executable inputs. Installed linters can load project code and plugins. Run this plugin only in projects whose tooling you trust. Custom gate commands run in the standalone CLI and require `qualityGate.hookCommands: true` for automatic execution.
- Put secrets outside diagnostics, fixtures and command output. State is project-local and uses atomic file replacement. Executable rules require passing fixtures and explicit approval before activation.
- A Node or Claude Code setup that lacks the documented hook form must be updated by the project owner before hook usage.

Official references for [plugin manifests](https://code.claude.com/docs/en/plugins-reference), [hooks](https://code.claude.com/docs/en/hooks), [skills](https://code.claude.com/docs/en/skills) and [subagents](https://code.claude.com/docs/en/sub-agents).

