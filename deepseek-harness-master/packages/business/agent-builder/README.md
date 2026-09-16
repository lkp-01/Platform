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

[Platform Runs](src/platform-runs.ts) persist admission before creating a dedicated Harness Session. Each accepted task fixes its version, configuration hash and deployment revision; `platform/run` records the same attribution in the Session log. Status comes from Harness turn events. Repeated admission tokens never send the task twice. Process loss before a completed turn is reported as interrupted, without automatic resubmission. The Session and Preset authorization hooks reject direct version startup, model changes, additional prompts, forks and managed composition changes. Ordinary legacy conversations retain their existing behavior.

Version Presets use independent `version-*` directories excluded from legacy resource import. Their complete files are checked before activation and startup; dependency mounting must succeed before the deployment pointer changes. Existing Sessions restore their recorded Preset. External file edits, changed plugin code, Host system-prompt contributions and remote service changes are outside the frozen business configuration; request headers and model-visible messages record what actually ran. This is configuration traceability, not deterministic output reproduction.

### Immutable execution adapter

The [business bundle](../../bundle/business-agents/README.md) mounts the authoring service and adds its persistent directory to Preset discovery. Open **Agent library**, choose **Create Agent**, fill the four fields and save. **Start Chat** creates a separate Session using that definition. Models come from configured Host providers; tools come from the existing business tool catalog. An empty tool selection creates a conversation-only Agent.

| Field | Default | Meaning |
|---|---|---|
| `root` | Required | Host-owned directory also configured as a Preset discovery root |

Name and Prompt are required and limited to 100 and 32,000 characters. The browser cannot supply plugin paths, executable configuration or credentials. Submission tokens deduplicate identical retries on the writing Host across restarts; conflicting reuse fails. The bundle marks managed definitions as system-owned to prevent generic Preset deletion or file-edit actions from invalidating their identity.

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

The [authoring service](src/index.ts) validates choices and publishes a complete fixed [composition](src/definition.ts) through a sibling staging directory. Preset discovery remains the only runtime registry. The [prompt plugin](src/prompt.ts) supplies user text as a variable value, preserving literal template syntax, and guards dispatch against unselected tools. Session Controller resolves the saved model through its initial-model hook before publishing a new Agent; existing sessions retain recorded selections. No independent execution loop, session store or runtime invariant companion is needed: persistence has one immutable representation, and registry effects own cleanup.

</details>

No runtime invariant companion is published because Storage Domain owns committed records and each admission checks its exact version and execution artifact before invoking Harness. Plugin disposal drains admitted Registry operations and closes the owned Domains.

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
- One default Host deployment is supported. Branches, merges, diffs, multiple deployment environments, tenant authorization, automatic retries and evaluation scoring are deferred. Legacy Sessions are not retrospectively assigned platform versions or Run identities.
- The tool catalog uses local demo data and simulated writes. Additional tools and providers must first be configured by the deployment owner.
- Model catalog validation does not prove remote credentials, quota or service availability; runtime errors remain visible through the existing Session path.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
