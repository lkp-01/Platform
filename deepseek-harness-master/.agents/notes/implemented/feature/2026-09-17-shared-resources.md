# Agent Note: Shared resources for demo Agents

Status: implemented

English | [中文](2026-09-17-shared-resources.zh.md)

## Problem

Business Agent drafts select implementation-owned tool names and model routes. Teams need a shared directory that owns reusable configurations and their versions independently of any Agent.

## Decision

The AgentBuilder package owns an independent SharedResources storage class and Remote operations. Its Resources panel manages Model, Tool and instruction-only Skill drafts, immutable published versions, lifecycle and consumer queries. Exact references in Agent drafts become captured manifests in format-two Agent versions. Existing format-one hashes and rendering stay compatible. Resource publication never changes an Agent binding.

Model routes reuse installed providers and Host credentials; tools reuse business operations. Skills are literal, eagerly included system instructions recorded by the existing system-message path. The combined prompt uses the existing composition limit. Deployment and managed model/tool execution recheck availability without changing the Harness loop. Deprecated resources remain usable by existing references; disabled and archived resources cannot start new work. History remains readable.

## Alternatives considered

A separate package or service adds build and deployment wiring without another consumer in this demo. Keeping storage independent within AgentBuilder retains the lifecycle boundary. Static choices alone cannot publish versions or explain references. Mutable Skill directories cannot preserve an Agent version's instructions. Authentication and RBAC are deliberately excluded by the demo scope; Owner remains display metadata.

## Consequences

Resource versions capture configuration rather than external model weights or service implementation. The directory cannot install new adapters, manage MCP servers or Knowledge Sources, revoke already dispatched calls, or remove instructions from a model's context. Single-Host serialization and storage remain the persistence assumptions. Legacy editable configurations acquire references when saved through the Registry; historical executions are not assigned invented resource versions.

## Testing

[Resource tests](../../../../packages/business/agent-builder/tests/shared-resources.spec.ts) cover retry identity, publication, restart, exact binding and lifecycle. [Web tests](../../../../apps/web/tests/shared-resources.e2e.ts) use the shipped Loader composition and a keyless model to register and publish a Skill, select resources, retain v1 after publishing v2, query consumers, and reject disabled dependencies. Model-facing tool names and captured Skill content have an owner-local snapshot.
