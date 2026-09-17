---
description: "Create reusable business Agents from a prompt, a configured model and selected tools."
kind: "package-reference"
---

# @deepseek-ai/dsh-agent-builder

English | [中文](README.zh.md)

## Summary

Create an Agent from a name, role prompt, model and tool selection. Save it once and open independent conversations whenever needed. Use a built-in business Agent as a template or start with an empty form. Saving makes no model call and executes no business tools.

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

<a id="use-this-package"></a>
## Use this package

### Resource Registry

The **Agents** sidebar panel manages stable resources with descriptions, organization ownership, Harness selection and editable drafts. [Registry](src/registry.ts) stores the current configuration in the `platform_agent_registry` Storage Domain using the deployment's backend (JSON in the shipped base, optionally routed to SQLite). Updates require the loaded revision. Archive/restore preserves identity and history; archived resources cannot be edited or start a new legacy Session.

Host configuration accepts `workspaceId` / `workspaceName` (defaults `shared` / `Shared workspace`) and `ownerTeamId` / `ownerTeamName` (defaults `shared-team` / `Shared team`). These are explicit shared-host references, not authenticated tenant membership or filesystem Workspaces. Only one writing Host may open Registry data. Creation tokens deduplicate retries across restarts and reject changed payloads even after later edits.

Valid legacy definitions import idempotently at startup; invalid entries appear in catalog diagnostics. Original Presets remain unchanged, and legacy creation also registers a resource. A resource committed before failed Preset publication is recovered by retrying its creation token. Built-in definitions remain templates. Draft editing never rewrites an existing Preset. New resources remain drafts until the developer explicitly saves a version.

### Versions, deployment and Runs

**Save as new version** captures the saved draft revision, literal Prompt, model route, selected tools, supported resolved model parameters and format-one composition settings. Version numbers increase per Agent. Version rows cannot be edited or deleted. Saving never deploys; **Deploy** selects the default version for future tasks on this Host. **Roll back** activates an older saved version without changing drafts or active tasks. Dependency or persistence failures retain the prior deployment.

[Versions](src/versions.ts) and [deployments](src/deployments.ts) use separate Storage Domains. Each Agent's version sequence and retry receipts commit in one serialized record; its deployment pointer, history and receipts also commit together. Registry serialization orders these operations with draft edits and archival. Historical snapshots remain readable when their model or tools disappear. Per-Agent records grow with retained history and support a single writing Host.

[Platform Runs](src/platform-runs.ts) persist admission, input, fixed version and execution policy before a worker creates the dedicated Harness Session. States are PENDING, RUNNING, RETRY_WAIT, RECOVERING, BLOCKED, SUCCEEDED, FAILED and CANCELLED. Admission tokens deduplicate submissions across restarts. Format-three tasks recover on startup; older tasks retain their interruption behavior without automatic replay. Terminal facts are immutable. Cancellation persists intent before requesting Harness cancellation and prevents later worker dispatch. Storage read failures remain visible errors.

Version Presets use independent `version-*` directories excluded from legacy resource import. Their complete files are checked before activation and startup; dependency mounting must succeed before the deployment pointer changes. Existing Sessions restore their recorded Preset. External file edits, changed plugin code, Host system-prompt contributions and remote service changes are outside the frozen business configuration; request headers and model-visible messages record what actually ran. This is configuration traceability, not deterministic output reproduction.

### Reliable execution

The Runtime owns a bounded in-process worker pool and durable scheduling. A kernel-backed exclusive lease on `root/.runtime-owner` rejects a second writing Host using the same root. A Run is assigned to one worker; its monotonically increasing attempt identifies checkpoint writes. Heartbeats describe progress and never authorize a competing Host to steal ownership. All writers must use the same canonical root on one machine; shared network filesystems and independently deployed workers are unsupported.

Session events remain the execution source. The worker flushes them at step and tool boundaries, periodically checkpoints progress, and flushes before publishing final state. On restart it reconciles durable completion first, restores known missing tool results, then resumes the same Session and frozen version through Harness. The original input is delivered once; continuation uses a logged recovery message. Harness still owns the only Agent Loop. Stream fragments without a committed boundary can be regenerated.

The `platform_runtime_tools` Domain records dispatch intent before the tool body and canonical results before the next step. A lost result does not prove a write failed. Unknown write outcomes enter BLOCKED; **Record verified outcome** accepts externally verified completion or confirmed non-execution, evidence and an idempotent token. Completion is conveyed as operator evidence, not an invented original result. Nested unresolved tool calls require investigation and cancellation; this release cannot automatically reconstruct their parent execution.

Only top-level tools explicitly listed in `runtime.replaySafeTools` may automatically retry unknown outcomes or configured transient error codes. Each retry re-enters all Harness tool guards with the original call identity, after durable exponential backoff with jitter. The default list is empty. A declaration must reflect real adapter semantics; side-effecting APIs need an external idempotency contract before being declared safe. Platform persistence alone cannot guarantee exactly-once remote effects. Business and authorization failures are not automatically retried. Cancellation is cooperative and cannot undo an already dispatched remote operation.

The `runtime` Host configuration defaults to concurrency 4, polling every 1000 ms, checkpoints every 5000 ms, 5 worker attempts, 3 tool attempts, a 24-hour deadline, a 1000 ms retry base, 10,000 tool calls and 1 MiB per durable tool result. Policy is captured on admission; pool concurrency and polling remain Host settings. A temporarily unavailable model route waits within the worker attempt budget. Model transport retry remains Harness-owned. Exhausted task budgets terminate execution; uncertain tool recovery can remain BLOCKED until an explicit decision or cancellation. Deadline enforcement runs at execution boundaries and checkpoints and depends on adapters honoring abort signals.

### Immutable execution adapter

The [business bundle](../../bundle/business-agents/README.md) mounts the authoring service and adds its persistent directory to Preset discovery. Open **Agent library**, choose **Create Agent**, fill the four fields and save. **Start Chat** creates a separate Session using that definition. Models come from configured Host providers; tools come from the existing business tool catalog. An empty tool selection creates a conversation-only Agent.

| Field | Default | Meaning |
|---|---|---|
| `root` | Required | Host-owned directory also configured as a Preset discovery root |

Name and Prompt are required and limited to 100 and 32,000 characters. The browser cannot supply plugin paths, executable configuration or credentials. Submission tokens deduplicate identical retries on the writing Host across restarts; conflicting reuse fails. The bundle marks managed definitions as system-owned to prevent generic Preset deletion or file-edit actions from invalidating their identity.


### Shared resources

The **Resources** panel registers Model, Tool and instruction-only Skill drafts with display ownership, publishes immutable versions, and lists consuming Agent drafts and versions. The resource directory has its own Storage Domain inside this package. Resource status is active, deprecated, disabled or archived; deprecated resources retain existing references, while disabled/archived resources block deployment, startup and subsequent managed model/tool calls. Published records are retained. Without `governanceFile`, the demo uses existing shared Host access; governed deployments apply the roles below.

Agent drafts select exact resource versions. Format-two Agent versions capture their published contents and hashes; resource publication never upgrades an Agent implicitly. Skills are eagerly composed as literal system instructions and recorded by the existing system-message path, not loaded from mutable user directories. The authored Prompt plus Skill content must fit the existing 32,000-character composition limit. Legacy format-one hashes and renderers remain unchanged; editing a legacy draft imports available installed capabilities as resource references. Model routes use existing Host credentials; no key fields are accepted or persisted by this directory.

Tool resources select existing business operations, and Model resources select installed routes. This directory does not install adapters or freeze external service implementations. Per-version disabling, MCP management, Knowledge Source adapters, Skill scripts and attachments are deferred. Resource lifecycle checks do not retract in-flight remote calls or instructions already seen by a model.

### Workspace governance

Setting `governanceFile` enables the authenticated portal at `/platform`. The JSON file provisions user IDs, display names, SHA-256 digests of independent random credentials, bootstrap workspaces and `sessionHours` (default 8). `publicOrigin` optionally names an exact HTTPS origin; without it, only this listener's localhost and 127.0.0.1 origins are accepted. Password registration, enterprise IAM and cross-workspace sharing are outside this mode.

The WebServer must set `requireAccessPolicy: true`. It refuses requests before governance is ready and after the policy unloads. The governed listener exposes only the portal and its allowlisted API; raw Harness RPC, Session, attachment, file, global event and WebSocket routes are unavailable. HTTP cookies are HttpOnly and SameSite=Strict, with Secure on HTTPS. Writes require matching Origin and JSON. Login replaces that user's previous browser session; logout, expiry, user deactivation or credential rotation revoke access. Operator configuration changes take effect on reload.

Administrators manage members, workspace availability and resources. Developers collaboratively edit all Agents in their workspace, save versions, deploy and inspect all workspace Runs. Ordinary users invoke deployed Agents and see only their own input, status and final result; full Agent configuration, Trace and other users' Runs are denied. Creator and editor IDs are audit attribution rather than personal ownership restrictions. Member edits protect the last active administrator and reject stale revisions even after removal and rejoining.

Every resource query and binding uses an explicit workspace. Idempotency separates users and workspaces. Tools execute only when bound to the accepted Agent version and still available in that workspace. Queue dispatch, model steps, tool dispatch and recovery check current execution authority; historical `shared-host` tasks cannot acquire a human identity. Revocation does not retract an external call already in flight. Runtime continues to use Harness and its existing execution facts.

Startup validates persisted ownership and references without rewriting historical IDs, version hashes or deployments. Existing workspace IDs must be included in operator configuration; unknown or conflicting references fail startup. Membership bootstrap creates only missing workspaces and never restores removed members. Back up storage and stop the old writer before enabling governance; restore the complete backup and matching configuration to roll back. Governance retains successful member and control-plane changes separately from execution Trace. Control-plane audit append follows the business commit; an audit storage failure reports failure although the business change may already be durable, so use the same request token when retrying.

From the repository root, `pnpm exec tsx scripts/provision-platform-governance.ts --out ../.business-runtime/governance` creates a new private configuration directory, an overlay and a separate credentials file without printing secrets. It refuses an existing directory. Apply the generated overlay after the business-agents overlay in the existing `dsh` profile, distribute individual credentials privately, and add provisioned users through the workspace administrator's Members page. The portal's **Import installed resources** action registers installed adapters only in the selected workspace. The [governance decision](../../../.agents/notes/implemented/feature/2026-09-17-workspace-governance.md) describes the transport tradeoff.

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

The [authoring service](src/index.ts) validates choices and publishes a complete fixed [composition](src/definition.ts) through a sibling staging directory. Preset discovery remains the only runtime registry. The [prompt plugin](src/prompt.ts) supplies user text as a variable value, preserving literal template syntax, and guards dispatch against unselected tools. Session Controller resolves the saved model through its initial-model hook before publishing a new Agent; existing sessions retain recorded selections. No independent execution loop, session store or runtime invariant companion is needed: persistence has one immutable representation, and registry effects own cleanup.

</details>

No runtime invariant companion is published because Storage Domain owns committed records and each admission checks its exact version and execution artifact before invoking Harness. Plugin disposal stops admission, drains launches and execution settlements, then closes the owned Domains. Lifecycle events are retained with the Run in the same atomic record and announced by the existing Storage Domain change notification; this is not a durable message bus.

### Run Trace

[PlatformTraces](src/platform-traces.ts) records model starts from the existing Agent stream notification and projects model settlements, tool calls/results, retry facts and final answers from the original Session and Run records. The `platform_run_traces` Storage Domain retains model-start observations, revisioned pages of at most 100 events and their summary. Pages land before the summary publishes their revision; failed writes can replay without double counting. Run shutdown settles execution before Trace drains its writes. Trace never drives execution or changes a Run outcome.

`runTraceGet` and `runTraceEvents` enforce the same workspace/Agent/Run association as Run queries. Cursors bind to one Run and revision; a changed revision requires reading from the first page. Normal reads use stored pages. Relevant execution notifications coalesce source-log reconciliation; legacy Runs rebuild on first access. Reconciliation currently folds the complete source log, so long active Runs cost more than an incremental checkpoint projector. No remote telemetry backend is required.

Host option `tracePreviewChars` defaults to 4000 Unicode code points, with range 64–16000. Previews mask common credential fields and preserve truncation flags; this is not a guarantee that arbitrary text contains no sensitive data. Original Session content retains its existing access policy. Missing model-start times, recovered tool outcomes and absent usage remain unknown. Model duration measures the observed start-to-settlement interval; tool duration includes the Harness call chain. Cached input contributes to total input, reasoning is an output subset, and incomplete accounting is explicitly labeled. Unflushed source facts may be lost on abrupt process termination. Multi-Host tracing, retention automation, distributed spans and cross-Session aggregation are outside this package.

## Agent run analytics

Agent Analytics compares runtime success, cancellations, latency, tokens and versions. Workspace administrators can inspect dependency health and open matching Runs and their Trace records. Tool attempts and final logical outcomes have separate denominators; missing usage and prices remain unknown. These metrics describe execution, not answer correctness.

Analytics reuses Trace and Runtime facts, replacing one compact durable record per Run. Background reconciliation includes unread historical Runs. Data coverage and pending projections remain visible; analytics storage failure does not decide task outcomes. The operator can set `observabilityRefreshMs` and an `observabilityPricesFile` containing versioned model rates in integer micro currency units per million tokens. Without rates, cost remains unknown. Price calculations retain currency and the applied rate version.

The [Observability decision](../../../.agents/notes/implemented/feature/2026-09-17-agent-observability.md) explains accounting and recovery. Cross-workspace administrator access, business-quality evaluation and distributed analytics are outside this single-Host feature.

<a id="model-experience"></a>
## Model Experience

### Authored role and selected capabilities

#### What the model sees

The authored Prompt is literal role text inside the normal system prompt, including text such as `{{customer}}`. The model receives only the selected business tool schemas and ordinary tool results. The saved provider/model route initializes new conversations without changing the Host default.

#### Token effect

Prompt length and the number of selected schemas determine additional input tokens. Creating a definition consumes no model tokens. Existing context management handles conversation history.

#### KV Cache effect

An immutable definition keeps its role and tool prefix stable. Different prompts or tool selections change that prefix; provider cache reuse is not guaranteed.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

This package targets the current single-Host business deployment.

- Agents are shared within the existing Host access scope. Per-user ownership, memory settings and permission editing are not supplied.
- One default Host deployment is supported. Branches, merges, diffs, multiple deployment environments, tenant authorization and evaluation scoring are deferred. Legacy Sessions are not retrospectively assigned platform versions or Run identities.
- The tool catalog uses local demo data and simulated writes. Additional tools and providers must first be configured by the deployment owner.
- Model catalog validation does not prove remote credentials, quota or service availability; runtime errors remain visible through the existing Session path.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
