# Setup and configuration

[README](../README.md) · **Setup** · [Concepts](concepts.md) · [CLI](cli.md) · [MCP](mcp.md) · [Operations](operations.md)

## Requirements

- Node.js 20.12 or newer.
- Docker with a running daemon when using `--database local`.
- A hosted or remote PostgreSQL 16 database with pgvector when using `--database existing`.
- Embeddings are optional. An OpenAI-compatible provider, Supabase Edge Function, or the
  optional local runtime adds vector similarity; full-text and identifier search remain
  available without one.

## Installation

No install is required. Bootstrap with the current published CLI:

```bash
npx -y tieline@latest init
```

This does not add Tieline to the application's dependencies or modify its lockfile. After
setup, commands can run through `npx -y tieline@latest <command>`. Registered MCP
configuration pins the exact package version that performed initialization.

A global install also works when a bare `tieline` command is preferred:

```bash
npm install --global tieline
tieline --help
```

## Initialize and onboard a repository

Run init from the repository. It auto-detects the product name, repository name, and code
scope, defaults the runtime to offline, and asks one question: which coding agents should
receive the onboarding skill. Agents for which the repository already contains markers
(`.claude/`, `.agents/`, `.cursor/`, and similar) arrive preselected. A Claude Code session is
also detected directly; other agents should be selected in the prompt when no repository marker
exists. Selecting the agents is the confirmation — init applies the setup immediately rather
than repeating detected defaults in a second review screen.

Everything else (product description, context sources, database upgrades) is gathered
conversationally by the agent during semantic onboarding, where it can read the repository
first and verify instead of interrogate.

```bash
cd /path/to/product-repository
npx -y tieline@latest init
```

Restart or reload the selected agent, then ask it to use the installed `tieline` skill to begin onboarding. That invocation is the semantic-onboarding
handoff.

### Prompt-free setup

```bash
npx -y tieline@latest init /path/to/product-repository \
  --database offline \
  --embedding local \
  --description "A concise description of the product and business" \
  --context docs/product-context.md \
  --skip-skill-install \
  --yes
```

Prompt-free setup requires at least one explicit `--agent`, or `--skip-skill-install` when
no agent should receive the skill. `--skill-scope` defaults to `project`. To initialize for
multiple agents:

```bash
npx -y tieline@latest init /path/to/product-repository \
  --database offline \
  --embedding local \
  --yes \
  --agent codex \
  --agent claude-code \
  --skill-scope project
```

### Product context

Interactive init does not ask for a product description or context inventory; the installed
`tieline` skill discovers README, product documentation, public code entry points, and tests
during semantic onboarding. Automation can still provide known product framing with
`--description`.

Additional context sources are optional and explicit: provide each one with a repeatable
`--context` flag. A local source must already exist in the repository; a website must use an
explicit `http://` or `https://` URL. Init records local sources by repository-relative
location rather than generating or copying them.

A durable product-context file can hold business purpose, actors, domain terms, invariants,
and glossary entries. It should describe the business — not ideas, feature requests, or a
second backlog.

### Code scope

Tieline auto-detects the code directories used for mapping coverage and records them as the
**code scope** — for example, `apps` and `packages`. Most users do not need to configure
this. Use a repeatable `--source-root` only when the repository uses code directories
Tieline did not detect. The stored configuration name is `repository.source_roots`.

## Database modes

| Mode | Behavior |
| --- | --- |
| `offline` | Writes the workspace and supports local YAML/manifest authoring. Observations, Backlog Items, planning Stories, and semantic matching need a database. |
| `local` | Creates or reuses a dedicated Docker PostgreSQL + pgvector database and stores clone-local credentials privately. |
| `existing` | Connects a hosted or remote Postgres 16 + pgvector database identified by `DATABASE_URL_ADMIN`; no Docker container required. |

In `existing` mode, the baseline defines the least-privilege roles as `NOLOGIN`. Before
init, provide URLs for operator-managed login roles that inherit `tieline_reader`,
`tieline_planning_writer`, and `tieline_repository_sync`. Init does not create or rotate
passwords unless `--provision-roles` explicitly asks it to. That flag assigns generated login
passwords to the Tieline roles directly, which is how the agent-driven provisioning path (a
freshly created Neon project, for example) reaches a working setup from `DATABASE_URL_ADMIN`
alone.

Tieline is provider-neutral: a local Postgres installation, Neon, Supabase, RDS, or any other
managed Postgres with pgvector enabled works. It reads `DATABASE_URL_ADMIN` from the
environment or a local `.env`; credentials are never accepted as CLI arguments. Provisioning
tools that synchronize `.env` files are picked up automatically.

## Post-merge contract sync

Postgres is a searchable projection of the accepted `main` contract, not an authority for it.
Configure a protected post-merge job to run against the merged checkout with the repository-sync
credential:

```bash
DATABASE_URL_SYNC=postgresql://... \
  npx -y tieline@latest contract sync . \
  --expected-previous-commit <previous-main-sha>
```

Run this only after merges to `main`, never from a pull-request job. The checkpoint makes delayed
jobs safe: a job whose expected previous commit is no longer current cannot overwrite a newer
projection. Give this publisher `DATABASE_URL_SYNC`; MCP runtime processes receive only
`DATABASE_URL` and `DATABASE_URL_WRITE`, not sync or admin credentials. See the
[CLI post-merge sync reference](cli.md#post-merge-sync) and [Operations](operations.md) for the
credential boundaries.

## Embeddings

Choose one provider:

| Provider | Configuration |
| --- | --- |
| `local` | Keeps text local; install the optional runtime during init with `--install-local-embedder` |
| `openai` | Set `EMBEDDING_BASE_URL` and `EMBEDDING_API_KEY`; the endpoint must return 384-dimensional vectors |
| `supabase-edge` | Set `SUPABASE_URL` and `SUPABASE_ANON_KEY` |
| `hash` | Deterministic development/test provider. Do not use for semantic quality. |

`--embedding hash` is not offered during interactive onboarding. For a real deployment,
choose `local`, `openai`, or `supabase-edge`.

When Tieline is already initialized, rerun init with `--embedding local
--install-local-embedder` to install the local runtime in Tieline's private runtime
directory. Container builds can instead use `--build-arg WITH_LOCAL_EMBEDDER=true`.

Remote embedding providers receive canonical semantic text or the caller's query — not raw
Observation payloads, external URLs, audit metadata, lifecycle metadata, or repository
locators.

## What init writes

Init writes shared product identity, configured context, code scope, contract paths, and
runtime defaults to `.tieline/config.json`.

It also writes `.tieline/review.html`, a self-contained page for browsing the authored
capabilities, Stories, and Acceptance Criteria in a browser instead of raw YAML. `tieline
contract compile` regenerates it whenever the contract changes, and a nested
`.tieline/.gitignore` keeps the derived page out of commits.

Clone-local setup state and credentials live in private configuration outside the repository, so
a new clone completes its own runtime setup instead of inheriting another machine's "ready"
state.

## Agent and MCP registration

Init registers the `tieline` MCP server with each selected coding agent. `.mcp.json` at the
repository root is always created or updated, and Claude Code and compatible hosts load it
automatically on the next session. Selecting Cursor, GitHub Copilot, Gemini CLI, or OpenCode
additionally maintains `.cursor/mcp.json`, `.vscode/mcp.json`, `.gemini/settings.json`, or
`opencode.json`. Unrelated server entries in those files are preserved, and a file that fails
to parse is left untouched and reported instead.

Codex keeps MCP configuration in a global `~/.codex/config.toml`, so selecting Codex runs
`codex mcp add` with the absolute repository path. If the Codex CLI is unavailable, init
prints the exact command to run later.

| `--agent` ID | Coding agent |
| --- | --- |
| `claude-code` | Claude Code |
| `codex` | Codex |
| `cursor` | Cursor |
| `gemini-cli` | Gemini CLI |
| `github-copilot` | GitHub Copilot |
| `opencode` | OpenCode |
| `windsurf` | Windsurf |

Choose `project` to install for this repository or `global` to install for the current user.
Project scope is the interactive default. Cancelling agent selection stops initialization
before anything is written. Headless callers can use `--skip-skill-install` to suppress
installation.

Project-scoped setup delegates skill installation without adding either Tieline or its installer
to the application dependencies. If an installation fails, the initialized workspace and private
runtime configuration remain available and init prints a retry command:

```bash
npx -y tieline@latest init . --yes --agent codex --skill-scope project
```

### Version pinning

The MCP server is registered with the exact Tieline version that ran `init`, so hosts use the
same published package without requiring a global install or silently changing versions.
Rerun `npx -y tieline@latest init .` to upgrade repository-local pins; repeat any `--agent`
options for hosts configured outside the repository.

The checked-in configs keep `TIELINE_WORKSPACE` at `"."`, which resolves against the host's
working directory. Hosts that keep MCP configuration outside the repository and have no
registration CLI (Claude Desktop, Windsurf) need a manual entry with the same exact version
and the absolute repository path:

```json
{
  "mcpServers": {
    "tieline": {
      "command": "npx",
      "args": ["-y", "tieline@<installed-version>", "serve"],
      "env": { "TIELINE_WORKSPACE": "/absolute/path/to/repository" }
    }
  }
}
```

## Start onboarding

An empty `.tieline/spec/` immediately after init is intentional: initialization configures the
workspace but does not invent generic capabilities. Restart the selected agent and run `$tieline`
in Codex, `/tieline` in slash-command agents, or ask another supported agent to use the installed
Tieline skill.

The skill reads the configured context and repository, builds a coverage ledger, and writes the
justified Capabilities, Stories, ACs, and evidence links for review. It also performs semantic
closeout as implementation changes: it can add newly introduced behavior, update existing
definitions, reconcile links, grade changed claims, and regenerate the manifest. It refreshes
topology when relevant source or resolver changes require it. The resulting
pull-request diff remains the review and acceptance surface.

While the spec has no Stories, `npx -y tieline@latest status --json` reports that onboarding is
required and includes the skill invocation. Open `.tieline/review.html` after onboarding to review
the contract as cards, then follow [How the contract stays current](../README.md#how-the-contract-stays-current)
to add the CI check.

For the contract lifecycle and assurance boundaries, read [Concepts](concepts.md). For individual
commands, read the [CLI reference](cli.md).
