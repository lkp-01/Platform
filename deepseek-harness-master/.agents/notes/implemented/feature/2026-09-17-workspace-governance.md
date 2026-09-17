# Agent Note: Workspace governance around the Harness runtime

Status: implemented

English | [中文](2026-09-17-workspace-governance.zh.md)

## Problem

Shared-host ownership labels cannot distinguish authenticated collaborators, and filesystem workspaces cannot authorize Agent, resource or Run access. The general Host interface also exposes Session and administrative paths that bypass a business-only permission check.

## Decision

AgentBuilder owns opt-in governance with operator-provisioned identities, durable workspace memberships and three fixed roles. Request-local identity supplies audit attribution; permission checks use current membership. The existing Registry, resource storage and Runtime retain their persistence domains and execution responsibilities. Startup checks existing references without rewriting immutable versions. Per-workspace developers collaborate on all Agents, while ordinary members invoke deployed Agents and see their own result projection.

A separate governed portal exposes an explicit allowlist over the same AgentBuilder use cases. The generic WebServer gains one optional deployment access policy and a required-policy setting that refuses traffic before policy installation and after disposal. Existing route registration and the Connection's Host-token check cannot close every fallback, file and upgrade route while carrying a user identity; this is the reason for the transport extension. Workspace policy remains outside WebServer, and the Agent Loop is unchanged.

The portal disables raw Host routes and WebSocket upgrades. Its requests validate origin, session identity, membership, operation permission, resource scope and wire input. User credentials are independently generated random values; only digests and expiring browser sessions persist. Login replaces a prior session for the same user. User deactivation and credential rotation invalidate sessions on configuration reload. Queue dispatch, model steps, tools and recovery check current Run authority, without changing the original creator or erasing uncertain external outcomes.

## Alternatives considered

Filtering only the existing UI leaves raw Session and administrative routes accessible. Retrofitting every general-purpose Host feature with tenant semantics broadens the initial feature beyond Workspace and fixed roles. Separate processes or databases per workspace provide stronger physical isolation but add operations work. The governed portal keeps that boundary explicit and leaves the single-user Host interface available when governance is not enabled.

## Consequences

This is application-level isolation on one writer, not an OS sandbox or enterprise IAM. Administrators consume installed model and business-tool adapters; workspace registration does not install code or authorize unrestricted filesystem access. Shared underlying adapters remain operator-owned. In-flight remote calls cannot be retracted. The portal polls authorized Run queries rather than forwarding global events. Workspace setup is operator-owned; member and resource management is workspace-owned.

Membership mutations and their audit entries share one durable workspace record. Successful business mutations append governance audit afterward; audit failure can leave the business mutation committed, so clients retain the original idempotency token when retrying. There is no second execution recorder. Historical shared-host tasks retain their original identity and cannot resume under an arbitrary administrator.

## Verification

[Governance tests](../../../../packages/business/agent-builder/tests/governance.spec.ts) cover credential invalidation, role isolation, removed bootstrap members, membership revision reuse and concurrent last-administrator protection. [Ownership tests](../../../../packages/business/agent-builder/tests/workspace-isolation.spec.ts) preserve legacy identities, hashes and deployments while rejecting foreign resources. [Runtime tests](../../../../packages/business/agent-builder/tests/runtime-recovery.spec.ts) deny recovery and external retries after permission revocation. [WebServer tests](../../../../packages/host/webserver/tests/webserver.spec.ts) exercise required-policy startup, upgrade refusal and disposal through the real Loader. [Browser tests](../../../../apps/web/tests/workspace-governance.e2e.ts) use the full Web composition, independent user credentials, real APIs and browser role journeys, including workspace switching and Agent creation.
