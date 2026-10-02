import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { tielineConfigJson } from "./fixtures.js";

/**
 * A disposable workspace for a fictional "Acme Notes" app. Every path is
 * relative to the repository root; nothing here touches the network or a
 * database.
 */
export interface ScreensWorkspace {
  root: string;
  write(path: string, content: string): void;
  remove(path: string): void;
  commit(message: string): void;
  cleanup(): void;
}

export const REPO_KEY = "acme-notes";

export function screensConfigJson(screens: unknown): string {
  const config = JSON.parse(
    tielineConfigJson({ name: "Acme Notes", repoName: REPO_KEY, specDirectory: "spec" })
  ) as Record<string, unknown>;
  if (screens !== undefined) config.screens = screens;
  return `${JSON.stringify(config, null, 2)}\n`;
}

/** A shows link in the YAML form the brief documents. */
export function showsLink(key: string, indent: string): string {
  return `${indent}- relation: shows
${indent}  provenance: authored
${indent}  target: { kind: screen, key: ${key} }`;
}

export interface NotesSpecOptions {
  /** Screen keys linked from the NOTES-001 Story itself. */
  storyShows?: string[];
  /** Screen keys linked from NOTES-001-AC1. */
  criterionShows?: string[];
}

export function notesSpecYaml(options: NotesSpecOptions = {}): string {
  const storyLinks = [
    `        - relation: implements
          provenance: authored
          target: { kind: code, repository: ${REPO_KEY}, path: src/notes.ts }`,
    ...(options.storyShows ?? []).map((key) => showsLink(key, "        ")),
  ].join("\n");
  const criterionShows = options.criterionShows ?? [];
  return `version: 1
capability:
  key: NOTES
  name: Notes
  description: Members write and organize notes.
  stories:
    - key: NOTES-001
      title: Browse my notes
      actor: member
      goal: see all of my notes in one list
      benefit: I can find what I wrote quickly
      lifecycle: production
      links:
${storyLinks}
      acceptance_criteria:
        - key: NOTES-001-AC1
          criterion: The notes list must show the member's notes, newest first.
${
  criterionShows.length > 0
    ? `          links:\n${criterionShows.map((key) => showsLink(key, "            ")).join("\n")}\n`
    : ""
}        - key: NOTES-001-AC2
          criterion: The notes list must invite a member without notes to write one.
`;
}

export const SHARING_SPEC_YAML = `version: 1
capability:
  key: SHARING
  name: Sharing
  description: Owners share notes with collaborators.
  stories:
    - key: SHARING-001
      title: Share a note
      actor: note owner
      goal: invite a collaborator to a note
      benefit: we can edit it together
      lifecycle: in_progress
      acceptance_criteria:
        - key: SHARING-001-AC1
          criterion: A viewer must not be able to share a note.
`;

export const NOTES_CATALOG_YAML = `version: 1
capability: NOTES
screens:
  - key: notes-list
    title: Notes list
    group: Browsing
    route: /notes
    kind: page
    when: A member opens Notes.
    applies_to:
      role: [member, admin]
    copy:
      - Your notes
    image:
      path: notes/notes-list.png
  - key: notes-list-empty
    title: Notes list, no notes yet
    group: Browsing
    route: /notes
    kind: state
    when: A member without notes opens Notes.
  - key: note-saved-toast
    title: Note saved
    route: /notes/:noteId
    kind: toast
    when: A member saves a note.
`;

export const SHARING_CATALOG_YAML = `version: 1
capability: SHARING
screens:
  - key: notes-share-denied
    title: Sharing not allowed
    group: Invitations
    route: /notes/:noteId
    kind: inline-error
    when: A viewer presses Share.
    applies_to:
      role: [viewer]
    image:
      url: https://images.example.test/share-denied.png
`;

export interface CreateScreensWorkspaceOptions {
  /** The `screens` config block; omitted means the feature is off. */
  screens?: unknown;
  notes?: NotesSpecOptions;
  catalog?: Record<string, string>;
  git?: boolean;
}

export function createScreensWorkspace(
  options: CreateScreensWorkspaceOptions = {}
): ScreensWorkspace {
  const root = mkdtempSync(resolve(tmpdir(), "tieline-screens-"));
  const write = (path: string, content: string): void => {
    const target = resolve(root, path);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, content);
  };
  write(".tieline/config.json", screensConfigJson(options.screens));
  write("src/notes.ts", "export const notes: string[] = [];\n");
  write(".tieline/spec/notes.yaml", notesSpecYaml(options.notes));
  write(".tieline/spec/sharing.yaml", SHARING_SPEC_YAML);
  for (const [path, content] of Object.entries(options.catalog ?? {})) {
    write(path, content);
  }
  const git = (...args: string[]): void => {
    execFileSync("git", args, { cwd: root, stdio: ["ignore", "ignore", "ignore"] });
  };
  if (options.git) {
    git("init", "-q");
    git("config", "user.email", "test@example.test");
    git("config", "user.name", "Tieline Test");
  }
  return {
    root,
    write,
    remove(path) {
      rmSync(resolve(root, path), { recursive: true, force: true });
    },
    commit(message) {
      git("add", "-A");
      git("commit", "-q", "-m", message);
    },
    cleanup() {
      rmSync(root, { recursive: true, force: true });
    },
  };
}

export function captureIO(): { io: { write(message: string): void; error(message: string): void; question(): Promise<string> }; output(): string; reset(): void } {
  let output = "";
  return {
    io: {
      write(message) {
        output += message;
      },
      error(message) {
        throw new Error(message);
      },
      async question() {
        throw new Error("screen commands must not prompt");
      },
    },
    output: () => output,
    reset() {
      output = "";
    },
  };
}
