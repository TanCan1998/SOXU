# SOXU

[简体中文](README.md) · **English**

> A lightweight cross-platform desktop workspace for Pi Agent, focused on projects, sessions, concurrent agents, resource efficiency, and reliable recovery.

**Status: pre-launch / engineering prototype.** This repository contains an early Tauri + Vue desktop skeleton and a Node.js development Agent Loop. **The finished SOXU desktop product does not exist yet.** Historical ZIP labels (such as v1.3) identify bootstrap iterations, not released SOXU application versions.

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
- The owner-approved baseline uses **pnpm 12.15.0, Rust 1.99.1 / Edition 2024, Tauri 2, Vue 3.5.44, Vite 8.3.5, TypeScript 6.0.3, Pinia 4, and Vue Router 5**. See [the approved toolchain](docs/development/approved-toolchain.md). **Dependency lockfiles still need to be generated in an environment with network access and Rust/pnpm installed.**
- You must separately authorize Pi model providers/quotas; SOXU will not silently switch to a paid model.

```powershell
cd D:\Projects\SOXU   # Example path; adjust to your local checkout
node --version
pnpm --version
pi --version
pnpm install               # Resolves dependency graph and generates pnpm-lock.yaml
cargo generate-lockfile      # Generates Cargo.lock
pnpm agent:models      # Show model routing; no paid inference
pnpm agent:doctor      # Inspect tools, Git, and paused runs
```

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

Use PiDeck to interact with Pi sessions it owns, or run the Agent Loop from a PiDeck terminal to see its output. GitHub Issues/PRs/Actions record overall progress; `.soxu/checkpoints/` stores local diagnostic/recovery state. See [Monitoring](docs/development/monitoring.md).

TASK frontmatter priorities and dependency IDs are now enforced. TASK-001/002 may run first; dependent tasks wait for a closed predecessor Issue **and a corresponding PR actually merged into `main`**. A legacy TASK-006 may still carry `agent:blocked` from the older seed; inspect before manually changing it to `agent:waiting`. Agent execution stops before paid calls when pnpm/Cargo lockfiles are absent, while `--dry-run` remains available. See [Task queue rules](tasks/README.md).

`agent:status` is now available for **local-only, offline progress**; `agent:logs` and `agent:dashboard` are **planned but not implemented**.

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

## Safety and acceptance gates

Each task uses its own Git Worktree. Developer agents cannot push, merge, tag, release, edit protected governance files, or access personal credentials. The Runner validates the same Git tree that was tested and reviewed; GitHub branch protection/CI controls PR merging. Quota failures, network failures, and timeouts pause instead of triggering unlimited paid retries.

Start with [`AGENTS.md`](AGENTS.md), then review the [Agent Loop guide](docs/development/agent-loop.md), [coding conventions](agents/policies/coding-standards.md), [testing/definition of done](agents/policies/testing.md), and [security rules](agents/policies/security.md).

**Security warning:** the Runner is not an OS sandbox. Use a dedicated low-privilege user or isolated development environment. The full Windows/Pi/GitHub integration and cross-platform package builds **have not been verified**; this is not a production-ready release.

## Desktop UI design

The owner has approved a **ChatGPT-inspired, conversation-first layout** without copying OpenAI branding, code, or assets. The M0 interface now has a collapsible sidebar, chat composer, optional Agent inspector, light/dark themes, and keyboard shortcuts. This is a **local-only interaction prototype**: messages do not reach Pi and are not persisted, and the inspector does not pretend to show live Agent results. See the [UI baseline](docs/design/gpt-inspired-ui.md).

## Dependency locks and CI gate

Direct dependency versions are pinned, Node.js requires `>=24` (local Node 26 is supported). Because this build environment cannot reach npm/Cargo registries and lacks Rust, **`pnpm-lock.yaml` and `Cargo.lock` have not been generated**. On a prepared Windows machine, resolve and commit both, then run `pnpm install --frozen-lockfile`. CI intentionally fails without frozen lockfiles. See the [toolchain verification guide](docs/development/approved-toolchain.md).

## Repository layout

| Directory | Purpose |
| --- | --- |
| `apps/desktop/` | Tauri + Vue product skeleton |
| `crates/` | Rust runtime, session index, resource monitoring |
| `automation/loop/` | Agent development orchestration and offline tests |
| `agents/` + `AGENTS.md` | Roles, safeguards, policies, workflows |
| `docs/product/prd.md` | Product scope and measurable acceptance targets |
| `docs/development/models.md` | Model selection and budget rules |
| `docs/development/monitoring.md` | Progress through PiDeck, pnpm, and GitHub |
| `docs/design/` | Approved UI/UX baseline and historical proposals |

## Approval and remaining prerequisites

The owner has approved the dependency version baseline, UI direction, and Developer/Reviewer model IDs. **Actual model provider access, account spending limits, dependency lockfile generation, and production signing/release permissions have not been verified or authorized.** The bootstrap is not a production release.

The repository `LICENSE` governs SOXU; third-party sources and dependencies retain their own licenses.

### SOXU brand assets

The approved mark is an interwoven cyan-to-blue S/X on a dark rounded square. `apps/desktop/assets/soxu-master.png` is the single high-resolution master; the web UI uses `apps/desktop/src/assets/soxu-{64,256}.png`. Do not use the old teal C-shaped placeholder or a plain letter S as the product mark. Tauri PNG/ICO/ICNS variants are not tracked in Git; regenerate them using `pnpm icons:generate`. `pnpm tauri:dev` and `pnpm tauri:build` generate them automatically. Run `pnpm icons:generate` before direct `cargo check/test`.
