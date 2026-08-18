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
   - Local:
     `npx -y tieline@latest init . --yes --skip-skill-install --database local`
     (requires a running Docker daemon).
   - Existing: with `DATABASE_URL_ADMIN` in the environment, run
     `npx -y tieline@latest init . --yes --skip-skill-install --database existing`.
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

Optimize this first pass for maximum coherent, accurate coverage of the
repository's observable behavior. "Initial" means the first repository-wide
semantic baseline, not the smallest valid seed. There is no default Story or
AC count and no brevity target: let evidence-backed behavior determine the
size, while avoiding duplicate or speculative definitions.

1. Map the repository before defining capabilities. Assess every configured
   source root and each discovered application, service, worker, CLI, and
   shared package boundary. Use workspace and package metadata to find them;
   then inspect their README and architecture documentation, public entry
   points, UI routes, APIs, commands and tools, events, scheduled jobs,
   deployment surfaces, schemas and migrations, and tests. A shared package is
   in semantic scope when it exposes observable behavior or enforces a product
   invariant across applications. Discover these repository sources directly
   instead of asking the user to enumerate them.
2. Build a working coverage ledger for every assessed boundary. Record its
   actors, public interfaces, coherent behavior clusters, strongest evidence
   paths, and a disposition of `cover`, `exclude` with a reason, or
   `unresolved`. Keep discovery in bounded passes so repository size or context
   pressure does not silently narrow the scope.
3. Treat configured sources according to `.tieline/config.json`: use inline
   descriptions as product framing, read local files, and fetch websites only
   when `allow_external_fetch` is `true`. Record which sources were actually
   inspected and which were unavailable.
4. Infer repository-specific capability boundaries, actors, user goals,
   benefits, observable behavior, and existing terminology. Triangulate product
   documentation, public interfaces, schemas, and tests when possible.
   Repeated evidence increases confidence but is not a prerequisite for
   inclusion when one authoritative repository source clearly establishes an
   observable outcome.
5. Cover the whole product surface, not only its primary end-user path. Include
   distinct admin, operator, seller, developer, and machine actors when the
   repository supports them, plus cross-cutting behavior such as identity and
   tenancy, billing and usage, validation and cryptography, persistence
   invariants, scheduling and delivery, and observability when repository
   evidence makes those outcomes part of the product contract. Group by user
   or business outcome rather than mirroring the directory tree.
6. Ask focused questions only when unresolved product meaning would materially
   change a capability boundary or acceptance criterion. Do not ask for context
   that can be discovered from the repository.
7. Search for likely duplicate IDs and behavior using the local YAML and
   manifest plus database-backed semantic matching when available.
8. Author the initial capabilities, Stories, and ACs under `.tieline/spec/`.
   Give each AC one observable outcome. Do not compress independent behaviors
   into a few broad ACs to keep the contract small, and never create generic
   starter content merely to make the directory non-empty.
9. Audit semantic coverage before completion. Reconcile every coverage-ledger
   row with the authored contract: each high-confidence behavior cluster must
   be represented by a Story and AC or have an explicit exclusion reason, and
   every application boundary must have been assessed. Compare the result back
   to the discovered public interfaces, tests, and cross-cutting invariants. A
   small contract for a large or multi-application repository is a reassessment
   signal, not proof that only a small product spine matters; run another
   discovery pass until no known high-confidence behavior remains unrepresented
   or unexplained.
10. Use repository mapping coverage only as a diagnostic for possible missed
    surfaces. It is not a proxy for semantic completeness: do not create an AC
    per file or chase 100 percent path coverage, but investigate concentrated
    unmapped areas before declaring the baseline complete.
11. Validate and compile the contract, then compile and validate the repository
    topology:

    ```sh
    tieline contract validate .
    tieline contract compile .
    tieline code compile . --json
    tieline code validate . --json
    ```

    Review and include the generated `.tieline/topology/graph.json` in the
    onboarding pull request.
12. Read [grading.md](grading.md) and grade the initial contract. With no manifest
   at the comparison base, every authored link enters the grading scope as
   `link_added`. You authored every one of them, so dispatch fresh subagents
   batched by artifact path, passing only the emitted scope entries and never
   the authoring rationale; a link none of your reasoning can defend to a cold
   reader should be graded down, not argued for.
13. Close with the completion report shaped by
   [report.md](references/report.md): `.tieline/review.html` is the
   deliverable and leads the reply, followed by at most three
   needs-your-review bullets and two caveats. Do not enumerate the authored
   Stories or acceptance criteria inline — a full listing in chat is harder
   to review than the page. The detailed narrative (sources inspected,
   config corrections, link fixes, verification results) belongs in the
   pull-request body, not in chat.
