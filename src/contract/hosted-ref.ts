/**
 * The refs hosted screens publish and serve. Kept free of other imports so
 * the hosted site can parse a requested ref without loading the catalog
 * machinery.
 */

/** Pull requests are `pr-<number>`; anything else is a branch. */
export type HostedRef = { kind: "pr"; name: string } | { kind: "branch"; name: string };

const BRANCH = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,199}$/;

/**
 * Parses the ref a publish targets. `main` is never a target: it is published
 * only by `tieline contract sync`, which holds the repository sync role.
 */
export function parseHostedRef(input: { pullRequest?: string | undefined; branch?: string | undefined }): HostedRef {
  if ((input.pullRequest === undefined) === (input.branch === undefined)) {
    throw new Error("Name exactly one of --pull-request <number> or --branch <name>.");
  }
  if (input.pullRequest !== undefined) {
    if (!/^[1-9][0-9]{0,9}$/.test(input.pullRequest)) {
      throw new Error(`--pull-request must be a pull request number, not '${input.pullRequest}'.`);
    }
    return { kind: "pr", name: input.pullRequest };
  }
  const branch = input.branch!;
  if (!BRANCH.test(branch) || /(\.\.|\/\/|\/$|\.lock$)/.test(branch)) {
    throw new Error(`--branch '${branch}' is not a branch name hosted screens accept.`);
  }
  if (/^pr-[1-9][0-9]{0,9}$/.test(branch)) {
    throw new Error(`--branch ${branch}: the hosted site reads ?ref=${branch} as a pull request; publish it with --pull-request or rename the branch.`);
  }
  if (branch === "main" || branch === "master") {
    throw new Error(
      `--branch ${branch}: the default branch is published by \`tieline contract sync\`, not by \`screens publish\`.`
    );
  }
  return { kind: "branch", name: branch };
}

/** How the hosted site names a ref in its URL: `pr-123`, or the branch name. */
export function hostedRefLabel(ref: HostedRef): string {
  return ref.kind === "pr" ? `pr-${ref.name}` : ref.name;
}

/**
 * The ref a hosted site visitor asked for with `?ref=`: nothing or `main` is
 * `main`, `pr-<number>` a pull request, and anything else a branch. Null
 * when the value could not name a published ref.
 */
export function parseRequestedRef(value: string | null): { kind: "main" } | HostedRef | null {
  if (value === null || value === "" || value === "main") return { kind: "main" };
  const pullRequest = /^pr-([1-9][0-9]{0,9})$/.exec(value);
  if (pullRequest) return { kind: "pr", name: pullRequest[1]! };
  return BRANCH.test(value) && !/(\.\.|\/\/|\/$|\.lock$)/.test(value) ? { kind: "branch", name: value } : null;
}
