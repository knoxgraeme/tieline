import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { PostgresProfileRepository } from "../adapters/postgres/profile-repository.js";
import { closeConnections } from "../adapters/postgres/connections.js";

interface ProfileIO {
  write(message: string): void;
}

export async function runProfileListCommand(
  options: { json?: boolean },
  io: ProfileIO
): Promise<number> {
  const repository = new PostgresProfileRepository();
  try {
    const profiles = await repository.listProfiles();
    if (options.json) {
      io.write(`${JSON.stringify({ profiles }, null, 2)}\n`);
    } else {
      for (const profile of profiles) {
        io.write(
          `${profile.key}@${profile.version}${profile.active ? " active" : ""} (${profile.created_by})\n`
        );
      }
    }
    return 0;
  } finally {
    await closeConnections();
  }
}

export async function runProfilePutCommand(
  options: { key: string; file: string; createdBy: string },
  io: ProfileIO
): Promise<number> {
  const repository = new PostgresProfileRepository();
  try {
    const definition = JSON.parse(
      readFileSync(resolve(options.file), "utf8")
    ) as unknown;
    const profile = await repository.putProfile({
      key: options.key,
      definition,
      created_by: options.createdBy,
    });
    io.write(`${JSON.stringify({ profile }, null, 2)}\n`);
    return 0;
  } finally {
    await closeConnections();
  }
}
