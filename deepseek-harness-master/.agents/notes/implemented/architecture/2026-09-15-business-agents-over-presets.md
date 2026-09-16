# Agent Note: Business Agents over official Presets

Status: implemented

English | [中文](2026-09-15-business-agents-over-presets.zh.md)

## Problem

Business teams need distinct personas and tools without duplicating the Harness Loop, Session lifecycle or model calls.

## Decision

Use the existing AgentPresets service as the registry and launcher. A preset directory is the Agent Definition: directory id, preset.yml metadata and agent.cordis.yml persona/tool composition. The optional business bundle supplies three definitions with one host model default. Existing Session model selection remains available.

Business writes use committed tool/result metadata and the existing Session projection. SQLite is a bounded read-only helper process over the fixture CSV. Browser menu choices create independent Sessions through the existing create API and retain Workspace membership.

This extends [per-session presets](2026-08-03-per-session-agent-presets.md); it does not replace their runtime ownership. Menu selection uses creation; Settings and Creator retain their existing staged-selection paths.

## Alternatives considered

- A second Registry/Factory and JSON schema duplicate official discovery and composition.
- A separate mutable mock database risks sharing records between standing preset instances and Sessions.
- Arbitrary Python or Shell execution adds an unnecessary security boundary for a fixed demonstration dataset.

## Consequences

A fourth Agent reuses the definition format and plugins; genuinely new tools still require a plugin. Tool isolation covers the configured deployment, not enterprise tenant authorization. Fixed-date fixtures and simulated writes keep demonstrations reproducible. Real provider acceptance requires a locally configured key.

## Testing

[Composition tests](../../../../packages/bundle/business-agents/tests/composition.spec.ts) exercise all three multi-step loops, tool denial and Session isolation. [Web tests](../../../../apps/web/tests/business-agents.e2e.ts) verify the roster, independent creation and editable composer. [Worker tests](../../../../packages/business/business-tools/tests/query.spec.ts) cover limits and cancellation.
