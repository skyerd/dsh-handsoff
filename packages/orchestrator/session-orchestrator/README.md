---
description: "Durable session orchestration for the DeepSeek Harness: task queues, run state, operation reconciliation and handoff records behind ctx.sessionOrchestrator."
kind: "package-reference"
---

# @deepseek-ai/dsh-session-orchestrator

English | [中文](README.zh.md)

## Summary

Use this package to keep durable orchestration state — queues, task specifications, run records, operation reconciliation and handoff lineage — for a host that runs many agent sessions on a schedule. The records live in the `session_orchestrator` storage domain, so they survive a restart and are validated against zod schemas at open. The package registers no model tools and appends no session events; its scheduler, supervisor and handoff manager call no model. The one opt-in exception is the model warden: an explicitly configured provider and model review running tasks, and the default rule warden still spends nothing.

The settings page presents this package as **HandsOff**. The package name, plugin ids, `settings.sessionOrchestrator` namespace and `session_orchestrator` storage domain stay unchanged so an existing queue and intervention ledger keep opening.

## Table of Contents

- [Use this package](#use-this-package)
- [Deployment and operations](#deployment-and-operations)
- [Understand the implementation](#understand-the-implementation)
- [Further Exploration](#further-exploration)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

<a id="use-this-package"></a>
## Use this package

The package is a Service Definition plus its durable store, a pure planner, a scheduler that starts runs through an injected launcher, a per-run supervisor that consumes one real Agent's Session log, a pressure monitor that measures context pressure and prices handoff bodies, a handoff manager that creates one fresh successor Session and delivers one recall message, a recovery reconciler, and the `sessionOrchestrator` Remote controller. `LocalSessionOrchestrator` composes the scheduling pieces for one host; the host invokes `HandoffManager` after a pending pressure decision. The Remote controller reads and mutates the same records through revision-bound DTOs and publishes whole snapshots; it never calls a model or appends a Session event.

### Public types

| Type | Role |
|---|---|
| `QueueId`, `TaskId`, `RunId`, `OperationId` | Branded opaque identities for durable records |
| `ModelPolicy`, `SkillsPolicy`, `PresetPolicy` | Per-task inheritance rules resolved by the supervisor, not here |
| `HandoffPolicy` | Structured-brief thresholds and generation cap for one task |
| `TaskSpec` | The editable task definition; every edit carries `revision` |
| `QueueRecord`, `GlobalSettings` | Queue ordering and host-wide orchestration settings |
| `RunState`, `RunRecord` | One attempt's state machine and its session lineage |
| `OperationRecord` | The create/submit reconciliation unit keyed by `operationId` |
| `HandoffRecord` | Parent/child session lineage with cut point, body hash and config snapshot |
| `SkipRecord` | Audited human skip keyed by run, CAS-bound to the observed run revision |
| `PlannerInput`, `PlannerOutput`, `PlannerReady`, `PlannerBlocked` | The pure ready-set plan: ordered starts, blocked tasks with a typed reason, active and skipped tasks |
| `PlannerBlocker` | Closed union of every reason a task is not ready; `describeBlocker` renders one |
| `HumanSkip` | An audited human skip decision; only `isAuditedSkip` entries can unlock dependents |
| `SchedulerOptions`, `SchedulerStore`, `RunLauncher` | The scheduler's injected ports: records, launch call, clock |
| `SchedulerTickResult`, `SchedulerSkip`, `SchedulerSnapshot` | What one tick started and skipped, plus the locks it currently holds |
| `WorkspaceKeyResolver`, `WorkspaceKeyResolution` | Canonical `workspaceKey` derivation, or a typed rejection |
| `RunSupervisor`, `RunSupervisorOptions`, `RunStartRequest` | The per-run observer/driver and its injected ports |
| `RunLaunchStart`, `RunResumeStart` | Handle ownership returned at Session creation or recovery resume |
| `SupervisorLauncher`, `LaunchSupervisor` | Scheduler-to-supervisor adapter; returns once the Session exists |
| `LocalSessionOrchestrator`, `LocalSessionOrchestratorOptions` | Host-local store/scheduler/supervisor/recovery composition |
| `RecoveryManager`, `RecoveryManagerOptions`, `RecoveryReport` | Reconciliation gate, decisions and unload report |
| `RunHandle`, `RunHandleTable`, `RunOwnership` | In-memory owned-handle table; never stored in the domain |
| `RunSettlement`, `RunSettlementState`, `RunSettlementReason`, `RunProbe` | The terminal outcome and the quiescent-state probe |
| `SessionDurability`, `SupervisorAgents`, `SupervisorLiveSessions`, `SupervisorStore` | Narrow ports: flush one Session, create one Agent, look up live Sessions, read/write records |
| `PressureMonitor`, `PressureMonitorOptions`, `PressureObservation`, `PressureObservationResult` | The 10.1–10.3 measurement/decision unit: live Session, gate facts, rendered bodies, durable snapshot |
| `PressureTokenMeter`, `PressureMeasurement`, `PressureMeasurementBaseline` | Narrow TokenMeter port: `measure(session)` plus `estimateMessage(message)` |
| `PressureStore` | Narrow store port: task/run/settings reads and one revision-CAS run write |
| `PressureHandoffBodies`, `PressureBudget`, `PressureModeBudget`, `PressureBodyFallback` | Independently priced structured-brief and last-complete-turn bodies, with a typed verbatim fallback |
| `PressureRoute`, `pressureRouteFingerprint` | Route identity that invalidates an older ratio, capacity, reserve and pending decision |
| `HandoffManager`, `HandoffManagerOptions`, `HandoffExecutionRequest` | Safe Turn transaction: claim, freeze, create, submit, flush and commit |
| `HandoffStore`, `HandoffAgents`, `HandoffDurability`, `HandoffRuntimeModel` | Narrow handoff ports: CAS records, fresh-session `create`, flush, last-resort route |
| `HandoffResult`, `HandoffStatus`, `HandoffBlockReason`, `HandoffFailureReason` | Typed outcome and explicit blocked/needs-attention reasons |
| `HandoffConfigInheritance`, `HandoffPresetInheritance`, `HandoffConfigDegradation` | Frozen route/preset plus honest permissions/skills and degradation markers |
| `HandoffSessionFacts`, `HandoffCompleteTurn`, `HandoffToolFact`, `HandoffToolStatus` | Complete-Turn boundary projection with only `settled`, `running-known` or `unknown` tools |
| `StructuredBriefInput`, `LastCompleteTurnBodyInput` | Deterministic body renderers; neither calls a model |
| `SessionOrchestratorController`, `SessionOrchestratorControllerInternals` | Host Remote owner for the `sessionOrchestrator` namespace and its test seams |
| `QueueDto`, `TaskDto`, `RunDto`, `HandoffDto`, `SettingsDto` | Redacted wire projections; no Handle, Context, lease, host identity or rendered handoff body |
| `InterventionDto`, `WardenAuditDto` | Audited pipeline decisions and reviews; each names the judge and, for a model review, the route that paid |
| `RuleWarden`, `Warden`, `WardenPacket`, `WardenDecision` | The pure rule judge, its bounded state packet and the verdict vocabulary both judges share |
| `ModelWarden`, `ModelReviewer`, `WardenReview`, `WardenReviewError` | The opt-in model review: one strict-JSON call per review, with packet, output and deadline bounds |
| `WARDEN_REVIEW_SCHEMA`, `WARDEN_REVIEW_SYSTEM_PROMPT`, `wardenReviewSchema` | The strict review contract, pinned as text and as its zod validation |
| `QueueDraft`, `TaskDraft`, `SettingsDraft` | Editable draft values; the controller owns identity, revision and host claim fields |
| `OrchestratorAccess`, `OrchestratorAccessRequest`, `OrchestratorAction`, `OrchestratorRole`, `OrchestratorResource` | Owner/observer/none policy evaluated per collection and per record |
| `OrchestratorRunControl` | Optional live-cancel seam matching `RunSupervisor.cancel(runId)`; absent means state-only cancel |
| `OrchestratorSnapshotFrame`, `SessionOrchestratorRemoteErrorCode` | Whole-snapshot change stream and the stable failure vocabulary |

### Warden modes and cost

The runtime reviews each running task every tick. `wardenMode` selects the judge and defaults to `rule`: `RuleWarden` decides from the packet with no model call and no ledger row, so a default deployment spends exactly zero extra Tokens on review.

`wardenMode: model` is opt-in and requires both `wardenProvider` and `wardenModel`; the runtime fails at load when either is missing or the host mounted no `llm` service. One review is one stateless request: the bounded packet (queue brief head, task prompt head, health signals with their configured thresholds, at most five recent events and at most eight child states), a fixed system prompt, and a strict JSON answer validated by `wardenReviewSchema`, which rejects unknown keys. The request is bounded by `wardenMaxPacketBytes` (UTF-8 bytes), `wardenMaxOutputTokens` and `wardenTimeoutMs`.

Cost is bounded three ways. `wardenCooldownMs` is the minimum interval between two reviews of one run; `wardenMaxReviewsPerRun` caps the reviews one generation may spend, and a spent budget is recorded once as `budget-exhausted`; and the review runs detached, so a slow call never blocks dispatch or health sampling.

The local rules remain the floor. A rule verdict of `decompose` (context ceiling) or `abort-all` (cache hit abort line) acts immediately with no review and is never downgraded by a model verdict (`protectHardGate`). Every other sample either starts one review or falls back to the rules when the review is not yet due.

A review that times out, answers off-contract, is refused by the provider or exceeds its packet budget falls back to the local rule verdict and records a `rule-fallback` row naming the stable code. A successful review records a `model` row with its provider, model, latency and reported prompt/completion Tokens. The review ledger is retained per run (`wardenAuditLimit`, default 20 rows) and published in the snapshot, so the settings page can attribute every review to the route that paid for it.

Decomposition is deliberately not a second model call: the fixed instruction goes into the running conversation and its answer is parsed locally, so that turn is billed to the task's own conversation route. An intervention record carries both facts — `warden` (which judge acted) and `paidBy` (whose conversation paid for the instruction) — and the settings page shows both.

### Planning and scheduling

`planReadyTasks` is pure: it reads a snapshot of tasks, queues, runs and skips and returns a stable ready order, a blocked list with typed reasons, the currently active tasks and the applied skips. It performs no IO and reads no clock. Ordering is priority descending, then queue order, then queue identity, then task identity. `LocalSessionOrchestrator` supplies the store's skip ledger by default and keeps only skips whose run is the task's latest attempt, so a newer attempt is never held back by an older audit record; an explicit `humanSkips` option overrides that reader.

The queue itself is an ordered list. `deriveTaskDependencies` derives every `dependsOn` from the list position: a task waits for the whole preceding group, and a task marked `parallelWithPrevious` joins the group above it. Reorder, insert, copy, delete and marker changes therefore rewrite dependencies in one `commitTaskList` store job, so no move or delete can leave a dependency naming an absent id. `taskListIssues` audits stored records before `startQueue` changes any state; a legacy dangling dependency (for example `t-1` after its task was deleted) refuses the start with `sessionOrchestrator/task-list-invalid`, and `repairTaskList` rewrites the stored dependencies from the existing order.

`Scheduler.tick()` plans, then for each ready entry checks the unload gate, resolves the canonical `workspaceKey`, checks capacity, and dispatches. Dispatch claims the run by a revision CAS to `starting` before calling the launcher, so a second tick can never dispatch the same run twice. Locks are released in `finally`, and a failed launch rolls back to `ready` when retryable and records `needs-attention` otherwise.

### Workspace keys and locks

A `workspaceKey` is the DSH workspace identity joined with a normalized cwd: dot segments collapsed, trailing separators dropped, and case folded on Windows. Two tasks whose spellings differ but resolve to the same directory therefore share one lock. A relative cwd is rejected rather than locked on, and a task never claims read-only to bypass serialization.

### Supervision and completion

`RunSupervisor.start()` drives one already-`starting` run. It creates the Agent through the injected `SupervisorAgents` port, durably records `session-created` and the submitted message identity, then attaches the orchestrator `MessageSource` to the single follow-up prompt. `RunSupervisor.launch()` performs the same creation but returns as soon as the Session exists, so `Scheduler` can commit `starting → running` while the agent continues; a pre-submission failure after creation settles `needs-attention: restart-uncertain` and never returns the attempt to `ready`. `SupervisorLauncher` is the thin `RunLauncher` adapter. Completion is never inferred from one idle callback:

1. wait for `whenIdle()`;
2. probe from `runMaintenance()` for an open turn, run-owned queued input, human input and open approvals;
3. accept only `turn/end` events for turns claimed by this operation's message source;
4. re-converge until no open turn or run-owned input remains;
5. record `claimed`, await `SessionDurability.flush(session)`, then commit `succeeded` under revision CAS.

Human input yields `needs-attention: external-input`, an open approval yields `awaiting-approval`, a flush failure yields `flush-failed`, and a persisted `submitted`/`claimed`/`uncertain` operation yields `restart-uncertain` without replay. Turn failures map to `failed` (`turn-error`, `turn-aborted`, `turn-blocked`, ...). `acceptedTurnEndSeq` is the last accepted durable `turn/end` sequence; duplicate events are counted and never re-accepted.

Handles live only in `RunHandleTable`, keyed by run id and owned by this process. The domain stores no handles. Successful, failed and cancelled runs dispose after the flush/commit boundary; a `needs-attention` run keeps its live handle until `close()` so pending human input or an approval is not dropped. Disposal only touches a taken (owned) entry, so an observed run is never torn down. `close()` stops new starts, awaits in-flight settlements, then disposes leftovers.

### Pressure measurement and decision

`PressureMonitor.observe()` reads the run's persisted `HandoffPolicy`, measures the live Session through the injected TokenMeter, and takes the latest `contextWindow` from `Session.requestContext()`. It writes one `pressure` snapshot under run revision CAS and returns the decision without creating a child Session or appending any Session event.

The 10.2 gates are ordered: handoff enabled, generation cap, paused/cancelled/handing-off, an advanced generation without an accepted turn, external input, an open Turn, known positive capacity, ratio at or above the task threshold, a priced body within `maxHandoffTokens`, and estimated-mode policy. The default authored threshold is `0.88`; the monitor reads the persisted ratio rather than replacing it. A route or capacity change gets a new fingerprint, so the old ratio, reserve and pending decision are discarded and the Session is measured again.

Bodies are priced separately. `structured-brief` adds its own fixed safety margin to `estimateMessage()` of the rendered brief. `last-complete-turn` measures the exact projected messages with its own reserve (default zero); when that total exceeds `maxHandoffTokens`, the result selects the structured brief and records `max-handoff-tokens` in a typed fallback instead of truncating tool pairs. Neither mode borrows the other's reserve.

Repeated observations reuse one measurement per Session log revision. A pending decision on the same route is never written twice, including after later streaming events, so one pressure episode produces one trigger. A lower reading after compaction replaces the pending snapshot with `below-threshold`.

### Safe Turn handoff

`HandoffManager.handoff()` executes only when the run is `running` with a pending pressure decision (or already `handoff-pending`). It validates the persisted policy, reads the parent Session for a normally closed latest Turn with no open Turn and no interrupted tail after its `turn/end`, resolves the durable route, and claims the run with a revision CAS to `handing-off` while appending the deterministic successor Session id to `sessionLineage`. The operation phase then owns restart safety:

1. wait for optional parent quiescence, flush the parent and freeze `sourceSeq`;
2. render the structured brief or exact last-complete-Turn projection and price both with the shared pressure budget;
3. plan one deterministic handoff operation, create the successor with `agents.create` and record `session-created` plus `targetSessionId`;
4. create one recall `UserMessage` with the operation source, record `submitted`, call `followup` exactly once and flush the child;
5. persist the `HandoffRecord` (parent/child, source seq, body hash, mode, config snapshot) and CAS the run to `running` with the child as `activeSessionId`.

The parent Session is never resumed and the new Session receives only the task metadata (`cwd`, `parentSession`, optional `agentPreset`) — no seed, no permissions and no skills are copied. A missing durable route enters `needs-attention: model-unavailable`; a failed parent or child flush enters `flush-failed`; a failure after the child exists enters `handoff-uncertain` with the target retained, so a later call can never create a second child or first message. The operation phase, not a timestamp or list index, is the duplicate guard.

Structured briefs follow the documented fixed template. Facts that the log does not record stay `unknown`; an unsettled tool call is never reported as settled and a missing result is never interpreted as "the tool never started". `last-complete-turn` uses the official event projection in surface order and preserves every user/assistant/tool pairing; when it exceeds `maxHandoffTokens` the manager delivers the structured brief and records the pressure fallback. A compacted or incomplete projection also falls back rather than deleting tool results.

### Remote controller

`SessionOrchestratorController` extends `TypertRemoteService` and binds the Cordis key `sessionOrchestratorController` to the `sessionOrchestrator` Remote namespace. It injects `sessionOrchestrator` and `typert`; the optional Web Session owner is read with `ctx.get('sessionController')` and only adds `linkable` to Session references, so the orchestration namespace works without the Web profile.

Methods are `listQueues`, `getQueue`, `createQueue`, `createPipelineTemplate`, `updateQueue`, `startQueue`, `pauseQueue`, `abortQueue`, `listInterventions`, `deleteDraftQueue`, `upsertTask`, `reorderTasks`, `deleteTask`, `duplicateTask`, `repairTaskList`, `setTaskEnabled`, `skipTask`, `listRuns`, `getRun`, `pause`, `resume`, `cancel`, `retry`, `listHandoffs`, `getHandoff`, `getSettings`, `updateSettings`, and the `changed` snapshot stream. Every mutation carries `expectedRevision`: creates require `0`, updates compare the observed record revision, `skipTask` compares the run revision it audits, and `retry` compares the settled attempt before creating the scheduler's deterministic `run-<task>-<attempt>` successor. `pause` and `resume` update the host-wide scheduler pause; they do not freeze a live Agent.

The access policy receives the action, resource kind and optional record id plus the calling Connection `peerId`, and answers `owner`, `observer` or `none`. A collection-level `none` rejects the list; a record-level `none` filters it from lists and snapshots and reads as `not-found` from `get*`; only an owner may mutate. The default policy grants owner to every admitted caller because Connection already performed transport admission. A host with distinct principals passes its own policy through `SessionOrchestratorControllerInternals` when it constructs the controller directly; a loader-created controller uses the owner default.

Every failure uses one stable code under `sessionOrchestrator/`: `forbidden`, `not-found`, `revision-conflict`, `conflict`, `invalid-transition`, `invalid-request`, `queue-not-empty`, `task-list-invalid`, `unavailable` or `cancelled`. Requests are validated at the wire boundary with the same zod schemas the store uses, and a `cancelled` carrier signal is observed before any durable write. `cancel` commits the durable cancellation through revision CAS and only then calls the optional `OrchestratorRunControl`; it refuses `handing-off` so a handoff transaction is never orphaned, and a stale caller therefore never stops a run another caller settled.

All results are explicit DTOs. `getQueue` returns task prompts because that is the editor's input; snapshots carry only task summaries. A run exposes ids, state, lineage, operation phase, frozen route/preset, pressure facts, stable error code and retryability, but never its lease, submitted message identity, request hash or diagnostic message. Settings omit `hostInstanceId`, and a handoff carries its parent/child ids, cut point, mode, body hash and token count but never the rendered body. An intervention exposes its `warden` verdict and `paidBy` conversation route, and the snapshot carries the bounded `wardenAudits` ledger, so a reviewer can attribute each decision and each review to the account that paid.

`changed` yields one whole snapshot immediately, then one snapshot per coalesced durable change. Each frame carries a monotonic host generation; a reconnecting client starts at the newest generation and discards an older baseline it retained. The stream ends when its carrier signal aborts and removes its `domain/changed` subscription in `finally`.

### Host conversation adapters

`HostSessionAdapter` is one uniform capability contract: the conversation operations `listWorkspaces`, `createSession`, `sendPrompt`, `openSession`, `subscribeEvents`, `getUsage` and `selectModel`, plus the host features a task editor may expose: `listModels`, `skills`, `permissions` and `compaction`. Every method returns a value or an explicit failure; a disabled capability is reported with the host surface it lacks and returns `unsupported` without a side effect. `HostSessionRegistry` keeps one primary execution host and reports every known host to the settings page.

A task resolves its route in one place: a pinned task route wins, otherwise the pipeline route stored on its queue applies, otherwise the host default does. Resolution happens at dispatch, before the Session exists, and the resumed path prefers the route a completed boundary froze, so a draft edit never switches a live model.

| Adapter | Real capabilities | Disabled capabilities |
|---|---|---|
| `DshHostSessionAdapter` | all eleven, over Workspace registry, `ctx.agents`, Session events, live Sessions, token meter, `/session/<id>` and the host services the composition mounted | none when those services are mounted; a missing optional service disables its own row |
| `WorkBuddyHostSessionAdapter` | create, send, subscribe, usage and model selection through the installed `codebuddy --print` CLI (`--session-id`, `--resume`, `--output-format stream-json`, `--model`) | workspace listing (no CLI listing; the desktop REST listing needs the host-issued password), opening a GUI conversation (the CLI resumes a terminal only), model catalog listing, skill composition, permission presets and compaction (the CLI exposes none of them) |
| `TraeHostSessionAdapter` | none | every conversation and feature capability: Trae exposes an IDE launcher and a private `ai-agent` socket, not a public conversation/workspace/prompt protocol |

The queue's execution path remains one path: `SessionOrchestratorRuntime` preflights the DSH adapter and fails at load if the create/send/subscribe trio is unavailable. The WorkBuddy and Trae adapters are verified capability reports; they do not add a second scheduler, recovery manager, health gate or template builder. `hostWorkBuddyCli` and `hostTraeCli` runtime configuration fields make the installed paths explicit when per-user discovery cannot see a non-default install location.

### Host composition and recovery

`LocalSessionOrchestrator` takes the store, one `RunSupervisor`, `ctx.sessionPersistence`, `ctx.sessions` and a stable `hostInstanceId`, then constructs `SupervisorLauncher`, `Scheduler` and `RecoveryManager` over the same seams. It adds no context key and registers no Cordis effect. `tick()` delegates to the reconciler and returns `ran: false` until `reconcile()` opens the gate. `close()` uses the recovery unload order: pause CAS, scheduler close, supervisor close, storage-domain close.

### Storage domain

`session_orchestrator` version `1`, with tables `queues`, `tasks`, `runs`, `operations`, `handoffs`, `skips`, `interventions`, `warden_audits` and a `global` singleton. Authoritative data uses the rejecting default: a stored record that fails its schema refuses the whole open with `invalid-record` naming the table and key. The domain never opts into `backup-and-skip`.

### Writes, revisions and close

Every mutation runs on the store's single FIFO chain, so two concurrent callers cannot interleave a read-modify-write across tables. Each transition compares the caller's `revision` and rejects a stale one with `revision-conflict` before writing. `close()` rejects new writes immediately, drains the writes already queued, then releases the domain; repeated calls share one teardown.

### Operation identity

An `OperationRecord` is identified by `operationId`. Recording the same `operationId` with the same `requestHash` is an identified duplicate and returns the existing record; the same `operationId` with a different `requestHash` rejects with `operation-hash-conflict`. Identity is never derived from `Date.now()` or a list index.

-----

<a id="deployment-and-operations"></a>
## Deployment and operations

### Installation and profile composition

The package is a private workspace package; install it from this repository with `workspace:*` rather than from a separate registry release. Its Node face exports the `SessionOrchestrator` store service (Loader row name `@deepseek-ai/dsh-session-orchestrator`, `inject: ['storageDomain']`) and the constructors `SessionOrchestratorController`, `LocalSessionOrchestrator`, `RunSupervisor` and `HandoffManager`.

The composing profile must provide a storage domain backend (for example the JSON backend) and the Typert registry used by the controller. The package ships two Host rows: `@deepseek-ai/dsh-session-orchestrator` mounts the store, and `@deepseek-ai/dsh-session-orchestrator/host` mounts `SessionOrchestratorController` with the default owner access policy. The `web-app` bundle mounts both, and the browser assemblies the generated `sessionOrchestrator` Remote namespace, so the Web settings page reads the same durable records.

Live execution still needs host wiring: the Agent factory, durable Session persistence, the live Session directory and a TokenMeter are passed to a profile-owned plugin that constructs `RunSupervisor`, `HandoffManager` and `LocalSessionOrchestrator` with its own `OrchestratorAccess` and optional `OrchestratorRunControl`. The controller row starts no scheduler, creates no Agent and calls no model. The optional `runtime` row (`@deepseek-ai/dsh-session-orchestrator/runtime`) is that driver: it ticks the scheduler, samples health and executes interventions, and it leaves the LLM service untouched unless `wardenMode: model` names both a provider and a model. The Web settings page is the separate `@deepseek-ai/dsh-client-ui-settings-session-orchestrator` row; the `web-app` bundle disables that row when `ctx.get('sessionOrchestratorController')` is absent.

The service ports a live profile supplies are:

- `storageDomain` — authoritative records, required by the store;
- `typert` — Remote namespace registration, required by the controller;
- `agents` — Agent creation and recovery resume, passed to the supervisor and handoff manager;
- `sessionPersistence` and `sessions` — flush and live-session lookup for supervision and recovery;
- a TokenMeter and each live Session — pressure measurement, passed by the host;
- `llm` — read through `ctx.get('llm')` only in `wardenMode: model`, where a missing service refuses the plugin at load.

### Data migration

`session_orchestrator` is domain version `1`. Its tables are `queues`, `tasks`, `runs`, `operations`, `handoffs`, `skips`, `interventions`, `warden_audits` and the `global` singleton. `skips`, `interventions` and `warden_audits` were added within version 1 because each introduced a new table without changing an existing record schema; a version-1 medium without one of them opens with that table empty. Any later record-schema change requires a new domain version and a hand-written migration. The domain uses the rejecting default: an unsupported version fails at open with `version-mismatch`, and a malformed record fails with `invalid-record` instead of being skipped. The package never backfills by overwriting, moving or deleting committed generations and does not support downgrade.

### Recovery limits

Startup reconciliation claims the host lease, inspects active runs and their durable operation sources, and opens the scheduler only after the pass. A prompt is never replayed when its operation source cannot be tied to the run, generation and attempt. The recovery target is "do not duplicate blindly and make the boundary auditable", not exactly-once across the domain and Session log. A crash before `session-created` leaves the run `handing-off`; no Remote mutation creates the child, and `uncertain` states become `needs-attention` instead of being replayed. `needs-attention` has no in-process resume API; `retry` creates a fresh attempt. A successful resume restores supervision and settlement but does not advance a stale operation phase. Handoff after a pressure decision and all automatic retries are host wiring, not part of this package. Unload order is pause CAS, scheduler close, supervisor close, then domain close.

### Parallel safety

The scheduler starts tasks whose canonical `workspaceKey` differs and serializes every task sharing one key; there is no read-only bypass. `concurrencyGroup`, provider quotas and the global cap are additional independent limits. Locks and slots are released in `finally`, a failed launch rolls back or records `needs-attention`, and closing the scheduler starts no new work while in-flight launches settle. Canonicalization is lexical: `.`/`..` segments and trailing separators are folded, case is folded on Windows, and relative cwd is rejected; symlink aliases are not resolved. Tasks that share an external database, service or upstream directory need the same `concurrencyGroup` even when their workspace keys differ. The design targets one Host process; the durable lease rejects a second writer, but there is no distributed lock or cross-machine scheduling.

### Test evidence

`tests/zero-llm.spec.ts` is the static and runtime gate. It scans Host and Client sources for forbidden imports and service names and requires the `llm` service to be named by `src/model-warden.ts` alone, then drives the store, scheduler, recovery reconciler, pressure monitor, handoff manager, supervisor and Remote controller against installed spy `llm`, `tools`, `agents`, `compaction` and `sessionTitle` services, and requires every journal to stay empty; a running pipeline in the default rule mode adds a health pass that leaves the LLM journal empty and writes no review row. `tests/model-warden.spec.ts` proves the review contract (strict JSON, fences, rejections, provider failures, deadline, packet cap), the runtime ledger (route and Tokens, cooldown, budget, non-blocking tick, fallback row, hard-gate priority) and the fallback action. `tests/integration.spec.ts` additionally proves the task Agent's one normal `prepareCall` exists while no raw `ctx.llm.stream` call and no auxiliary `purpose` occur. The exact commands and their real results for the pinned snapshot are recorded in the Block 9 implementation record at the workspace root.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

### Design concept

- **Records are authoritative, not caches.** The domain is opened with its rejecting schema policy, so a corrupted or unsupported record stops the host instead of silently dropping orchestration state.
- **One FIFO chain per store.** The domain serializes single-record writes; the store's own chain extends that guarantee to multi-record transitions such as creating a run together with its first operation.
- **Revision CAS at the store, atomic RMW at the domain.** A transition reads the current record, compares `revision`, then writes through `table.update()`, whose transform runs at its chain slot — the compare and the write cannot interleave.
- **Events after the commit point.** Every durable write emits `domain/changed`; listeners that fail are contained rather than rejecting an already-durable write.

### Source map

| File | Role |
|---|---|
| [`src/index.ts`](src/index.ts) | Plugin entry: exports the service, the domain, the planner, the scheduler, the Remote controller and the ids |
| [`src/brand.ts`](src/brand.ts) | Branded identities and their constructors |
| [`src/schema.ts`](src/schema.ts) | Zod schemas; every stored record type is inferred from them |
| [`src/types.ts`](src/types.ts) | Type-only re-export of the schema-inferred record and policy types |
| [`src/storage.ts`](src/storage.ts) | The `session_orchestrator` domain declaration and its initial global |
| [`src/store.ts`](src/store.ts) | `SessionOrchestrator` service: FIFO chain, revision CAS, close |
| [`src/planner.ts`](src/planner.ts) | Pure ready-set planner: DAG order, blockers, skips |
| [`src/task-order.ts`](src/task-order.ts) | Pure ordered-list derivation and the legacy dependency audit |
| [`src/workspace-key.ts`](src/workspace-key.ts) | Canonical `workspaceKey` derivation and its rejections |
| [`src/limits.ts`](src/limits.ts) | The fixed eight-run host ceiling shared by the initial settings and the scheduler |
| [`src/scheduler.ts`](src/scheduler.ts) | `Scheduler`: capacity checks, lock acquisition, dispatch, rollback |
| [`src/launcher.ts`](src/launcher.ts) | `SupervisorLauncher`: scheduler launch port backed by the supervisor |
| [`src/local.ts`](src/local.ts) | `LocalSessionOrchestrator`: host composition and recovery-gated tick/unload |
| [`src/supervisor.ts`](src/supervisor.ts) | `RunSupervisor`: create/launch/follow-up, event attribution, convergence, flush, settle, dispose |
| [`src/pressure.ts`](src/pressure.ts) | `PressureMonitor`: TokenMeter measurement, 10.2 gates, route invalidation, independent body pricing and CAS snapshot |
| [`src/handoff.ts`](src/handoff.ts) | `HandoffManager`: claim/freeze/create/submit/flush/commit, deterministic briefs, Turn projection and config inheritance |
| [`src/remote.ts`](src/remote.ts) | `SessionOrchestratorController`: namespace, access filtering, revision-bound mutations, redacted DTOs and snapshot stream |
| [`src/warden.ts`](src/warden.ts) | `RuleWarden`: zero-token gates, the bounded packet vocabulary, the hard-gate floor and the decomposition parser |
| [`src/model-warden.ts`](src/model-warden.ts) | `ModelWarden`: the opt-in strict-JSON review, its packet/output/deadline bounds and its stable failure codes |
| [`src/runtime.ts`](src/runtime.ts) | The host driver: ticks, health sampling, review budget/cooldown, intervention transactions and the review ledger |
| [`src/recovery.ts`](src/recovery.ts) | `RecoveryManager`: startup reconciliation, lease gate, decisions, resume and unload |
| [`src/errors.ts`](src/errors.ts) | `OrchestratorError` and its stable codes |
| [`src/message-source.ts`](src/message-source.ts) | The `'session-orchestrator'` `MessageSourceMap` contribution |
| [`src/model-route.ts`](src/model-route.ts) | Pipeline/task/host route resolution and the frozen route a resume keeps |
| [`src/host-session.ts`](src/host-session.ts) | The uniform `HostSessionAdapter` capability contract, results and route helper |
| [`src/host-dsh.ts`](src/host-dsh.ts) | The real DSH adapter over Workspace, Agent, Session, meter and route seams |
| [`src/host-workbuddy.ts`](src/host-workbuddy.ts) | The headless WorkBuddy CLI adapter and NDJSON event mapping |
| [`src/host-trae.ts`](src/host-trae.ts) | The explicitly disabled Trae capability report |
| [`src/host-registry.ts`](src/host-registry.ts) | Primary-host selection, capability reports and the runnable preflight |
| [`tests/host-session.spec.ts`](tests/host-session.spec.ts) | Real DSH/WorkBuddy behavior, explicit Trae denial and registry preflight |
| [`tests/harness.ts`](tests/harness.ts) | Memory-backed domain fixture reused by every spec |
| [`tests/fake-launcher.ts`](tests/fake-launcher.ts) | Deterministic `RunLauncher` with a manual accept/reject log |
| [`tests/store.spec.ts`](tests/store.spec.ts) | Schema, CAS, FIFO, operation identity, restart and close cases |
| [`tests/planner.spec.ts`](tests/planner.spec.ts) | DAG, diamond, failure, skip audit and priority-stability cases |
| [`tests/task-order.spec.ts`](tests/task-order.spec.ts) | Serial chains, parallel groups and legacy dangling/duplicate/self/cycle cases |
| [`tests/workspace-key.spec.ts`](tests/workspace-key.spec.ts) | Path normalization, equivalence and rejection cases |
| [`tests/scheduler.spec.ts`](tests/scheduler.spec.ts) | Slots, locks, groups, quotas, pause, unload, rollback and duplicate cases |
| [`tests/queue-pipeline.spec.ts`](tests/queue-pipeline.spec.ts) | Serial queue order, parallel siblings, failed/paused predecessors, deferred children, the eight-run ceiling, start-pause clearing and restart reuse |
| [`tests/fake-agent.ts`](tests/fake-agent.ts) | Deterministic Agent, factory, durability port and Session-event builders |
| [`tests/supervisor.spec.ts`](tests/supervisor.spec.ts) | Attribution, one-idle rejection, re-convergence, failure boundaries, flush/dispose, restart and scheduler-launch cases |
| [`tests/local.spec.ts`](tests/local.spec.ts) | Launch adapter, recovery-gated tick, one-Session dispatch and unload order |
| [`tests/pressure.spec.ts`](tests/pressure.spec.ts) | Threshold boundaries, estimated/usage, model switch, compaction drop, unknown capacity, streaming dedupe, generation/pause and body budgets |
| [`tests/handoff.spec.ts`](tests/handoff.spec.ts) | One-child concurrency, open Turn, interrupted tail, pairing, long-Turn fallback, model/flush failures, post-create crash, generation cap and preset degradation |
| [`tests/remote.spec.ts`](tests/remote.spec.ts) | Namespace markers, owner/observer/none access, record filtering, revision conflicts, cancel/retry races, invalid input, redaction scan, reconnect snapshots and optional Session link |
| [`tests/fake-token-meter.ts`](tests/fake-token-meter.ts) | Controllable TokenMeter: fixed reading, baseline kind and per-message estimator |
| [`tests/recovery.spec.ts`](tests/recovery.spec.ts) | Lease, reconciliation decisions, resume, containment and unload matrix |
| [`tests/integration.spec.ts`](tests/integration.spec.ts) | One real agent-loop + MockAdapter run driven to a committed success, with normal-call-only spies |
| [`tests/zero-llm.spec.ts`](tests/zero-llm.spec.ts) | Static forbidden-import scan plus runtime spy journals for LLM, tools, agents, compaction and titles |
| [`tests/model-warden.spec.ts`](tests/model-warden.spec.ts) | The strict review contract, the review ledger, cooldown and budget, the non-blocking tick and the rule fallback |
| [`tests/mock-adapter.ts`](tests/mock-adapter.ts) | Scripted local LLM adapter for the integration case |

### Test commands

```sh
# Type-check this package against the workspace-installed 0.2.0-rc.2 declarations
node node_modules/typescript/bin/tsc -p verify/tsconfig.orchestrator.json

# Run one suite (the forks pool is unavailable in this environment)
node node_modules/vitest/vitest.mjs run --pool=threads \
  "tmp-src/deepseek-harness-639ed015397290b3745d163aafe02ffee4aa3f84/packages/orchestrator/session-orchestrator/tests/store.spec.ts"
```

The suites are `store`, `planner`, `workspace-key`, `scheduler`, `supervisor`, `recovery`, `recovery-matrix`, `fault-injection`, `local`, `integration`, `pressure`, `handoff`, `remote`, `zero-llm` and `model-warden`; pass several paths to one `vitest run` to execute them together. The devroot `vitest.config.mts` supplies the standard-decorator transform the decorator-bearing `remote.ts` needs; without it the default transform refuses the source.

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

- [Storage subsystem](../../../docs/subsystems/storage.md) — the domain contract, backend routing, change events.
- [Storage package map](../../storage/README.md) — the sibling domain and backend packages this one builds on.

-----

<a id="model-experience"></a>
## Model Experience

### Durable orchestration state

#### What the model sees

Nothing by default. The package registers no tools and injects no prompt text into a Session; the task Agent sees only the task prompt the host already sends. Its model-adjacent contributions are the `'session-orchestrator'` message source on a handoff recall message or an intervention instruction, which relates that user message to the operation that produced it.

In the opt-in model mode the warden sends one standalone request per review: a fixed system prompt and the bounded state packet, with no Session identity, no transcript and no history. The review answer never becomes a Session event.

#### Token effect

Zero by default: `wardenMode: rule` performs no model call, and the rule warden's decisions are pure functions of the packet. In `wardenMode: model` each review bills the configured route once, bounded by the cooldown, the per-run budget, the output cap and the packet byte cap; a review that falls back spends what the provider already charged for the attempt, and the ledger records it. Decomposition stays one call inside the task's own conversation, never a second model call.

#### KV Cache effect

Independent: nothing here touches a task's request prefix. A warden review has no Session identity and no shared prefix, so it neither warms nor invalidates any conversation's cache.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- **Fast settlement can outrun the scheduler commit.** `launch()` returns once the Session exists; a run that settles before `Scheduler.markRunning` wins the terminal CAS. The scheduler records the stale commit as a failure, the terminal run state remains authoritative, and recovery reconciles it. No prompt is replayed.
- **Recovery success does not advance an operation phase.** `resume()` restores supervision and settlement, but an operation left at `session-created` stays there until the supervisor's own submission path or a later block advances it.
- **`needs-attention` has no in-process resume API.** The live handle is kept until `close()`; the Remote `retry` creates a fresh attempt rather than resuming the old Agent, and a host must resolve the human boundary before unloading.
- **Retry is explicit, not automatic.** The Remote controller can create the next deterministic attempt, but `LocalSessionOrchestrator` does not auto-retry; pressure still produces a durable `handoff-pending` decision that the host must hand to `HandoffManager`.
- **Pressure is not auto-wired to the supervisor.** The caller supplies the live Session, `turnClosed`, `externalInput` and pre-rendered bodies. Rendering a brief or projecting the last turn is `HandoffManager` work, not part of this monitor.
- **Handoff preset degradation lacks a schema field.** `EffectiveConfigSnapshot.preset` has no `source`; when no session, task or prior preset is readable the manager records the reserved `host-default` id, omits `meta.agentPreset`, and exposes the degradation in `HandoffConfigInheritance` instead of inventing a complete preset copy.
- **A hard crash before `session-created` is not auto-reconciled here.** A process restart sees `handing-off` and refuses to create another child; `getRun`/`listRuns` expose the state and operation phase, but no Remote mutation replays or reconciles the uncertain handoff.
- **`observe-only` reuses an existing reason.** The schema has no estimated-mode reason, so an estimated reading suppressed by `estimatedMode: 'observe-only'` is recorded as `handoff-disabled` with `observeOnly: true` in the result.
- **No time-based cooldown.** The cooldown is the durable rule that an advanced generation must have an accepted turn (`empty-generation`); no wall-clock duration is invented.
- **No model-side pressure input.** The doc's `contextPressure().pressureTokens` is not a TokenMeter API at the pinned commit; the monitor uses `measure(session).totalTokens` and `Session.requestContext().contextWindow`.
- **Session flush is a port.** The supervisor awaits one flush but does not configure durability listeners; the host must compose a checkpoint policy for `flushParticipated` to be true.
- **A custom `humanSkips` reader must keep the latest-attempt filter.** `skipTask` writes an audited `SkipRecord` against the observed `needs-attention` revision; `LocalSessionOrchestrator` reads `store.listSkips()` by default and keeps only skips whose run is the task's latest attempt, so a later `retry` is not held back and audit records remain. Supplying `humanSkips` replaces that reader; returning older skips would re-apply them.
- **Remote pause is host-wide and cancel is state-first.** `pause`/`resume` change the global scheduler pause, and `cancel` commits the durable cancellation before calling an injected `OrchestratorRunControl`. `cancel` refuses a `handing-off` run so a mid-transaction handoff cannot be orphaned; let it settle or recover first. Without the run-control seam the Agent keeps running to its own boundary; the controller never owns or exposes a Handle.
- **Default Remote access is owner.** Connection already authenticates every admitted caller, so the default policy grants owner. A host with observer or per-record principals must inject an `OrchestratorAccess`; the controller enforces whatever that policy returns.
- **Session links are presence-only.** The optional `ctx.get('sessionController')` lookup reports `linkable`; it does not call the Web controller, so no URL or session-content projection is invented here.
- **Typert artifacts are build output.** The package exports `./typert` for the Host manifest and `./remote` for the browser assembly; both resolve to `lib/typert.*` emitted by the workspace bundle. A source checkout without a build cannot mount the Remote namespace, and the browser assembly must include this package's `./remote` contribution.
- **The model warden is opt-in and off by default.** `wardenMode` defaults to `rule`, which is the only mode that provably spends no Tokens. Enabling `model` requires `wardenProvider` and `wardenModel` and a mounted `llm` service; a missing route or service fails at plugin load rather than at the first tick.
- **A model verdict cannot downgrade a local safety gate.** `protectHardGate` keeps rule verdicts of `decompose` (context ceiling) and `abort-all` (cache hit abort line) authoritative, and those gates act without a review. The model can add judgement — early decomposition, a stuck-task stop, a refine — only where the rules see no floor. Other rule advisories (`refine`, `stop-and-notify`) wait for the next review slot, at most one cooldown.
- **A review failure is a fallback, not a queue failure.** Timeout, an off-contract answer, a provider failure or an exceeded packet budget uses the local verdict immediately, records a `rule-fallback` row with the stable code and leaves the queue running. The provider may still bill the failed attempt; the ledger records it but cannot refund it.
- **Review budgets are per run generation, not per host.** `wardenMaxReviewsPerRun` counts the reviews recorded for one `(runId, generation)` pair, so a retry starts a fresh budget. Retention keeps only `wardenAuditLimit` rows per run, so a reviewer cannot page through an unbounded history.
- **Warden mode is deployment configuration, not a page toggle.** `wardenMode`, its route and its bounds are plugin `Config` fields read from the composing profile; the settings page shows the resulting review ledger but cannot switch the judge. Changing the mode therefore restarts or reloads the runtime row.
- **No cross-table transaction.** A multi-record transition is atomic with respect to other store callers, but a crash between two durable writes can still leave a reconcilable intermediate state; recovery is reconciliation, not exactly-once.
- **WorkBuddy workspace listing and GUI opening are disabled.** The headless CLI exposes `--add-dir`, `--session-id`, `--resume`, `--output-format stream-json` and `--model`, but no workspace listing and no stable GUI conversation route; the adapter reports both capabilities as `unsupported` instead of inventing them from private files. The desktop REST listing exists but requires the host-issued password, which this adapter never handles.
- **The WorkBuddy adapter is not a second queue backend.** It is a verified capability report and a subprocess API; the shared queue, recovery, health gates and templates still execute DSH Sessions through one `SessionOrchestratorRuntime`. Composing external Sessions would require a durable event mirror and a driver, which this package does not add.
- **Trae exposes no conversation API.** The IDE launcher opens folders/files/extensions and its `ai-agent` module is an internal socket; the DSH `trae` model route is not a Trae conversation model. Every `HostSessionAdapter` method is therefore disabled with that reason.
- **Per-user installs can sit outside discovery roots.** `hostWorkBuddyCli` and `hostTraeCli` are explicit `Config` fields; set them in the runtime row when the CLI is installed on another drive. Leaving them empty means discovery, not a fabricated path.
- **Symlinks are not resolved.** `workspaceKey` normalization is lexical so planning stays pure and IO-free; a symlink alias for the same directory is not folded until the launcher reports the real path.
- **No data migration.** Changing a record schema requires a new domain version and a hand-written migration; an older medium rejects at open with `version-mismatch`. Adding a table within version 1 does not rewrite existing records.
- **Only one host execution path is pre-composed.** The shipped Host rows mount the store, the Remote controller and the `runtime` row; the runtime constructs the supervisor, recovery manager and `LocalSessionOrchestrator` and preflights the DSH adapter. WorkBuddy and Trae remain capability reports, so a deployment that wants their conversations must add an external driver instead of a second scheduler.
- **No runtime invariant companion is published because the store's revision CAS, the recovery reconciler and the DTO projection are the independently checked relationships; a second observer would duplicate those checks rather than expose a new owned divergence.**

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

The package is developed against the pinned `dsh-v0.2.0-rc.2` source; every API it consumes is read from that tree before use. Block scope is fixed by the design document's chunk list, and each block reports real test output rather than assertions of intent.

</details>
