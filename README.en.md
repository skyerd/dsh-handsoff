<div align="center">

<img src="https://raw.githubusercontent.com/skyerd/dsh-handsoff/main/docs/images/handsoff-avatar.png" width="140" alt="HandsOff — a session orchestration plugin for dsh"/>

# dsh-handsoff

[简体中文](https://github.com/skyerd/dsh-handsoff/blob/main/README.md) | **English**

![license](https://img.shields.io/badge/license-MIT-2631463) ![dsh](https://img.shields.io/badge/dsh-0.2.0--rc.2-2f6f4f) ![status](https://img.shields.io/badge/status-experimental-f0a441) ![i18n](https://img.shields.io/badge/i18n-%E4%B8%AD%E6%96%87%20%C2%B7%20English-4b6fff)

> Write the work up front as a task pipeline, hand it to AI: it queues, runs, watches and corrects itself — you just experience the result.

</div>

---

## What is this

**dsh-handsoff (plugin name HandsOff)** is a session orchestration plugin for [deepseek-harness](https://github.com/deepseek-ai/deepseek-harness) (dsh). It hands the "watching the AI work" part back to the AI:

- You agree on the **framework and task details up front** and write them as a task queue.
- The AI **orchestrates the project on its own**: tasks run in order, artifacts hand off across tasks.
- Built-in local rules **supervise every run**: high context pressure, long silence, abnormal cache hit rates — each is split, questioned or interrupted automatically.
- Humans do exactly one thing — **experience and feel the project**.

The plugin ships as two packages:

| Package | Path | Responsibility |
|---|---|---|
| `@deepseek-ai/dsh-session-orchestrator` | `packages/orchestrator/session-orchestrator` | Host side: durable task queues, run state machine, operations and handoff records, scheduler and supervisor |
| `@deepseek-ai/dsh-client-ui-settings-session-orchestrator` | `packages/client/ui-settings-session-orchestrator` | Client side: the "HandsOff" settings page — queues, board, automation, hosts |

## Why we built it

We want to **set ordinary programmers' hands free**.

In real projects the exhausting part is rarely writing code — it is supervising: checking whether the AI drifted, whether it will forget things as the context fills up, whether a stuck task should be retried. That work is mechanical, repetitive and draining, and it crowds out what a human should actually do: **decide what to build, then experience what was built**.

So we turned the supervisor into a plugin: stop staring at progress bars; agree on the framework and task details up front; let the AI orchestrate the schedule itself; and keep your energy for experiencing the result.

## What it does

- **Task queue**: create a pipeline with a name, a folder and an ordered list of prompts. Tasks run top-to-bottom, with an optional "run with previous item" for parallelism.
- **Four-stage template**: opt in via "More options" to generate Architecture → Breakdown → Implement → Test acceptance in one click; every stage prompt embeds your brief and reads the artifacts the previous stage left in `docs/pipeline`.
- **Parallel board**: every task under five fixed statuses (running / needs response / waiting / paused / ended), with one-click access to its conversation.
- **Automation (local rules, 0 tokens)**: context at 60% triggers a reorganization and re-queue; 20 minutes of silence triggers a progress question, then a pause; cache hit rate below 90% splits the remaining work, below 50% interrupts immediately; globally stop every queue when usable samples fall below 50%.
- **Supervision**: the default rule-based supervisor costs no tokens; an optional model-based supervisor bills its route and keeps a record of every inspection.
- **Revision fencing**: every write carries the revision it was loaded from (`expectedRevision`); conflicts are reported honestly and never overwrite your draft.
- **Hosts**: the DSH / WorkBuddy / Trae capability matrix is reported as-is — missing surfaces are shown as missing, never faked as success.

## Screenshots

**Create task queue** — write the prompts, press start:

<img src="https://raw.githubusercontent.com/skyerd/dsh-handsoff/main/docs/images/queue-create.png" width="820" alt="HandsOff queue creation"/>

**Automation** — four local rules watching every run:

<img src="https://raw.githubusercontent.com/skyerd/dsh-handsoff/main/docs/images/auto-handling.png" width="820" alt="HandsOff automation rules"/>

## Install

The plugin targets **deepseek-harness 0.2.0-rc.2** (upstream moves fast — re-check the patch against newer versions).

### Option A: one-command npm install (recommended)

Installers only download the runtime artifacts (`lib/`, `client.js` and the plugin manifest) — no sources, no build scripts:

```bash
dsh plugin --profile web add dsh-handsoff
```

Restart dsh web once after installing. Replace `--profile` with the profile you actually use.

> To try it out locally first: `dsh plugin --profile <name> add <path to this package>`.
> Compatibility: dsh 0.2.x (developed against 0.2.0-rc.2).

### Option B: overlay into a harness source build (contributors / local debugging)

Clone the repository only when you need to change plugin sources, then overlay both packages onto a harness checkout:

```bash
# 1. Get a matching upstream checkout
git clone https://github.com/deepseek-ai/deepseek-harness.git
cd deepseek-harness
git checkout <tag or commit for 0.2.0-rc.2>

# 2. Drop in the two plugin packages (keep the monorepo layout)
cp -r /path/to/dsh-handsoff/packages/orchestrator/session-orchestrator packages/orchestrator/
cp -r /path/to/dsh-handsoff/packages/client/ui-settings-session-orchestrator packages/client/

# 3. Apply the integration patch (registers the sessionOrchestrator Remote namespace and web-app composition)
git apply /path/to/dsh-handsoff/patches/harness-0.2.0-rc.2-integration.patch

# 4. Build
corepack enable
pnpm install
pnpm run build:web      # or pnpm run dev:web while iterating
```

> On Windows: copy the two folders with Explorer in step 2; if `git apply` fails in step 3, follow [docs/integration.md](https://github.com/skyerd/dsh-handsoff/blob/main/docs/integration.md) to edit the 4 upstream files by hand — each change is small.
> Clone and install are separate: end users install from npm; the source route is for development and contributions.

This repository follows the [DSH Plugin Hub](https://dsh-plugin.org) listing requirements: public repo, `dsh-plugin` topic, a copyable install command, and a standard `apply(ctx)` plugin form.

## Usage

1. Start your dsh (local web build or desktop) and open **Settings → HandsOff**.
2. In the **Create task queue** tab, click "New pipeline": name it, pick a workspace folder, write the task prompts. Model strategy defaults to "inherit system default" and skills to "keep current preset"; each task may pin its own model.
3. Press **Start**. Tasks enter their own sessions in order and the AI gets to work.
4. Switch to the **Running tasks** board: five statuses at a glance, "Open conversation" on any row.
5. The **Automation** tab shows rule-triggered records and supervisor costs; pause or resume automation there.
6. The **Hosts** tab reports the runtime capability matrix (model catalog, skills, permission presets, compaction).

> Queues, tasks and supervision records live in the local `session_orchestrator` storage domain and back up with your session data.

## ⚠️ Experimental

This project is **experimental**:

- The automation rules are **not guaranteed to be accurate**: they may split or stop runs wrongly, or miss failure modes entirely.
- The four-stage template produces a runnable starting point, not an acceptance-free deliverable — keep a human check on the critical nodes.
- Try it in low-risk workspaces first; keep manual pause and retry as your safety net on important projects.
- Upstream harness iterates quickly; the newer the version, the more likely the patch conflicts.

## Outlook

- [ ] **Fully hand over projects to AI**: from requirements to delivery, no more energy spent on basic coding and pipeline babysitting.
- [ ] **Specs and skills**: a detailed, AI-native project production standard and skill pack, so programming novices can safely turn ideas into projects.
- [x] **Standalone packaging**: the repo root installs as-is via one `dsh plugin add`.
- [ ] **Marketplace listing**: published to DSH Plugin Hub listing requirements, working toward verified.
- [ ] **More hosts**: deepen the WorkBuddy and Trae adapter surfaces.
- [ ] **Configurable supervision**: expose the built-in thresholds (60% / 20 min / 90% / 50%) as settings.

## Repository layout

```
dsh-handsoff/
├── package.json / cordis.patch.yml / client.js / lib/   # repo root = plugin package: npm ships runtime only (files whitelist); zero-build git install
├── packages/
│   ├── orchestrator/session-orchestrator/          # host: queues, scheduler, supervisor, handoff
│   │   ├── src/                                    #   34 source files (pipeline/scheduler/pressure/warden…)
│   │   └── tests/                                  #   33 test files incl. fault injection & integration
│   └── client/ui-settings-session-orchestrator/    # client: the "HandsOff" settings page
│       ├── src/client/                             #   four tabs, section components, zh/en copy
│       └── tests/client/                           #   component & service tests
├── scripts/                                        # standalone build + structural checks
├── patches/
│   └── harness-0.2.0-rc.2-integration.patch        # overlay route: integration diff against 4 upstream files
└── docs/
    ├── images/                                     # avatar & screenshots
    └── integration.md                              # manual integration guide
```

Tests run inside the harness workspace: after overlaying, run `pnpm run typecheck`, then run both packages' suites with the upstream vitest config.

### Maintainers: rebuilding the root bundle

`lib/` and `client.js` at the repo root are committed, so installs need no build. Rebuild only after changing either package's source:

```bash
npm install                 # build deps: esbuild, zod
npm run build:standalone    # regenerates lib/index.js, lib/host.js, client.js
npm run check:standalone    # structural + Remote coverage checks
```

`standalone/vendor/typert.remote-client.js` is emitted by the harness typert generator and is not committed. When missing, the script copies it from `packages/orchestrator/session-orchestrator/lib/` (in-place build) or from the workspace pointed to by `DSH_HARNESS_ROOT`.

### Maintainers: publishing to npm

The `files` whitelist in `package.json` ships runtime only: `lib/`, `client.js`, `cordis.patch.yml`, both READMEs and `LICENSE`. Sources, tests, `scripts/` and `docs/` never enter the tarball.

```bash
npm pack --dry-run    # inspect the tarball — whitelisted files only
npm version patch     # or minor / major
npm publish           # prepublishOnly rebuilds and runs the structural check
```

After publishing, installers run `dsh plugin --profile web add dsh-handsoff` — no clone required.

## Contributing

Issues and PRs are welcome — rule tuning, host adapters and translations are good starting points. Please run `pnpm run typecheck` and the relevant tests before submitting.

## License

[MIT](LICENSE) © skyerd and dsh-handsoff contributors

Upstream [deepseek-harness](https://github.com/deepseek-ai/deepseek-harness) is also MIT-licensed, Copyright (c) 2026 DeepSeek. The avatar is the project's own plugin artwork (cropped) and is used only as the project identity.
