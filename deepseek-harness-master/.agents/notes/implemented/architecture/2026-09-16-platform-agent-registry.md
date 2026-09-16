# Agent Note: Platform Agent resource ownership

Status: implemented

English | [中文](2026-09-16-platform-agent-registry.zh.md)

## Problem

Immutable execution Presets cannot represent a long-lived resource whose owner, description and draft change independently of past Sessions.

## Decision

The [Registry](../../../../packages/business/agent-builder/README.md#resource-registry) owns resource identity, metadata, current draft and archival state in a Storage Domain. Its existing authoring package supplies transport and catalogs; a separate UI panel supplies resource navigation. Single-writer creation and Domain updates provide retry deduplication and optimistic edit locking.

The [Preset authoring decision](2026-09-16-self-service-agent-authoring.md) remains the execution adapter contract. A resource draft never rewrites an executable Preset. Legacy imports retain identity and initial creation fingerprints. New drafts have no published version or deployment; Version, Runtime and Deployment own those facts.

## Alternatives considered

**Mutable Presets** would let resource edits alter historical Session restoration. Independent drafts preserve execution configuration.

**Separate Registry and API packages** would repeat existing catalog and transport assembly without another current consumer. Dedicated modules inside the authoring package separate responsibilities with fewer build changes.

**Mandatory SQLite** is unnecessary because the existing Domain supports JSON and SQLite. The deployment retains backend routing authority.

## Consequences

Shared Host configuration supplies organization and owner references, not authenticated tenant membership. Multiple writing Hosts are unsupported. Registry CRUD does not call models or tools. Archival preserves history and blocks new legacy Session creation through the Session Controller hook; trusted direct in-process Harness composition remains outside platform authorization.

## Testing

[Registry tests](../../../../packages/business/agent-builder/tests/registry.spec.ts) cover persistence, retries, edit conflicts, workspace boundaries and archival. [Web tests](../../../../apps/web/tests/agent-registry.e2e.ts) exercise real composition, transport, draft conflicts and deep-link recovery.
