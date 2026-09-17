# Agent Note: Platform resource namespaces independent of authentication

Status: implemented

English | [中文](2026-09-17-platform-resource-namespaces.zh.md)

## Problem

Directory Workspaces group local projects and Sessions. Platform resources need an independent stable identity that also governs reference resolution when no user login is present. A Tool can cross that boundary indirectly through its server or credential dependency.

## Decision

[PlatformWorkspaces](../../../../packages/business/agent-builder/src/platform-workspaces.ts) owns the existing governance Domain; optional Governance consumes the same owner. Demo records contain no fabricated members. Explicit operator bootstrap can provision their administrators without changing IDs or restoring removed governed members. Request-local workspace scope is distinct from authenticated principal. The Demo and governed portal are mutually exclusive deployments, and both require the existing closed-route WebServer policy.

The resource directory stores MCP Server, MemoryStore, Eval Dataset and credential-alias metadata alongside Model, Tool and Skill. Immutable references are checked at authoring and again during execution. Tool-to-server-to-credential resolution checks each owning workspace before side effects. Local entry keys include workspace and resource identity. Run admission copies its Agent's space; Trace validates stored attribution against Run. Existing field names and version hashes remain intact.

The Platform prepares bound tools before recovery and model execution, then registers native definitions in the Agent scope. Both schema assembly and dispatch enforce the immutable selection. The existing `dsh-mcp-client` owns transport, discovery, schema conversion and result presentation. Discovery imports a draft Tool with its complete description; publishing pins that description and server version. Server selection expands concrete published Tool references. New remote tools do not enlarge existing versions, and changed selected descriptions prevent execution.

Credentials resolve per operation. Each Run/server serializes short connections and closes them after discovery or invocation; cancellation also aborts preparation. HTTP and Host-approved stdio profiles use the same adapter. Only the Host owns commands, working directories and credential environment names. The Platform does not implement another Agent Loop or ToolRuntime. Existing Trace events gain Tool and MCP resource version identities.

## Alternatives considered

**Reusing directory Workspace IDs** confuses filesystem grouping with business ownership and makes directories an authority over resources.

**Enforcing namespaces only with login enabled** permits the Demo and internal callers to bypass reference checks. Namespace checks therefore precede optional role authorization.

**Serializing a credential-bearing mcp-client configuration in an AgentVersion Preset** persists secrets and prevents per-operation rotation. The platform resolves credentials into transient adapter configuration. Connection pooling is deferred: repeated connection and discovery cost is accepted in exchange for simple ownership, rotation and teardown.

## Consequences

This is application-level isolation on one writer. The namespace Demo is local and unauthenticated, not a substitute for membership authorization. Model routes remain explicitly bound workspace resources backed by Host-owned providers. The local Memory and Dataset adapters store bounded entries; they do not implement vector search or evaluation scoring. Legacy hand-authored MCP Tool resources require discovery and a new publication before execution. MCP protocol Resources and Prompts are outside this feature. Remote implementations remain outside immutable configuration guarantees.

## Verification

[Directory tests](../../../../packages/business/agent-builder/tests/platform-workspaces.spec.ts) cover persistence, retries, concurrent scopes and explicit governance adoption. [Runtime adapter tests](../../../../packages/business/agent-builder/tests/workspace-runtime.spec.ts) exercise real local storage and HTTP transport, credential rotation, cross-space rejection and corrupt persisted references without invoking a foreign provider. [Browser tests](../../../../apps/web/tests/platform-workspace.e2e.ts) boot the real Loader, create and switch namespaces without login, execute Memory through Harness, and verify fixed Run/Trace attribution. Existing governance, version, recovery and directory Workspace suites remain regression owners.

[Managed adapter tests](../../../../packages/mcp/mcp-client/tests/managed.spec.ts) verify descriptor drift, cancellation and credential refresh. [MCP browser acceptance](../../../../apps/web/tests/platform-mcp.e2e.ts) verifies simultaneous Workspace A/B schemas, rejected foreign dispatch, no expansion from new tools and Trace attribution. The adapter stdio fixture verifies a real child-process call; Redis and GitHub browser scenarios use local MCP test servers.
