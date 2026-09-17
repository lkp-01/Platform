# Agent Note: Immutable Agent versions and execution attribution

Status: implemented

English | [中文](2026-09-16-agent-version-execution.zh.md)

## Problem

Mutable Registry drafts cannot identify historical execution configuration or support rollback. A version label alone is misleading if the Session can switch models or resolve a newly deployed configuration while running.

## Decision

The [authoring package](../../../../packages/business/agent-builder/README.md) contains separate Version, Deployment and minimal Runtime modules. Version records capture a complete supported business configuration and source revision. Per-Agent serialized commits allocate sequence numbers and persist retry receipts together. Deployment preparation validates and mounts an immutable version Preset before atomically recording the new default and activation history. Rollback uses the same operation.

Run admission fixes the version and persists its identity before invoking the existing Session Controller and Harness Loop. One Run owns one Session and one submitted task. The Session log carries `platform/run` attribution alongside the original execution events; the Runtime persists lifecycle summaries from durable turn endings, not the current deployment. Queries read those summaries. Accepted requests are never automatically resubmitted after process loss.

Session API authorization runs before new composition publication, model changes, prompts and forks. Preset authorization runs before selection, Remote copying and removal. These extension points let the platform enforce immutable managed execution without changing the Agent Loop or ordinary Session behavior. A scoped request listener supplies captured model parameters. The Web composer uses its existing chain extension to present versioned Runs as read-only execution records.

## Alternatives considered

**Mutable execution paths** cannot preserve concurrent old and new configurations. Each saved version has its own Preset directory.

**Only storing a version field on a Session** does not represent task admission, idempotency or failed startup. Runtime stores those task facts separately and references the shared Session event history.

**New services and a transactional database** add deployment cost without a multi-writer requirement. Existing Storage Domains and per-Agent serialization support the current single-Host scope; growing aggregate records and multiple writers require a later repository design.

## Consequences

Saving, activation and execution are distinct actions. Legacy Sessions remain unversioned. Historical snapshots remain readable when dependencies are unavailable; activation fails without changing the previous deployment. Host prompt contributions, executable plugin implementations, external memory and remote model/tool services are not frozen by this configuration snapshot. Actual request headers and messages remain the execution evidence. The shared-host actor and workspace are not enterprise identity or tenant authorization.

## Testing

[Storage tests](../../../../packages/business/agent-builder/tests/versions.spec.ts) exercise concurrency, deduplication, restart, rollback and artifact integrity. [Loader integration](../../../../packages/bundle/business-agents/tests/composition.spec.ts) holds one Run open during rollback and asserts the actual model, Prompt and tools for both versions. [Web acceptance](../../../../apps/web/tests/agent-version.e2e.ts) covers the user flow, a keyless model-request snapshot and cold Run attribution after Host restart.
