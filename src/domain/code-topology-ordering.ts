/** Locale-independent UTF-16 order used by every canonical topology record. */
export function compareCodeTopologyText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
