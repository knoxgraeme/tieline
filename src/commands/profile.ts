import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { PostgresProfileRepository } from "../adapters/postgres/profile-repository.js";
import { closeConnections } from "../adapters/postgres/connections.js";

interface ProfileIO {
  write(message: string): void;
}

function value(args: string[], name: string): string | undefined {
  const inline = args.find((arg) => arg.startsWith(`--${name}=`));
  if (inline) return inline.slice(name.length + 3);
  const index = args.indexOf(`--${name}`);
  return index >= 0 ? args[index + 1] : undefined;
}

export async function runProfileCommand(
  args: string[],
  io: ProfileIO
): Promise<number> {
  const action = args[0];
  const repository = new PostgresProfileRepository();
  try {
    if (action === "list") {
      const profiles = await repository.listProfiles();
      if (args.includes("--json")) {
        io.write(`${JSON.stringify({ profiles }, null, 2)}\n`);
      } else {
        for (const profile of profiles) {
          io.write(
            `${profile.key}@${profile.version}${profile.active ? " active" : ""} (${profile.created_by})\n`
          );
        }
      }
      return 0;
    }
    if (action === "put") {
      const key = value(args, "key");
      const file = value(args, "file");
      const createdBy = value(args, "created-by");
      if (!key || !file || !createdBy) {
        throw new Error(
          "Usage: tieline profile put --key <key> --file <definition.json> --created-by <actor>"
        );
      }
      const definition = JSON.parse(
        readFileSync(resolve(file), "utf8")
      ) as unknown;
      const profile = await repository.putProfile({
        key,
        definition,
        created_by: createdBy,
      });
      io.write(`${JSON.stringify({ profile }, null, 2)}\n`);
      return 0;
    }
    throw new Error(
      "Usage: tieline profile <list|put> [options]"
    );
  } finally {
    await closeConnections();
  }
}
