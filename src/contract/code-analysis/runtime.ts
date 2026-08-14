import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  Language,
  LANGUAGE_VERSION,
  MIN_COMPATIBLE_VERSION,
  Parser,
  type Parser as TreeSitterParser,
} from "web-tree-sitter";
import {
  codeLanguageDefinition,
  parserCompatibilitySet,
  readParserCompatibilityManifest,
  type ParserArtifactManifest,
  type ParserCompatibilityManifest,
  type SupportedCodeLanguage,
} from "./languages.js";

const maximumParserConcurrency = 4;
let treeSitterInitialization: Promise<void> | undefined;

export interface CodeParserRuntimeOptions {
  assetRoot?: string;
  maxConcurrentParsers?: number;
}

export interface CodeParserRuntime {
  initialize(): Promise<void>;
  withParser<T>(
    language: SupportedCodeLanguage,
    operation: (parser: TreeSitterParser, grammar: Language) => T | Promise<T>
  ): Promise<T>;
}

export function defaultParserAssetRoot(): string {
  return fileURLToPath(
    new URL(`../../../assets/parsers/${parserCompatibilitySet}/`, import.meta.url)
  );
}

async function verifyArtifact(
  assetRoot: string,
  artifact: ParserArtifactManifest
): Promise<{ bytes: Buffer; path: string }> {
  const path = resolve(assetRoot, artifact.file);
  let bytes: Buffer;
  try {
    bytes = await readFile(path);
  } catch (error) {
    throw new Error(`Unable to read parser asset at ${path}`, { cause: error });
  }
  const digest = createHash("sha256").update(bytes).digest("hex");
  if (digest !== artifact.sha256) {
    throw new Error(
      `Parser asset integrity mismatch for ${path}: expected ${artifact.sha256}, received ${digest}`
    );
  }
  return { bytes, path };
}

function validateAbi(manifest: ParserCompatibilityManifest): void {
  if (
    manifest.abi.minimum < MIN_COMPATIBLE_VERSION ||
    manifest.abi.maximum > LANGUAGE_VERSION ||
    manifest.abi.minimum > manifest.abi.maximum
  ) {
    throw new Error(
      `Parser compatibility ABI ${manifest.abi.minimum}-${manifest.abi.maximum} is outside runtime ${MIN_COMPATIBLE_VERSION}-${LANGUAGE_VERSION}`
    );
  }
}

class ParserSemaphore {
  private active = 0;
  private readonly waiters: Array<() => void> = [];

  constructor(private readonly limit: number) {}

  async acquire(): Promise<() => void> {
    if (this.active >= this.limit) {
      await new Promise<void>((resolveWaiter) => this.waiters.push(resolveWaiter));
    }
    this.active += 1;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.active -= 1;
      this.waiters.shift()?.();
    };
  }
}

class WasmCodeParserRuntime implements CodeParserRuntime {
  private readonly assetRoot: string;
  private readonly semaphore: ParserSemaphore;
  private readonly manifest: Promise<ParserCompatibilityManifest>;
  private initialization: Promise<void> | undefined;
  private readonly grammars = new Map<SupportedCodeLanguage, Promise<Language>>();

  constructor(options: CodeParserRuntimeOptions) {
    const concurrency = options.maxConcurrentParsers ?? maximumParserConcurrency;
    if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > maximumParserConcurrency) {
      throw new Error(`Parser concurrency must be an integer from 1 to ${maximumParserConcurrency}`);
    }
    this.assetRoot = options.assetRoot ?? defaultParserAssetRoot();
    this.semaphore = new ParserSemaphore(concurrency);
    this.manifest = readParserCompatibilityManifest(this.assetRoot);
  }

  initialize(): Promise<void> {
    this.initialization ??= this.initializeOnce();
    return this.initialization;
  }

  async withParser<T>(
    language: SupportedCodeLanguage,
    operation: (parser: TreeSitterParser, grammar: Language) => T | Promise<T>
  ): Promise<T> {
    const grammar = await this.loadGrammar(language);
    const release = await this.semaphore.acquire();
    let parser: TreeSitterParser | undefined;
    try {
      parser = new Parser();
      parser.setLanguage(grammar);
      return await operation(parser, grammar);
    } finally {
      parser?.delete();
      release();
    }
  }

  private async initializeOnce(): Promise<void> {
    const manifest = await this.manifest;
    const runtime = await verifyArtifact(this.assetRoot, manifest.artifacts.runtime);
    treeSitterInitialization ??= Parser.init({ locateFile: () => runtime.path });
    await treeSitterInitialization;
    validateAbi(manifest);
  }

  private loadGrammar(language: SupportedCodeLanguage): Promise<Language> {
    let grammar = this.grammars.get(language);
    if (!grammar) {
      grammar = this.loadGrammarOnce(language);
      this.grammars.set(language, grammar);
    }
    return grammar;
  }

  private async loadGrammarOnce(language: SupportedCodeLanguage): Promise<Language> {
    await this.initialize();
    const manifest = await this.manifest;
    const definition = codeLanguageDefinition(language);
    const artifact = manifest.artifacts[definition.artifact];
    const verified = await verifyArtifact(this.assetRoot, artifact);
    const grammar = await Language.load(verified.bytes);
    if (
      artifact.abi === null ||
      grammar.abiVersion !== artifact.abi ||
      grammar.abiVersion < manifest.abi.minimum ||
      grammar.abiVersion > manifest.abi.maximum
    ) {
      throw new Error(
        `Parser ABI mismatch for ${language}: expected ${artifact.abi}, received ${grammar.abiVersion}`
      );
    }
    return grammar;
  }
}

export function createCodeParserRuntime(options: CodeParserRuntimeOptions = {}): CodeParserRuntime {
  return new WasmCodeParserRuntime(options);
}
