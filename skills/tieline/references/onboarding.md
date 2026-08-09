# Semantic onboarding

Use this workflow only when `.tieline/spec/` has no YAML. Onboarding is the
first authoring pass, not a separate approval or handoff process.

## Set expectations first

The orientation is the first visible thing that happens: send it before
reading repository files or running commands, and do not narrate loading
the skill or inspecting configuration first. Use this script verbatim:

> Great — let's get you set up with Tieline.
>
> Tieline builds a structured graph of your product's user Stories and
> acceptance criteria, grounded in this codebase. The production source of
> truth lives in this repository at `.tieline/` — after we create the
> initial Stories today, future features and updates ship through normal
> pull requests. Tieline can also track Observations — feature requests,
> ideas, and bugs — stored outside the repository in a Postgres database
> your agents can query, with your production Stories synced alongside so
> you can follow a feature from request to production.
>
> Next: a few quick setup questions, then I'll kick off the initial Story
> generation.

Do not expand the script into a feature tour; move straight into the first
confirmation. The trust anchor — nothing is accepted without review; merge
is the approval — belongs at the end, when opening the pull request, not
here.

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
3. The orientation already explained the model, so ask directly — use this
   phrasing verbatim, only dropping an option the machine rules out (for
   example local without Docker):

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
   - Local: `npx -y tieline@latest init . --yes --database local` (requires a
     running Docker daemon).
   - Existing: with `DATABASE_URL_ADMIN` in the environment, run
     `npx -y tieline@latest init . --yes --database existing`.
   - Provision: follow [provisioning.md](provisioning.md) to create a Neon
     Postgres in the user's own account and connect it.
4. Do not ask whether to install or pin the Tieline CLI in the repository.
   Setup runs through `npx` and does not modify the application's dependency
   manifest or lockfile.
5. Close the conversation with a handoff so the coming silence is expected:
   setup is complete, the rest runs without input, and the next thing the
   user sees is the completion report with the review page. Everything after
   this point is autonomous — do not ask further questions unless unresolved
   product meaning materially changes a capability boundary.

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
8. Read [grading.md](grading.md) and grade the initial contract. With no manifest
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
