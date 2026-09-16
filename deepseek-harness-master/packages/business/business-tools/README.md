---
description: "Local knowledge, sales analysis and simulated business operations for isolated Agents."
kind: "package-reference"
---

# @deepseek-ai/dsh-business-tools

English | [中文](README.zh.md)

## Summary

Answer customer questions from local policies, analyze a sales CSV through read-only SQLite, and create simulated operational records. Choose only the tool entry point required by a business preset. Returned records identify themselves as mock data. No external system is contacted.

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

<a id="use-this-package"></a>
## Use this package

Use the ready [business bundle](../../bundle/business-agents/README.md), which mounts the host projection and the correct tool entry points.

Mount `@deepseek-ai/dsh-business-tools` once on the host. Mount one subpath (`/customer-service`, `/data-analysis`, or `/operations`) inside each preset. Never mount the three tool entry points globally.

| Field | Default | Meaning |
|---|---|---|
| `enabledTools` | All tools in this entry | Register only selected tools; an empty array registers none |
| `fixturePath` | Package asset | Local JSON or fixed-column CSV |
| `maxResults` | 5 | Customer knowledge hits |
| `maxRecords` | 100 | Customer or operations records per Session |
| `businessDate` | Required | Operations reference date |
| `maxRows` | 100 | Data result row limit |
| `maxResultBytes` | 32768 | Complete data result byte limit |
| `queryTimeoutMs` | 3000 | Query worker deadline |

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

Tools register through official `ctx.tools` effects. The SQL helper process uses SQLite authorization, a fixed table, a function allowlist, row and byte limits, cancellation and termination. It cannot attach databases or execute writes. Numeric analysis supplies bounded sum, change and rate operations.

Simulated writes become ordinary `tool/result` metadata. The Session projection rebuilds business records from those committed events. Idempotency keys are scoped to Session and record kind; conflicting reuse fails. No second persistence log or Agent Loop exists.

See [source](src/index.ts), [query worker](runtime/query.mjs), and [query tests](tests/query.spec.ts). No runtime invariant companion is published: registered tools and projections use registry cleanup, while worker teardown is awaited on every query outcome.

The fixed Node helper communicates through IPC, inherits the official scrubbed environment, and exposes no command input. Timeout or cancellation kills the process and awaits its exit; this can stop synchronous native SQLite work.

</details>

<a id="model-experience"></a>
## Model Experience

### Scoped tools and results

#### What the model sees

The selected plugin exposes its tool names, argument schemas and descriptions. `knowledge_search` returns source identifiers; `sql_query` returns bounded rows and truncation status. Simulated write results include `mock: true`, a record id and business payload. Results use the normal JSON tool presentation.

#### Token effect

Each entry contributes only the selected schemas, with all three or four tools as its default. Query and preview results are bounded; other results depend on trusted fixture size. Committed results remain in session history until normal context management removes or compacts them.

#### KV Cache effect

Tool schemas remain stable during a Session. Tool results append task-specific context and do not rewrite earlier messages; changing the preset changes the schema prefix.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

The tool boundary is intentionally limited.

- Knowledge search matches local keywords; it is not vector retrieval. Replace the tool plugin to integrate real RAG.
- SQLite requires Node 24.12 or newer. The CSV has a fixed header and no quoted-field parser. Analysis exposes named numeric operations rather than arbitrary code.
- Isolation masks tools inherited at preset activation. Do not dynamically mount additional host-global tools in this deployment; this is not a multi-tenant authorization boundary.
- Tickets, tasks and messages are simulated, scoped to their Session and derived from committed tool results. No external delivery or durable cross-system transaction is provided.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
