# Semantic onboarding

Use this workflow only when `.tieline/spec/` has no YAML. Onboarding is the
first authoring pass, not a separate approval or handoff process.

## Gather and verify configuration

Init writes auto-detected values without asking questions; this phase is where
a human first sees them. Verify, do not re-ask.

1. Present the detected `product.name` and `product.repo_name` from
   `.tieline/config.json` for confirmation. If either is wrong, edit the file
   directly. `repo_name` is the stable cross-repository identifier, so correct
   it only before contract records exist.
2. If no `description` context source exists, synthesize a short product
   description from the README and repository context, confirm the wording
   with the user, and record it in `.tieline/config.json` under
   `context.sources` as
   `{ "id": "source-<n>", "type": "description", "location": null, "content": "<text>", "allow_external_fetch": false }`.
3. Ask at most one setup question: stay in the default offline mode, or
   connect PostgreSQL now. On request run
   `npx -y tieline init . --yes --database local` (Docker) or
   `npx -y tieline init . --yes --database existing` (hosted; requires
   `DATABASE_URL_ADMIN` in the environment). Offline is a complete answer for
   repository-local authoring — do not present it as a degraded mode.
4. In a repository with a `package.json`, offer to pin the CLI with
   `npm install --save-dev tieline` so the team shares one version and
   `npx tieline` resolves locally. Skip this for non-Node repositories; `npx`
   alone is sufficient.

## Author the initial contract

1. Build a context inventory from the configured sources, README, product and
   architecture documentation, public code entry points, source-root package
   metadata, and tests. Discover these repository sources directly instead of
   asking the user to enumerate them.
2. Treat configured sources according to `.tieline/config.json`: use inline
   descriptions as product framing, read local files, and fetch websites only
   when `allow_external_fetch` is `true`. Record which sources were actually
   inspected and which were unavailable.
3. Infer repository-specific capability boundaries, actors, user goals,
   benefits, observable behavior, and existing terminology. Prefer evidence
   repeated across product documentation, public interfaces, and tests.
4. Ask focused questions only when unresolved product meaning would materially
   change a capability boundary or acceptance criterion. Do not ask for context
   that can be discovered from the repository.
5. Search for likely duplicate IDs and behavior using the local YAML and
   manifest plus organization-wide semantic matching when available.
6. Author the initial capabilities, Stories, and ACs under `.tieline/spec/`.
   Never create generic starter content merely to make the directory non-empty.
7. Validate and compile the contract.
8. Grade the initial contract with the tieline-grade skill. With no manifest
   at the comparison base, every authored link enters the grading scope as
   `link_added`. You authored every one of them, so dispatch fresh subagents
   batched by artifact path, passing only the emitted scope entries and never
   the authoring rationale; a link none of your reasoning can defend to a cold
   reader should be graded down, not argued for.
9. Deliver the result as `.tieline/review.html`: tell the user to open it in
   a browser (compiling refreshed it) to review the authored capabilities,
   Stories, and ACs. Do not enumerate the authored Stories or acceptance
   criteria inline — a full listing in chat is harder to review than the
   page. Keep the reply at the capability level: counts, a one-line boundary
   per capability, sources used, likely duplicates, mapping gaps, and grade
   findings.
