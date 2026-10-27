# SOXU

[简体中文](README.md) · **English**

> A lightweight cross-platform desktop workspace for Pi Agent, focused on projects, sessions, concurrent agents, resource efficiency, and reliable recovery.

**Status: in development; not released.** The repository contains a Tauri + Vue desktop project, Pi RPC supervisor and project/session catalog code, and a Node.js development Agent Loop. **The finished SOXU desktop product does not exist yet.** Historical ZIP labels (such as v1.3) identify bootstrap iterations, not released SOXU application versions.

## Local Agent Web dashboard

Run `pnpm agent:dashboard`, open `http://127.0.0.1:47321/`, and enter the ephemeral token
shown in the terminal. View checkpoint progress and bounded runner logs, or explicitly run,
stop, and resume Agent Loop tasks. The dashboard uses authenticated SSE for incremental coordinator logs and Developer/Reviewer activity, with a 15-second HTTP calibration fallback. Show the most recent 50 logs by default (configurable: 20/50/100/200), filter by source and toggle auto-follow. Activity shows only status, tool name and elapsed time—never prompts or raw model/tool content. After successful authentication, the token is held in per-tab `sessionStorage` so reloads reconnect automatically; restarting the dashboard requires a fresh token. No PiDeck dependency or external-process takeover.
See the [dashboard guide](docs/development/dashboard.md).

The dashboard can display associated PR and check status and lets the user explicitly trigger a merge. The dashboard supports V3 light and dark themes and the project roadmap (automatically updated from classified issues and GitHub status, without claiming milestone acceptance). A requirement can be assessed by a read-only Agent before the user confirms creation of a GitHub Issue and chooses whether dependencies are ready for execution. Requirements can be saved locally as drafts, edited and reordered. Each unknown must be answered with multiple choices or custom text before submitting; selected drafts submit in queue order. An uncertain submission stops the batch until the user checks GitHub and resolves it. Drafts and answers are stored in `.soxu/intake/`; do not enter secrets. The assessment enables Pi's read, grep, find, and ls tools; these are not restricted to the project directory and can read files accessible to the Pi process. Product and Quality dialogs support one-shot analysis, browsing report history, copying the full report or individual sections, and deleting reports. The monitor can copy the currently filtered logs, and analysis and assessment display elapsed time. Dashboard pages switch without reloading, and local model pools apply only to new tasks; resumed tasks retain their checkpointed selection.

## Product goals

SOXU is a new Rust + Tauri + Vue + TypeScript + Vite application. It draws inspiration from PiDeck's workflows without copying its implementation. The MVP aims to:

1. Manage multiple projects and Pi sessions, with at least two concurrently running, isolated Agent tasks.
2. Correctly stop and resume sessions and clean up all SOXU-managed Pi child processes on exit.
3. Index Pi JSONL sessions with bounded memory and render long conversations using virtualized views.
4. Prioritize Windows and incrementally validate macOS/Linux compatibility and measurable performance.

See the [product requirements](docs/product/prd.md) for acceptance criteria P-01 through P-08, scope, and milestones. **Never claim memory savings without comparable measurements.**

## Development tooling vs. shipped product

- **Pi Agent** powers autonomous coding/review and will be the Agent engine integrated into the product.
- **PiDeck** is a development-time conversation/monitoring tool, **not a runtime dependency** for SOXU users. Live attachment to Runner-owned Pi sessions has not been verified.
- **SOXU Agent Loop** is a Node.js orchestrator for Issue → Worktree → Pi → checks → independent Reviewer → PR → CI.
- **SOXU Desktop** is the work-in-progress Tauri + Vue application, launched separately with `pnpm tauri:dev`.

## Prerequisites

- Git, GitHub CLI (`gh`), Pi CLI, Rust/Cargo, Windows PowerShell, and the platform prerequisites for Tauri.
- **Node.js >=24** (the development machine already has Node 26).
- The owner-approved baseline uses **pnpm 12.15.0, Rust 1.99.1 / Edition 2024, Tauri 2, Vue 3.5.44, Vite 8.3.5, TypeScript 6.0.3, Pinia 4, and Vue Router 5**. See [the approved toolchain](docs/development/approved-toolchain.md). The repository contains `pnpm-lock.yaml` and `Cargo.lock`; installation and builds still need validation on the target environment.
- You must separately authorize Pi model providers/quotas; SOXU will not silently switch to a paid model.

```powershell
cd D:\Projects\SOXU   # Example path; adjust to your local checkout
node --version
pnpm --version
pi --version
pnpm install --frozen-lockfile # Install from the committed lockfile
node scripts/setup-git-hooks.mjs # Install commit hooks
pnpm agent:models      # Show model routing; no paid inference
pnpm agent:doctor      # Inspect tools, Git, and paused runs
```

## Updating existing task worktrees

Merging into `main` does not update existing task worktrees. Run `pnpm agent:worktrees` to inspect lag and `pnpm agent:worktrees -- --sync` to safely preserve task edits in a recovery stash, fast-forward eligible early-phase branches to latest main and reapply edits. For conflicts, `pnpm agent:resume` invokes the Developer to resolve them before checks and review. Stash backups are kept. See [Agent Loop guide](docs/development/agent-loop.md).

## Start and monitor autonomous development

```powershell
node scripts/init-git.mjs          # Safe no-op for existing repos
# First configure origin and main-branch protection, then once:
pnpm agent:seed
pnpm agent:status          # Offline local task/checkpoint snapshot (not live GitHub)
pnpm agent:once -- --dry-run        # Preview eligible tasks
pnpm agent:once                     # One controlled batch
pnpm agent:loop                     # Bounded development rounds
# pnpm agent:watch                  # Only on an authorized dedicated runner

pnpm agent:resume -- --dry-run      # Preview recovery
pnpm agent:resume                  # Resume paused runs
pnpm agent:say -- "继续 SOXU"         # Local natural-language recovery shortcut

pnpm tauri:dev                     # Launch desktop app separately
```

Use SOXU's local dashboard (`pnpm agent:dashboard`) for task status and explicit Agent Loop controls. GitHub Issues/PRs/Actions record collaboration progress; `.soxu/checkpoints/` stores recovery state. PiDeck remains optional for viewing archived Pi session history, not for coordinating SOXU's Agent Loop. See [Monitoring](docs/development/monitoring.md).

TASK frontmatter priorities and dependency IDs are now enforced. TASK-001/002 may run first; dependent tasks wait for a closed predecessor Issue **and a corresponding PR actually merged into `main`**. A legacy TASK-006 may still carry `agent:blocked` from the older seed; inspect before manually changing it to `agent:waiting`. Agent execution stops before paid calls when pnpm/Cargo lockfiles are absent, while `--dry-run` remains available. See [Task queue rules](tasks/README.md).

`agent:status` reports local backlog and checkpoints. The dashboard can also display GitHub task, PR and check status and offers an explicit merge action; remote status depends on GitHub connectivity and permissions. A separate `agent:logs` CLI is not implemented.

## Choose Developer and Reviewer models

The development orchestrator has separate **Developer** and **Reviewer** Pi processes. **Both are configured to use `magpie / auto/deepseek-v4.1-flash`**, with Pi-provided thinking settings. Check model availability and quota on your machine before enabling unattended inference.

```powershell
# The approved values are already committed; overrides are optional
# Optional explicit override; the approved defaults are already committed
$env:SOXU_DEVELOPER_PROVIDER = 'magpie'
$env:SOXU_DEVELOPER_MODEL = 'auto/deepseek-v4.1-flash'
pnpm agent:models
```

Permanent routing is defined in [`automation/agent-models.json`](automation/agent-models.json). **Do not store API keys in this file.** See the [model configuration guide](docs/development/models.md) for thinking levels, command precedence, and quota/retry policy.

## Three development, product, and quality lanes (opt-in)

The existing Issue → Worktree → Review → PR development lane remains unchanged. Product and Quality lanes run only when explicitly invoked, make a single **read-only, tool-free Pi analysis request**, and save unverified local proposals. They do not run background services, modify governance files, create Issues, merge, or release.

```powershell
pnpm agent:product -- --dry-run  # Offline preview; no model request
pnpm agent:quality -- --dry-run
pnpm agent:lessons -- --json    # Count distinct evidence dates
pnpm agent:product              # Explicit paid analysis call
pnpm agent:quality              # Explicit paid analysis call
```

Reports stay in git-ignored `.soxu/advisory/`. See [`LESSONS.md`](LESSONS.md) and [the three-lane design](docs/development/three-lane-agent-loop.md). Three distinct dates of corroborated recurrence merely qualify a lesson for **manual** policy-promotion review; protected policies never change automatically.

## Safety and acceptance gates

Each task uses its own Git Worktree. Developer agents cannot push, merge, tag, release, edit protected governance files, or access personal credentials. The Runner validates the same Git tree that was tested and reviewed; GitHub branch protection and checks control PR merging. Current policy disables automatic merging and release; the dashboard offers an explicit merge action. Quota failures, network failures, and timeouts pause instead of triggering unlimited paid retries.

Start with [`AGENTS.md`](AGENTS.md), then review the [Agent Loop guide](docs/development/agent-loop.md), [coding conventions](agents/policies/coding-standards.md), [testing/definition of done](agents/policies/testing.md), and [security rules](agents/policies/security.md).

**Security warning:** the Runner is not an OS sandbox. Use a dedicated low-privilege user or isolated development environment. The full Windows/Pi/GitHub integration and cross-platform package builds **have not been verified**; this is not a production-ready release.

## Desktop UI design

The owner has approved a **ChatGPT-inspired, conversation-first layout** without copying OpenAI branding, code, or assets. The desktop app has moved from a local interaction prototype to a **multi-session workspace**: projects and sessions come from the real Pi session index (read-only, never moving or deleting files), session tabs page through history, load full message text on demand, and stream Pi RPC output with cancel and stop; the inspector shows real runtime state and displays "unknown" when disconnected instead of fabricating data. Real WebView rendering, macOS/Linux runs, and the full set of real Pi events are still unverified. See the [UI baseline](docs/design/gpt-inspired-ui.md) and the [multi-session workspace notes](docs/development/multi-session-workspace.md).

## Dependency locks and CI gate

The repository includes `pnpm-lock.yaml` and `Cargo.lock`. Use `pnpm install --frozen-lockfile` and Cargo's `--locked` option to use the committed resolution. Update the relevant lockfile with dependency changes; committed lockfiles do not establish that target-platform builds or acceptance have passed. See the [approved toolchain](docs/development/approved-toolchain.md); its historical statement that lockfiles have not been generated is outdated.

## Repository layout

| Directory | Purpose |
| --- | --- |
| `apps/desktop/` | Tauri + Vue product skeleton |
| `crates/` | Rust runtime, session index, resource monitoring |
| `automation/loop/` | Agent development orchestration and offline tests |
| `agents/` + `AGENTS.md` | Roles, safeguards, policies, workflows |
| `docs/product/prd.md` | Product scope and measurable acceptance targets |
| `docs/development/models.md` | Model selection and budget rules |
| `docs/development/monitoring.md` | Progress through the local dashboard, pnpm, and GitHub |
| `docs/design/` | Approved UI/UX baseline and historical proposals |

## Approval and remaining prerequisites

The owner has approved the dependency version baseline, UI direction, and Developer/Reviewer model IDs. **Actual model provider access, account spending limits, target-platform build verification, and production signing/release permissions have not been verified or authorized.** The bootstrap is not a production release.

The repository `LICENSE` governs SOXU; third-party sources and dependencies retain their own licenses.

### SOXU brand assets

The approved mark is an interwoven cyan-to-blue S/X on a dark rounded square. `apps/desktop/assets/soxu-master.png` is the single high-resolution master; the web UI uses `apps/desktop/src/assets/soxu-{64,256}.png`. Do not use the old teal C-shaped placeholder or a plain letter S as the product mark. Tauri PNG/ICO/ICNS variants are not tracked in Git; regenerate them using `pnpm icons:generate`. `pnpm tauri:dev` and `pnpm tauri:build` generate them automatically. Run `pnpm icons:generate` before direct `cargo check/test`.
