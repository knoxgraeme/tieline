# Hosted screens storage

Read this only when the user asks for hosted screens, or the repository's
`.tieline/config.json` enables `screens.hosted`. Read
[provisioning.md](provisioning.md) first: its consent, authentication, and
organization rules apply here too.

This adds an object storage bucket and the credentials hosted screens use.
Never print a secret, read one back into the conversation, or ask the user
to paste one: secrets go into a private file outside the repository, and
the user copies them to where they are used. If the user pastes one anyway,
tell them to revoke it once they are done.

1. **Region.** Neon Object Storage exists only in `aws-us-east-2`,
   `aws-us-east-1`, `aws-eu-central-1`, and `aws-ap-southeast-1`. A project
   [provisioning.md](provisioning.md) creates is in `aws-us-east-2` already;
   do not ask the user for a region. For an existing project, read
   `region_id` from `npx -y neonctl projects get <project_id> --output json`;
   if it is another region, stop and ask the user whether to create a
   separate project for storage or use another S3-compatible bucket.
2. **Bucket.** Create a private bucket on the project's default branch:

   ```sh
   npx -y neonctl buckets create tieline-screens --project-id <project_id>
   ```

   Set `screens.hosted.bucket` to its name in `.tieline/config.json`. The
   name is reviewed configuration, not a secret.
3. **Credentials.** Create two, each written straight to a private file:
   one that can write, for publishing and sync, and one that can only read,
   for the hosted site.

   ```sh
   umask 077
   dir="$(mktemp -d)"
   npx -y neonctl credentials create --project-id <project_id> --scope storage:read --scope storage:write --name tieline-screens-publish --output json > "$dir/publish.json"
   npx -y neonctl credentials create --project-id <project_id> --scope storage:read --name tieline-screens-site --output json > "$dir/site.json"
   ```

   In each file `token_id` is the access key and `s3_secret_access_key`
   the secret.
4. **Endpoint and region.** These are not secret. With `NEON_API_KEY` set,
   read `s3_endpoint` and `region` from the default branch's storage, where
   `<branch_id>` is the branch `npx -y neonctl branches list --project-id
   <project_id> --output json` marks `default`:

   ```sh
   curl -s -H "Authorization: Bearer $NEON_API_KEY" \
     "https://console.neon.tech/api/v2/projects/<project_id>/branches/<branch_id>/storage"
   ```

   Without an API key, ask the user for the two values: the Neon Console
   shows them, with the credential, whenever a storage credential is
   created there.
5. **Hand off.** Write one private file that groups every storage value by
   where it goes, without printing anything:

   ```sh
   node -e '
   const fs = require("fs");
   const [dir, endpoint, region] = process.argv.slice(1);
   const read = (name) => JSON.parse(fs.readFileSync(`${dir}/${name}.json`, "utf8"));
   const lines = (credential) => [
     `TIELINE_SCREENS_S3_ENDPOINT=${endpoint}`,
     `TIELINE_SCREENS_S3_REGION=${region}`,
     `TIELINE_SCREENS_S3_ACCESS_KEY_ID=${credential.token_id}`,
     `TIELINE_SCREENS_S3_SECRET_ACCESS_KEY=${credential.s3_secret_access_key}`,
   ];
   fs.writeFileSync(`${dir}/hosted-screens.env`, [
     "# Secrets of the hosted-screens GitHub environment (can write):",
     ...lines(read("publish")),
     "",
     "# The hosted site's environment (read-only):",
     ...lines(read("site")),
     "",
   ].join("\n"), { mode: 0o600 });
   fs.writeFileSync(`${dir}/check.env`, lines(read("publish")).join("\n") + "\n", { mode: 0o600 });
   ' "$dir" "<s3_endpoint>" "<region>"
   rm "$dir/publish.json" "$dir/site.json"
   ```

   Then tell the user:
   - the path of `$dir/hosted-screens.env`, and that it holds secrets;
   - to create a GitHub environment named `hosted-screens` whose deployment
     branches are limited to the default branch, and add as its secrets the
     file's first group, plus `TIELINE_DATABASE_URL_SCREENS_PUBLISH` and
     `TIELINE_DATABASE_URL_SYNC` copied from `DATABASE_URL_SCREENS_PUBLISH`
     and `DATABASE_URL_SYNC` in this clone's private Tieline profile,
     `~/.config/tieline/profiles/<repo_name>-<hash>.json` — environment
     secrets, never repository secrets, which any pull request's workflow
     can read;
   - to set its second group, plus `DATABASE_URL` from the same profile (the
     read-only reader role), in the hosted site's environment, after
     `tieline hosted init --host netlify` and creating the Netlify site;
   - to delete the directory once the values are copied.
6. **Verify** the bucket and every database credential, without printing
   anything:

   ```sh
   (set -a; . "$dir/check.env"; set +a; npx -y tieline hosted check)
   rm "$dir/check.env"
   ```

   Every check must pass or be skipped. Once the site is deployed with its
   access control on, run `npx -y tieline hosted check --url <site URL>`;
   it fails if the site answers a visitor who has not logged in.
7. **Workflows.** Copy `screens-hosted.yml`, `screens-hosted-publish.yml`,
   and `screens-hosted-main.yml` from this skill's `assets/workflows/` into
   the repository's `.github/workflows/`, setting each Playwright image tag
   to the app's `@playwright/test` version and the artifact path to
   `screens.captures_directory` when it is not the default. Delete
   `.github/workflows/screens-verify.yml` if it exists: `screens-hosted.yml`
   verifies too, and a second workflow named `Screens` would start the
   publish workflow without screenshots to publish. Tell the user that
   `screens-hosted-publish.yml` runs only once it is on the default branch.
