import type { Input } from "./input.js";
import { sql } from "./database.js";
export type { Output } from "./output.js";
export { runtime } from "./runtime.js";

export interface Service {
  execute(input: Input): Output;
}

export type Result = Output | Error;
export enum State { Ready, Failed }

export class Handler {
  execute(input: string): string;
  execute(input: number): number;
  execute(input: string | number): string | number {
    return input;
  }
}

export function tagged(): void {
  sql<Input[]>`select * from input`;
}

export const café = "ready";

