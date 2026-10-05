import { createArtifactAssuranceInspector, type ArtifactLocatorResolution, type ArtifactLocatorNotCheckedReason } from "./artifact-assurance.js";
import { buildContractClaimIndex } from "./reconciliation.js";
import type { ContractManifest } from "./manifest.js";

export interface ManifestLocatorFinding {
  path: string;
  selector: string;
  resolution: ArtifactLocatorResolution;
  reason: ArtifactLocatorNotCheckedReason | null;
}

/** Validate local selected declarations without retaining a repository's parser
 * state. Unavailable parsers stay explicit; only definite locator failures gate.
 */
export async function inspectManifestLocators(repositoryRoot: string, manifest: ContractManifest): Promise<ManifestLocatorFinding[]> {
  const paths = buildContractClaimIndex(manifest);
  if ([...paths.values()].reduce((n, claims) => n + claims.length, 0) > 5_000) {
    throw new Error("Manifest locator validation exceeds 5,000 claims; split the contract before validation.");
  }
  const findings: ManifestLocatorFinding[] = [];
  for (const [path, claims] of paths) {
    const selected = claims.filter((claim) => claim.selector !== null);
    if (selected.length === 0) continue;
    const inspector = createArtifactAssuranceInspector({ repositoryRoot, repositoryKey: manifest.repository.key });
    try {
      const seen = new Set<string>();
      for (const claim of selected) {
        const selector = claim.selector!;
        if (seen.has(selector)) continue;
        seen.add(selector);
        const result = await inspector.inspect({ target: { kind: claim.target_kind, repository: claim.repository, path, selector }, compiled_content_hash: claim.compiled_content_hash });
        if (result.locator_resolution !== "resolved") findings.push({ path, selector, resolution: result.locator_resolution, reason: result.locator_reason });
      }
    } finally { await inspector.dispose(); }
  }
  return findings;
}
