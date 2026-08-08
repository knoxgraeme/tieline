# Provision a hosted database

The Tieline database is organization infrastructure shared across
repositories, not part of any one application. Keep every provider artifact
out of the repository: no provider project files, no `.env` entries, no
connection strings in any tracked or untracked repository file. The
repository records only `default_database_mode`; credentials live in
Tieline's private profile outside the checkout.

1. Consent first. Name the provider and plan (Neon's free tier unless the
   user chooses otherwise) and state that the project is created in the
   user's own Neon account. Do not create billable infrastructure without
   an explicit yes.
2. Check authentication with `npx -y neonctl me --output json`. If it
   fails, stop and ask the user to either run `npx -y neonctl auth` (it
   finishes in their browser) or provide `NEON_API_KEY`. Never work around
   missing authentication.
3. Create the project and capture the connection URI:

   ```sh
   npx -y neonctl projects create --name tieline-<repo_name> --output json
   ```

   Read `connection_uris[0].connection_uri` from the output. Treat it as a
   secret: never print it back and never write it into any repository file.
4. Run setup with the URI scoped to this single command:

   ```sh
   DATABASE_URL_ADMIN=<uri> npx -y tieline init . --yes --database existing --provision-roles
   ```

   `--provision-roles` assigns login credentials to the migration-created
   tieline roles so semantic matching and planning writes work immediately.
   Omit it only when the organization manages database login roles itself.
5. Verify with `npx -y tieline status --json`: `runtime.setup_complete`
   must be true and the capability flags should report semantic matching
   and planning writes configured. On any provider failure, report the
   error and continue in offline mode — the workspace stays fully usable.
6. Teammates connect without admin access: share the reader and planning
   writer URLs from this machine's private Tieline profile through the
   organization's secret manager, and each teammate sets `DATABASE_URL` and
   `DATABASE_URL_WRITE` in their environment.
