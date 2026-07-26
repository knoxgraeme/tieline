import { EMBEDDING_DIMENSION } from "../../config.js";

export function vectorLiteral(vector: number[]): string {
  if (vector.length !== EMBEDDING_DIMENSION || vector.some((value) => !Number.isFinite(value))) {
    throw new Error(`Expected ${EMBEDDING_DIMENSION} finite embedding values; received ${vector.length}.`);
  }
  return `[${vector.join(",")}]`;
}
