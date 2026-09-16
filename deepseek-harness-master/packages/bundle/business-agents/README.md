---
description: "Run three configured business Agents over the shared Harness Web core."
kind: "package-bundle"
---

# @deepseek-ai/dsh-business-agents

English | [中文](README.zh.md)

## Summary

Choose Customer Service, Data, or Operations in the existing Web chat. Each selection creates a separate Session with its own persona and tools. All three use the host model default and the official Agent Loop. This optional layer supplies local demonstration data and simulated writes.

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

<a id="use-this-package"></a>
## Use this package

From the repository root, after `pnpm install` and `pnpm run build`, apply the layer to the Web profile:

```sh
pnpm dsh --profile web --patch ./packages/bundle/business-agents/cordis.patch.yml --no-open
```

Open the authenticated URL printed by the launcher. Choose a workspace and use the Agent menu beside the composer. Picking a different Agent creates a new Session; Start a new chat creates another Session with the displayed Agent.

Provide `DEEPSEEK_API_KEY` through the local process environment or repository `.env`; never commit it. Model calls require a valid key. Fixture tools require no external credentials.

| Agent | Tools |
|---|---|
| Customer Service Agent | `knowledge_search`, `order_query`, `ticket_create` |
| Data Agent | `data_catalog`, `sql_query`, `dataset_read`, `data_analyze` |
| Operations Agent | `project_query`, `calendar_query`, `task_create`, `message_send` |

Ask about delayed order O-1002, the largest revenue decline in August 2026, or overdue projects and follow-up tasks. The demonstration business date is 2026-09-15. July and August are the available sales periods.

To add a fourth Agent, add a directory under `presets/` with `preset.yml` and `agent.cordis.yml`. The directory name is its id; metadata owns name, description and order; the composition mounts persona and tool plugins. Reuse existing tool plugins or implement a new plugin for new capabilities. No loop change is needed. Session model selection remains the official API.

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

The [patch](cordis.patch.yml) mounts the record projection and replaces preset discovery roots. The official [Agent Presets](../../preset/agent-presets/README.md) service is the registry and launcher. Each definition uses [Persona](../../preset/persona/README.md), business tools, and the shipped compaction plugins. [Business tools](../../business/business-tools/README.md) own dataset and mock operation behavior.

[Composition tests](tests/composition.spec.ts) mount real preset files through Loader and exercise multi-step calls through the official loop. No runtime invariant companion is published: this bundle stores only an immutable asset path, while lifecycle ownership remains in the existing registries.

</details>

Open **Agent library** beside the Agent selector to create an Agent from Name, Prompt, Model and Tools, or use an existing Agent as a template. Definitions are saved under the Harness home `business-agents/` directory and appear without restarting. **Start Chat** initializes a separate Session with the saved model and selected tools. See [Agent authoring](../../business/agent-builder/README.md).

<a id="model-experience"></a>
## Model Experience

### Business persona and tool selection

#### What the model sees

Each Session receives the selected `persona.prefix` and only the scoped business tool schemas. The host model configuration applies equally to the three definitions. Tool results enter the normal conversation history.

#### Token effect

One persona and three or four tool schemas add fixed request context. Results vary with the task and follow the existing compaction policy.

#### KV Cache effect

Sessions with the same definition can share stable prompt prefixes; different tool sets change the request prefix. Provider cache reuse is not guaranteed.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

This layer is a local phase-one demonstration.

- Use Node 24.12 or newer for the SQLite authorization API; validated locally with Node 24.12.
- Business definitions replace the shipped and user discovery roots for this launch. Standard presets remain available when this patch is omitted.
- The fixtures use fixed dates. Mock writes remain local to each Session; no SaaS, full RAG, RBAC, arbitrary code execution or cross-Agent workflow is included.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
