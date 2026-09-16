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

The [business bundle](../../bundle/business-agents/README.md) mounts the authoring service and adds its persistent directory to Preset discovery. Open **Agent library**, choose **Create Agent**, fill the four fields and save. **Start Chat** creates a separate Session using that definition. Models come from configured Host providers; tools come from the existing business tool catalog. An empty tool selection creates a conversation-only Agent.

| Field | Default | Meaning |
|---|---|---|
| `root` | Required | Host-owned directory also configured as a Preset discovery root |

Name and Prompt are required and limited to 100 and 32,000 characters. The browser cannot supply plugin paths, executable configuration or credentials. Submission tokens deduplicate identical retries across processes and restarts; conflicting reuse fails. The bundle marks managed definitions as system-owned to prevent generic Preset deletion or file-edit actions from invalidating their identity.

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

The [authoring service](src/index.ts) validates choices and publishes a complete fixed [composition](src/definition.ts) through a sibling staging directory. Preset discovery remains the only runtime registry. The [prompt plugin](src/prompt.ts) supplies user text as a variable value, preserving literal template syntax, and guards dispatch against unselected tools. Session Controller resolves the saved model through its initial-model hook before publishing a new Agent; existing sessions retain recorded selections. No independent execution loop, session store or runtime invariant companion is needed: persistence has one immutable representation, and registry effects own cleanup.

</details>

No runtime invariant companion is published because definitions have one immutable representation and Cordis effects own registry cleanup.

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
- Definitions are immutable in the UI. Create from a template to make changes; external file edits are outside the supported workflow.
- The tool catalog uses local demo data and simulated writes. Additional tools and providers must first be configured by the deployment owner.
- Model catalog validation does not prove remote credentials, quota or service availability; runtime errors remain visible through the existing Session path.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
