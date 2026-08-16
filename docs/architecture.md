# Architecture

[README](../README.md) · [Setup](setup.md) · [Concepts](concepts.md) · [CLI](cli.md) · [MCP](mcp.md) · [Testing](testing.md) · **Architecture** · [Operations](operations.md)

Tieline keeps accepted product intent in repository-owned YAML and derived artifacts, while optional Postgres provides operational projections and planning state. The production code is organized around these boundaries:

| Area | Responsibility |
| --- | --- |
| `src/domain/` | Domain types, policies, and store interfaces. |
| `src/contract/` | Authored-contract parsing, validation, manifests, evidence, and code-topology analysis. |
| `src/commands/` | CLI-use-case orchestration such as compile, check, sync, and topology operations. |
| `src/adapters/` | Concrete infrastructure integrations, primarily Postgres repositories. |
| `src/tools/` | MCP tool handlers and their capability-local input/output schemas. |
| `src/stdio.ts`, `src/http.ts`, and `src/server.ts` | Transport and server construction; they expose tools without owning domain policy. |
| `src/cli.ts` and `src/tieline/` | Command-line entry points and workspace/setup lifecycle. |
| `src/derived/` | Derived projections such as embedding documents. |

Callers enter through the CLI or MCP transports. Commands and tools validate untrusted input at their boundary, invoke contract/domain behavior, and use adapters only for infrastructure. The contract compiler writes reviewed derived artifacts; topology reads consume the committed snapshot rather than repairing it at request time.

## Test code is not a production adapter

`tests/support/` and `tests/support/fakes/` contain harnesses, fakes, and test doubles. They model dependency behavior for deterministic tests, but are not production adapters and must not be imported by production code. Test fixtures likewise describe controlled inputs, not runtime integrations.

## Dependency direction

Production boundaries should remain legible: transports/tools and commands orchestrate domain and contract behavior; adapters implement infrastructure-facing needs. Avoid making domain policy depend on transport concerns, test helpers, or a particular database implementation.
