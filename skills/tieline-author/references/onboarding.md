# Semantic onboarding

Use this workflow only when `.tieline/spec/` has no YAML. Onboarding is the
first authoring pass, not a separate approval or handoff process.

## Set expectations first

Open with a short orientation before asking anything — the user just pasted
a prompt and may not know what Tieline is or what happens next. In one short
paragraph: Tieline maintains a living contract of the product's user Stories
and acceptance criteria, grounded in this repository's code and tests, and —
once a database is connected — carries requests from Observation to planning
Story to production behavior. Then
the plan: confirm a few detected settings, ask one or two questions, author
the initial capabilities, Stories, and ACs from repository evidence, and
finish with a browsable review page on a branch for normal pull-request
review. State plainly that nothing is accepted without their review — merge
is the approval. Keep it to that one paragraph, not a feature tour, and move
straight into the first confirmation.

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
3. Explain the model first, then ask — use this phrasing verbatim, only
   dropping an option the machine rules out (for example local without
   Docker):

   > Your `.tieline/` directory is the source of truth for what's in
   > production: capabilities, Stories, and acceptance criteria as YAML.
   > New Stories and changes to existing ones are managed through pull
   > requests. Beyond mapping production, Tieline can track Observations —
   > feature requests, ideas, bug reports — outside the repository in a
   > Postgres database, letting you follow a feature from request to
   > production. Production Stories sync to that database, and agents can
   > query it for planning, investigation, and research. Observations and
   > credentials never land in your repository.
   >
   > **Where should Tieline keep your Observations?**
   >
   > 1. **Start offline** — contract only for now; connect a database any
   >    time
   > 2. **Local Postgres** — the full planning loop on this machine, via
   >    Docker, no accounts
   > 3. **Connect an existing Postgres** — you provide `DATABASE_URL_ADMIN`
   > 4. **Provision a hosted Postgres** — a free-tier Neon project in your
   >    own account; needs a one-time browser approval

   Present offline as "start here, connect later", never as the whole
   product. Map the answers to commands:
   - Local: `npx -y tieline init . --yes --database local` (requires a
     running Docker daemon).
   - Existing: with `DATABASE_URL_ADMIN` in the environment, run
     `npx -y tieline init . --yes --database existing`.
   - Provision: follow [provisioning.md](provisioning.md) to create a Neon
     Postgres in the user's own account and connect it.
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
   manifest plus database-backed semantic matching when available.
6. Author the initial capabilities, Stories, and ACs under `.tieline/spec/`.
   Never create generic starter content merely to make the directory non-empty.
7. Validate and compile the contract.
8. Grade the initial contract with the tieline-grade skill. With no manifest
   at the comparison base, every authored link enters the grading scope as
   `link_added`. You authored every one of them, so dispatch fresh subagents
   batched by artifact path, passing only the emitted scope entries and never
   the authoring rationale; a link none of your reasoning can defend to a cold
   reader should be graded down, not argued for.
9. Close with the completion report shaped by
   [report.md](references/report.md): `.tieline/review.html` is the
   deliverable and leads the reply, followed by at most three
   needs-your-review bullets and two caveats. Do not enumerate the authored
   Stories or acceptance criteria inline — a full listing in chat is harder
   to review than the page. The detailed narrative (sources inspected,
   config corrections, link fixes, verification results) belongs in the
   pull-request body, not in chat.
