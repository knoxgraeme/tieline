export function tielineConfigJson(options: {
  name: string;
  repoName: string;
  ignore?: string[];
  specDirectory?: string;
  timestamp?: string;
}): string {
  const timestamp = options.timestamp ?? "2026-08-01T00:00:00.000Z";
  return `${JSON.stringify(
    {
      version: 1,
      product: { name: options.name, repo_name: options.repoName },
      repository: {
        root: "..",
        source_roots: ["src"],
        ignore: options.ignore ?? [".git", ".tieline", "src/generated"],
      },
      context: { sources: [] },
      runtime: {
        default_embedding_provider: "hash",
        default_database_mode: "offline",
      },
      files: {
        spec_directory: options.specDirectory ?? "contract",
        manifest: "manifest",
      },
      created_at: timestamp,
      updated_at: timestamp,
    },
    null,
    2
  )}\n`;
}
