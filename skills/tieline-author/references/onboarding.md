# Semantic onboarding

Use this workflow only when `.tieline/spec/` has no YAML. Onboarding is the
first authoring pass, not a separate approval or handoff process.

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
7. Validate and compile the contract, then summarize the sources used,
   inferred semantic boundaries, likely duplicates, mapping gaps, and proposed
   contract changes for normal pull-request review.
