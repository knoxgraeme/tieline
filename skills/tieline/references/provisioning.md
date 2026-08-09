# Provision hosted database

The Tieline database is organization infrastructure shared across
repositories, not part of any one application. Keep every provider artifact
out of the repository: no provider project files, no `.env` entries, no
connection strings in any tracked or untracked repository file. The
repository records only `default_database_mode`; credentials live in
Tieline's private profile outside the checkout.

1. Choosing the provision option in the database question is the consent —
   its menu line already names the provider, the free tier, the user's own
   account, and the browser approval, so do not ask again. Anything beyond
   that scope needs its own explicit yes: a plan other than the free tier,
   or any other billable change.
2. Check authentication with `npx -y neonctl me --output json`. If it
   fails, stop and ask the user to either run `npx -y neonctl auth` (it
   finishes in their browser) or provide `NEON_API_KEY`. Never work around
   missing authentication.
3. Resolve the organization before creating anything:

   ```sh
   npx -y neonctl orgs list --output json
   ```

   Read each organization's `id` and `name` from the output. If there is
   exactly one organization, select it automatically and pass its ID with
   `--org-id`. If there is more than one, show only the names and IDs and ask
   the user which organization should own the project. This is a required
   ownership boundary, not a second provisioning confirmation. Do not treat
   multiple organizations as a provider failure, choose one heuristically, or
   change the user's global Neon context. If no organization is available,
   report that result and continue in offline mode; never create an
   organization without explicit consent.
4. Create the project in the resolved organization and capture the connection
   URI:

   ```sh
   npx -y neonctl projects create --name tieline-<repo_name> --org-id <org_id> --output json
   ```

   Read `connection_uris[0].connection_uri` from the output. Treat it as a
   secret: never print it back and never write it into any repository file.
5. Run setup with the URI scoped to this single command:

   ```sh
   DATABASE_URL_ADMIN=<uri> npx -y tieline@latest init . --yes --database existing --provision-roles
   ```

   `--provision-roles` assigns login credentials to the migration-created
   tieline roles so semantic matching and planning writes work immediately.
   Omit it only when the organization manages database login roles itself.
   Run it at most once per database: re-running rotates the generated
   passwords and invalidates the credentials every other clone's profile
   already holds.
6. Verify with `npx -y tieline status --json`: `runtime.setup_complete`
   must be true and the capability flags should report semantic matching
   and planning writes configured. On any provider failure, report the
   error and continue in offline mode — the workspace stays fully usable.
7. If others work in this repository, they connect without admin access:
   share the reader and planning writer URLs from this machine's private
   Tieline profile through a secret manager, and each person sets
   `DATABASE_URL` and `DATABASE_URL_WRITE` in their environment. A solo
   user needs none of this — the profile on this machine already holds
   everything.
