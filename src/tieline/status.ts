import { existsSync, readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { draftSchema } from "../authoring/schema.js";
import { collectShards, mergedDraftIsCurrent } from "./merge.js";
import {
  currentProductContextChecksum,
  findTielineWorkspace,
  tielineCoverageSchema,
  productContextApprovalState,
  type TielineWorkspace,
} from "./workspace.js";

export interface TielineStatus {
  initialized: true;
  root: string;
  product: string;
  repo: string;
  runtime: {
    database_mode: "local" | "existing" | "offline";
    embedding_provider: "local" | "openai" | "supabase-edge" | "hash";
    approval_mode: "production" | "all" | "off";
    setup_complete: boolean;
  };
  context: {
    status: "missing" | "draft" | "approved" | "stale";
    approved_checksum: string | null;
    current_checksum: string | null;
  };
  draft: {
    exists: boolean;
    product_context_current: boolean;
    sections: number;
    stories: number;
    pending: number;
    approved: number;
    rejected: number;
  };
  shards: {
    /** Shards that parsed cleanly. */
    count: number;
    stories: number;
    /** Shards present but unreadable — expected while one is being written. */
    unreadable: number;
    /** stories.draft.json already reflects every shard. */
    merged: boolean;
  };
  coverage: {
    exists: boolean;
    status: string;
    product_context_current: boolean;
    areas_examined: number;
    uncertain_areas: number;
  };
  import: {
    report_exists: boolean;
    status: string | null;
    current: boolean;
  };
  next_action: string;
}

function readJson(path: string): unknown {
  return JSON.parse(readFileSync(path, "utf8"));
}

export function getTielineStatus(workspace: TielineWorkspace): TielineStatus {
  const contextStatus = productContextApprovalState(workspace);
  const currentChecksum = currentProductContextChecksum(workspace);
  let draftChecksum: string | null = null;
  let sections = 0;
  let stories = 0;
  let pending = 0;
  let approved = 0;
  let rejected = 0;
  let draftFileChecksum: string | null = null;
  if (existsSync(workspace.draftPath)) {
    const draftBody = readFileSync(workspace.draftPath, "utf8");
    draftFileChecksum = createHash("sha256").update(draftBody).digest("hex");
    const draft = draftSchema.parse(JSON.parse(draftBody));
    draftChecksum = draft.product_context_checksum ?? null;
    sections = draft.sections.length;
    stories = draft.stories.length;
    if (draft.stories.length > 0) {
      for (const story of draft.stories) {
        const state = story._review.state;
        if (state === "approved") approved++;
        else if (state === "rejected") rejected++;
        else pending++;
      }
    }
  }

  let coverageStatus = "missing";
  let coverageChecksum: string | null = null;
  let coverageRepo: string | null = null;
  let areasExamined = 0;
  let uncertainAreas = 0;
  if (existsSync(workspace.coveragePath)) {
    const coverage = tielineCoverageSchema.parse(readJson(workspace.coveragePath));
    coverageStatus = coverage.status;
    areasExamined = coverage.areas_examined.length;
    uncertainAreas = coverage.uncertain_areas.length;
    coverageChecksum = coverage.product_context_checksum ?? null;
    coverageRepo = coverage.repo;
  }

  const reportPath = `${workspace.draftPath}.import-report.json`;
  let importStatus: string | null = null;
  let importCurrent = false;
  if (existsSync(reportPath)) {
    const report = readJson(reportPath) as { status?: unknown; source_checksum?: unknown };
    importStatus = typeof report.status === "string" ? report.status : "unknown";
    importCurrent = report.source_checksum === draftFileChecksum;
  }

  const productContextCurrent = Boolean(
    contextStatus === "approved" &&
      currentChecksum &&
      draftChecksum &&
      currentChecksum === draftChecksum
  );
  const coverageCurrent = Boolean(
    coverageStatus === "complete" &&
      currentChecksum &&
      coverageChecksum === currentChecksum &&
      coverageRepo === workspace.config.product.repo_name
  );
  const shards = collectShards(workspace);
  const shardStories = shards.shards.reduce((total, entry) => total + entry.draft.stories.length, 0);
  const shardsMerged = mergedDraftIsCurrent(workspace, shards);

  let nextAction: string;
  if (!workspace.config.runtime.setup_completed_at) {
    nextAction = "Runtime setup is incomplete; rerun `tieline init` to resume configuration.";
  } else if (contextStatus === "missing" || contextStatus === "draft") {
    nextAction = "Have the agent complete product-context.md, confirm it with the human, then run `tieline context approve`.";
  } else if (contextStatus === "stale") {
    nextAction = "Product context changed after approval; review it and run `tieline context approve` again.";
  } else if (shards.errors.length > 0) {
    nextAction = `Fix ${shards.errors.length} unreadable draft shard(s) in ${workspace.config.files.drafts_dir}/, then run \`tieline merge\`.`;
  } else if (shards.shards.length > 0 && !shardsMerged) {
    nextAction = "Merge the per-area draft shards into stories.draft.json with `tieline merge`.";
  } else if (stories === 0 || !productContextCurrent) {
    nextAction = "Have the agent generate the story draft and coverage from the approved product-context checksum.";
  } else if (!coverageCurrent) {
    nextAction = "Have the agent finish coverage.json for the approved product context before story import.";
  } else if (pending > 0) {
    nextAction = "Review the pending stories and approve or reject each one.";
  } else if (approved === 0) {
    nextAction = "No stories are approved for import.";
  } else if (importStatus !== "complete" || !importCurrent) {
    nextAction = "Import the approved draft with the local reviewed batch importer.";
  } else {
    nextAction = "Onboarding import is complete; run representative semantic and code-path searches.";
  }

  return {
    initialized: true,
    root: workspace.root,
    product: workspace.config.product.name,
    repo: workspace.config.product.repo_name,
    runtime: {
      database_mode: workspace.config.runtime.database_mode,
      embedding_provider: workspace.config.runtime.embedding_provider,
      approval_mode: workspace.config.runtime.approval_mode,
      setup_complete: Boolean(workspace.config.runtime.setup_completed_at),
    },
    context: {
      status: contextStatus,
      approved_checksum: workspace.config.context.approved_checksum ?? null,
      current_checksum: currentChecksum,
    },
    draft: {
      exists: existsSync(workspace.draftPath),
      product_context_current: productContextCurrent,
      sections,
      stories,
      pending,
      approved,
      rejected,
    },
    shards: {
      count: shards.shards.length,
      stories: shardStories,
      unreadable: shards.errors.length,
      merged: shardsMerged,
    },
    coverage: {
      exists: existsSync(workspace.coveragePath),
      status: coverageStatus,
      product_context_current: coverageCurrent,
      areas_examined: areasExamined,
      uncertain_areas: uncertainAreas,
    },
    import: {
      report_exists: existsSync(reportPath),
      status: importStatus,
      current: importCurrent,
    },
    next_action: nextAction,
  };
}

export function statusFromPath(path: string): TielineStatus {
  const workspace = findTielineWorkspace(path);
  if (!workspace) throw new Error(`No .tieline/config.json found from ${path}.`);
  return getTielineStatus(workspace);
}
