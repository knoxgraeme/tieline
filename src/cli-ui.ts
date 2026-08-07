import pc from "picocolors";
import type {
  TielineCliIO,
  TielineCliPromptOption,
} from "./cli.js";

export type Palette = ReturnType<typeof pc.createColors>;

export function createPalette(enabled: boolean): Palette {
  return pc.createColors(enabled);
}

export function paletteFor(io: TielineCliIO): Palette {
  return createPalette(io.interactive === true && pc.isColorSupported);
}

// Diamond mark echoing the Tieline logo: stacked diamonds pierced by a
// vertical tieline of three nodes, with the dotted band through the middle.
const MARK = [
  "      .",
  "     / \\",
  "    / ● \\",
  "  ·:· ● ·:·",
  "    \\ ● /",
  "     \\ /",
  "      '",
];

// figlet "Tieline" (Standard font), wordmark rows pair with MARK rows 1-5.
const WORDMARK = [
  " _____ _      _ _",
  "|_   _(_) ___| (_)_ __   ___",
  "  | | | |/ _ \\ | | '_ \\ / _ \\",
  "  | | | |  __/ | | | | |  __/",
  "  |_| |_|\\___|_|_|_| |_|\\___|",
];

const MARK_COLUMN_WIDTH = 13;

export function renderBanner(ui: Palette): string {
  return MARK.map((line, row) => {
    const word = row >= 1 && row <= 5 ? WORDMARK[row - 1]! : "";
    if (!word) return ui.cyan(line);
    return `${ui.cyan(line.padEnd(MARK_COLUMN_WIDTH))}${ui.bold(word)}`;
  }).join("\n");
}

const CALLOUT_MAX_WIDTH = 72;

/**
 * Sets a copy-me value apart from the report around it. The value sits alone
 * on its own line between rules so a triple-click selects exactly the text to
 * paste — a prefix, indent, or box border would be selected along with it.
 */
export function renderCopyCallout(ui: Palette, value: string): string[] {
  const rule = ui.dim("─".repeat(Math.min(value.length, CALLOUT_MAX_WIDTH)));
  return [rule, ui.bold(ui.cyan(value)), rule];
}

/**
 * Ask for a single value with a default. Uses a Clack prompt on an
 * interactive terminal and falls back to the injected io.question
 * elsewhere (tests, pipes, agents).
 */
export async function ask(
  io: TielineCliIO,
  message: string,
  defaultValue: string
): Promise<string> {
  if (io.interactive) {
    if (io.prompts) {
      const value = await io.prompts.text(message, defaultValue);
      if (value === null) throw new Error("Cancelled.");
      return value.trim() || defaultValue;
    }
    const clack = await import("@clack/prompts");
    const value = await clack.text({
      message,
      placeholder: defaultValue,
      defaultValue,
    });
    if (clack.isCancel(value)) {
      clack.cancel("Cancelled.");
      throw new Error("Cancelled.");
    }
    return value.trim() || defaultValue;
  }
  return (
    (await io.question(`${message} [${defaultValue}]: `)).trim() ||
    defaultValue
  );
}

export async function askOptional(
  io: TielineCliIO,
  message: string,
  defaultValue = ""
): Promise<string> {
  if (!io.interactive) return defaultValue;
  if (io.prompts) {
    const value = await io.prompts.text(message, defaultValue);
    if (value === null) throw new Error("Cancelled.");
    return value.trim();
  }
  const clack = await import("@clack/prompts");
  const value = await clack.text({
    message,
    placeholder: defaultValue || "Optional",
    defaultValue,
  });
  if (clack.isCancel(value)) {
    clack.cancel("Cancelled.");
    throw new Error("Cancelled.");
  }
  return value.trim();
}

export async function askList(
  io: TielineCliIO,
  message: string,
  defaultValues: readonly string[] = []
): Promise<string[]> {
  const value = await askOptional(io, message, defaultValues.join(", "));
  return value
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

export async function confirmChoice(
  io: TielineCliIO,
  message: string,
  initialValue: boolean
): Promise<boolean> {
  if (!io.interactive) return initialValue;
  if (io.prompts) {
    const value = await io.prompts.confirm(message, initialValue);
    if (value === null) throw new Error("Cancelled.");
    return value;
  }
  const clack = await import("@clack/prompts");
  const value = await clack.confirm({ message, initialValue });
  if (clack.isCancel(value)) {
    clack.cancel("Cancelled.");
    throw new Error("Cancelled.");
  }
  return value;
}

export async function selectChoice<T extends string>(
  io: TielineCliIO,
  message: string,
  options: readonly TielineCliPromptOption[],
  initialValue: T
): Promise<T> {
  if (!io.interactive) return initialValue;
  if (io.prompts) {
    const value = await io.prompts.select(message, options, initialValue);
    if (value === null) throw new Error("Cancelled.");
    return value as T;
  }
  const clack = await import("@clack/prompts");
  const value = await clack.select({
    message,
    options: [...options],
    initialValue,
  });
  if (clack.isCancel(value)) {
    clack.cancel("Cancelled.");
    throw new Error("Cancelled.");
  }
  return value as T;
}

export async function multiselectChoice<T extends string>(
  io: TielineCliIO,
  message: string,
  options: readonly TielineCliPromptOption[]
): Promise<T[]> {
  if (!io.interactive) return [];
  if (io.prompts) {
    const value = await io.prompts.multiselect(message, options);
    if (value === null) throw new Error("Cancelled.");
    return value as T[];
  }
  const clack = await import("@clack/prompts");
  const value = await clack.multiselect({
    message,
    options: [...options],
    required: true,
  });
  if (clack.isCancel(value)) {
    clack.cancel("Cancelled.");
    throw new Error("Cancelled.");
  }
  return value as T[];
}

export async function showNote(
  io: TielineCliIO,
  title: string,
  message: string
): Promise<void> {
  if (!io.interactive) return;
  if (io.prompts) {
    io.prompts.note(title, message);
    return;
  }
  const clack = await import("@clack/prompts");
  clack.note(message, title);
}

export async function intro(
  io: TielineCliIO,
  title: string
): Promise<void> {
  if (!io.interactive) return;
  if (io.prompts) return;
  const clack = await import("@clack/prompts");
  clack.intro(pc.bgCyan(pc.black(` ${title} `)));
}

export async function outro(
  io: TielineCliIO,
  message: string
): Promise<void> {
  if (!io.interactive) return;
  if (io.prompts) return;
  const clack = await import("@clack/prompts");
  clack.outro(message);
}
