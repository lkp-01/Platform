# Agent Note: Self-service business Agent authoring

Status: implemented

English | [中文](2026-09-16-self-service-agent-authoring.zh.md)

## Problem

Business users need to create reusable Agents without editing executable Cordis configuration or changing the shared execution loop. A selected model must apply before the first request without changing other Agents' defaults.

## Decision

This decision governs the immutable execution adapter. The [platform Registry decision](2026-09-16-platform-agent-registry.md) owns editable resource drafts independently of these Presets.

The [authoring service](../../../../packages/business/agent-builder/README.md) accepts only business fields and publishes immutable Preset directories. A UUID submission token derives the directory identity; complete-directory publication makes retries and concurrent requests converge. The existing Preset registry discovers and mounts the result. Managed definitions are system-owned so generic file-edit and delete actions cannot break saved identities.

The scoped prompt plugin supplies literal user text through a non-recursive variable substitution. Business tool plugins register only configured subsets and preserve their full defaults when omitted. A dispatch guard refuses unselected tools, including direct calls.

Session Controller provides an initial-model waterfall only on the new-Session path. The platform listener resolves the Preset's saved model; the controller validates it and appends its existing model/selection event during setup. All creation entry points share this behavior. Resume and adoption retain recorded state, and no global default write occurs during initialization.

## Alternatives considered

- A database plus generated Presets introduces two configuration representations before multi-instance deployment requires them.
- Calling the existing model-switch command during startup writes the Host default and lets separate Agents affect each other.
- Initializing models only in the new form misses existing selection and default-creation paths.

## Consequences

Create Agent saves a reusable definition without a model call; Start Chat creates a normal Harness Session. Definition editing, deletion, memory configuration and tenant permissions remain outside this UI. Models must already appear in the configured catalog. Template-based copies provide iteration while history retains its original Preset identity.

## Testing

[Authoring tests](../../../../packages/business/agent-builder/tests/authoring.spec.ts) cover atomic retries and invalid configuration. [Composition tests](../../../../packages/bundle/business-agents/tests/composition.spec.ts) exercise generated Presets and distinct model routes through the official Loop. [Browser tests](../../../../apps/web/tests/agent-builder.e2e.ts) cover the form, reload and configured Session creation.
