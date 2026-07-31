import pc from "picocolors";
import type { TielineCliIO } from "./cli.js";

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

export async function intro(
  io: TielineCliIO,
  title: string
): Promise<void> {
  if (!io.interactive) return;
  const clack = await import("@clack/prompts");
  clack.intro(pc.bgCyan(pc.black(` ${title} `)));
}

export async function outro(
  io: TielineCliIO,
  message: string
): Promise<void> {
  if (!io.interactive) return;
  const clack = await import("@clack/prompts");
  clack.outro(message);
}
