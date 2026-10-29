---
description: "HandsOff settings page: queues and tasks, dependency order, parallel run board, pressure and handoff budgets, interventions, host capabilities, observable audit facts, and revision-fenced human controls."
kind: "package-reference"
---

# @deepseek-ai/dsh-client-ui-settings-session-orchestrator

English | [中文](README.zh.md)

## Summary

Open **Settings → HandsOff** to create and follow pipelines behind the generated `sessionOrchestrator` Remote namespace. **New pipeline** asks for a folder and a prompt, then creates one task and starts it; queue and task identities are generated in the client. The AI four-stage template stays behind **More options**. The page has six tabs: **Queues & tasks**, **Parallel board**, **Thresholds & budget**, **Handoff & audit**, **Interventions**, and **Hosts**. The live whole-orchestration snapshot arrives through `changed`; every editable draft is local and carries the revision it was loaded from. Every write therefore sends `expectedRevision`, and a conflict is reported without relabelling or overwriting the draft. The package name, plugin id, `settings.sessionOrchestrator` namespace and storage domain stay unchanged, so existing queues and intervention records keep opening under the HandsOff label.

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Further Exploration](#further-exploration)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)

-----

<a id="use-this-package"></a>
## Use this package

**New pipeline** collects a folder, an editable working directory, the prompt, and an optional name. Leaving the name empty derives one from the prompt's first line, and the form keeps its input in local storage until creation succeeds. **Create and start** reuses the existing `startQueue` control. The queue editor no longer exposes an ID, lifecycle, or run limit; those fields remain in storage for compatibility.

**Queues & tasks** selects a pipeline, edits its title, folder, brief, and default model route, and shows its tasks as a numbered ordered list. Drag a row, use the arrow buttons, or press **Insert below** to place a new task; **Copy** clones below the source and **Delete** removes a task behind an acknowledgement. Tasks run top to bottom by default; the only parallel option is **Run with previous item**, which joins the row above so both wait on the same preceding group. The editor stages prompt, workspace, working directory, priority, preset policy, the task's model route and handoff thresholds; task ids and dependency ids are never typed by the user. A task inherits the pipeline route unless it pins one, and the model selector is the native `session/modelCatalog` result rather than a hand-written provider list. The editor states that a model is fixed when the Session is created, so a running conversation keeps its model and the choice applies to the next attempt. Skills are not a separate per-task list: the editor names the session agent preset that composes them, or the host's disabled reason when no preset registry is mounted. The Host derives every dependency from list order and commits reorder, insert, copy and delete together, so a move or delete cannot leave a dependency naming an absent id. An invalid legacy dependency blocks **Start pipeline**, is listed inline with the exact task and dependency, and **Repair from list order** rewrites the stored dependencies without deleting tasks.

**Parallel board** lists every task as a full-width row under five fixed statuses: running, needs response, waiting to start, paused, and ended. The newest attempt supplies the row's status, model reading, latest activity, and **Open conversation** link on the stable `/session/<sessionId>` route; a task that has not started yet still appears under **Waiting to start**. Run, Session, operation, attempt, generation, pressure, and error identities stay behind **Details**.

**Thresholds & budget** edits the host scheduler's pause flag, global run limit, and provider quotas, shows the scheduler's current pause/resume control, and lists per-task handoff thresholds and budgets beside per-run pressure readings. A reading whose baseline is `estimated` is labelled **Estimated token baseline**; the handoff body token field is labelled as a limit, never an estimate.

**Handoff & audit** draws Session lineage and completed handoff generations without a body, and projects audit facts from the fields the Remote DTOs actually expose. Cancel, retry, and audited human skip are available beside each run; cancel is refused while a handoff is mid-transaction by the Host controller, and a skip requires both actor and reason. Every destructive path passes an acknowledgement checkbox, and a failure stays in the page's retained-failure list until dismissed.

**Interventions** shows the fixed instruction, its captured answer, child tasks, trigger signals, the judge, and the route that paid. **Hosts** shows one row per `HostSessionAdapter` capability, including the model catalog, skills, permissions and compaction: DSH supports them when the composition mounted the service; WorkBuddy supports create/send/subscribe/usage/model through its headless CLI while workspace listing, GUI opening, catalog listing, skill composition, permission presets and compaction are disabled with the missing surface; Trae reports every capability disabled because its launcher exposes no conversation API. Empty rows or missing hosts are never rendered as success.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

The Host half is an empty `apply`, present so the package owns a Loader row whose browser half is served from `./client`. The browser half injects `slots`, `locale`, and the generated `remote.sessionOrchestrator` namespace, then registers one `settings.section` entry with id `session-orchestrator`.

`OrchestratorClient` owns two separate snapshot sources from `@deepseek-ai/dsh-client-store`: `live` accepts whole `changed` frames and ignores a lower revision, while `drafts` holds queue/task/settings edits, loaded queue detail, the in-flight operation, and retained failures. A live frame never writes draft fields. Every mutation calls the Remote namespace with the revision its draft or live record carried and merges only the authoritative result; the stream remains the reconnect authority.

All copy is in the typed locale namespace `settings.sessionOrchestrator`. The page uses the shared `Button`, `Input`, `Switch`, `Checkbox`, `Tag`, `StateDot`, `SegmentedTabs`, and `RiskConfirmation` primitives, CSS Modules over `--dsw-*` semantic aliases, and no new UI library.

-----

<a id="further-exploration"></a>
## Further Exploration

- [ui-settings](../ui-settings/README.md) — the `settings.section` slot and the settings shell.
- [ui-settings-general](../ui-settings-general/README.md) — the section navigation the page appears in.
- [ui-primitives](../ui-primitives/README.md) — the controls and risk confirmation used here.

-----

<a id="model-experience"></a>
## Model Experience

None, as the package is a browser-side settings surface that registers no model surface.

#### KV Cache effect

None; this package neither assembles nor sends a provider request.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- **The current-workspace default is approximate.** The settings section receives the Workspace list but no active-workspace marker, so **New pipeline** seeds the folder and working directory from the first visible workspace. The user can change both before creating.
- **Manual creation is not one Host transaction.** The client composes the existing `createQueue` → `upsertTask` → `startQueue` calls. A failed task write deletes the just-created empty queue; a failed start leaves an idle pipeline that the user can start from the header.
- **Generated Remote artifact required.** The page injects `remote.sessionOrchestrator`, whose generated Host and Client contributions are build artifacts of `session-orchestrator`. A profile without the generated namespace and its controller leaves the plugin pending; the web-app row is disabled when `sessionOrchestratorController` is absent.
- **Session navigation is route-only.** The DTO carries a stable Session id, a same-origin `/session/<id>` route and an `openState`; the browser selects the conversation through `uiWorkspace.openSession`. A host that mounts no Web Session controller reports `unsupported`, and no title-matching fallback is invented.
- **Host rows are read-only reports.** The Hosts tab renders the capability matrix the runtime supplies. It cannot enable a capability the adapter reports as disabled, and the WorkBuddy/Trae rows do not add a second queue execution path.
- **Audit is a projection.** Actor and reason of a human skip never leave the Host. The audit table derives run timestamps, operation phase, last stable error, pressure reading, handoff generation, and the skipped bit; it is not a transition log.
- **No runtime invariant companion is published because the page owns no relationship that can diverge independently: the Host validates every write, and the live snapshot is the authority for every read.**
- **Full `apps/web` scaffold E2E is not wired here.** The Host controller's production composition and generated Remote artifacts remain outside this block. The devroot browser harness verifies the section, controls, and unload behavior through real Cordis, React, and Chromium.
