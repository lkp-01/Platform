# Agent Note: Scoped Memory execution facts and governance

Status: implemented

English | [中文](2026-09-17-memory-platform.zh.md)

## Problem

Memory Items were durable and namespace-scoped, but operators could not govern them through the Platform API. Post-Run extraction also had no durable facts for the existing Trace projection, so completion after a Run ended was not visible in the task timeline.

## Decision

[PlatformMemory](../../../../packages/business/agent-builder/src/memory-store.ts) remains the only owner of Memory Items. [MemoryWriteback](../../../../packages/business/agent-builder/src/memory-writeback.ts) persists retrieval, extraction and write facts in `platform_memory_facts`; [PlatformTraces](../../../../packages/business/agent-builder/src/platform-traces.ts) projects those facts into the existing Run timeline. Trace facts carry store, scope, count, status and error code, but no Memory content or namespace subject.

The Platform API resolves the user, session and agent subject from authenticated principal, owned conversation or existing Agent. It exposes scoped item list/read, manual create/delete, explicit legacy-value import, and writeback status/retry. Legacy local KV values are never part of scoped retrieval; an administrator must select a source key and destination scope. The `/platform` editor exposes binding scopes and extraction settings, and the MemoryStore page exposes attributed items and legacy import.

## Alternatives considered

**A separate Memory tracing product** would duplicate Run execution records and leave post-Run work disconnected from the existing observability path.

**Letting callers provide an arbitrary namespace subject** would allow a known user or conversation ID to bypass scope isolation. The API derives the subject before accessing an Item.

**Automatically converting old KV data** would invent scope and source metadata. Explicit migration preserves the distinction between legacy data and new scoped Items.

## Consequences

Memory writeback does not change a successful Run into a failed Run. A configured embedding or extractor remains a Host-owned capability; without one, retrieval or writeback stays unavailable or degraded. The local provider is bounded exact cosine retrieval rather than an ANN service, and the feature remains single Host.

## Verification

[Memory writeback tests](../../../../packages/business/agent-builder/tests/memory-writeback.spec.ts) cover candidates, idempotent Item writes, failure retry and emitted facts. [Memory isolation tests](../../../../packages/business/agent-builder/tests/memory-store.spec.ts) and [retrieval tests](../../../../packages/business/agent-builder/tests/memory-retrieval.spec.ts) cover namespace isolation and vector filtering. The acceptance record is [memory-platform-acceptance.md](../../../../../docs/memory-platform-acceptance.md).
