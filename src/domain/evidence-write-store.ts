import { z } from "zod";

export const OBSERVATION_KINDS = ["request", "bug", "question"] as const;
export type ObservationKind = (typeof OBSERVATION_KINDS)[number];
export const BACKLOG_STAGES = [
  "open",
  "planned",
  "in_progress",
  "done",
  "declined",
] as const;
export type BacklogStage = (typeof BACKLOG_STAGES)[number];
export const ATTRIBUTION_RELATIONS = [
  "violates",
  "requests_change",
  "asks_about",
  "supports",
] as const;
export type AttributionRelation = (typeof ATTRIBUTION_RELATIONS)[number];

export interface NewObservation {
  kind: ObservationKind;
  schema_key: string;
  schema_version: number;
  summary: string;
  source: string;
  external_id?: string | null;
  external_url?: string | null;
  observed_at: string;
  payload: Record<string, unknown>;
  supersedes_observation_id?: string | null;
}

export interface PreparedObservation extends NewObservation {
  search_text: string;
}

export interface ObservationRecord {
  id: string;
  kind: ObservationKind;
  schema_key: string;
  schema_version: number;
  summary: string;
  source: string;
  external_id: string | null;
  external_url: string | null;
  observed_at: string;
  recorded_at: string;
  search_text: string;
  supersedes_observation_id: string | null;
  outcome: "created" | "existing";
}

export interface BacklogItemRecord {
  id: string;
  stable_id: string;
  title: string;
  summary: string;
  stage: BacklogStage;
  revision: number;
  superseded_by: string | null;
  created_at: string;
  updated_at: string;
}

export interface SemanticTargetRef {
  repository: string;
  stable_id: string;
}

export interface BacklogItemLinks {
  observation_ids: string[];
  stories: SemanticTargetRef[];
  acceptance_criteria: SemanticTargetRef[];
}

export interface BacklogItemSnapshot {
  item: BacklogItemRecord;
  links: BacklogItemLinks;
}

export interface BacklogReadStore {
  getBacklogItem(input: {
    stable_id: string;
  }): Promise<BacklogItemSnapshot | null>;
}

export type BacklogMutationResult =
  | { outcome: "applied"; item: BacklogItemRecord }
  | { outcome: "stale"; current_revision: number }
  | { outcome: "not_found" | "no_fields" };

export interface AttributionDecision {
  observation_id: string;
  target_kind: "story" | "acceptance_criterion" | "backlog_item";
  target: SemanticTargetRef | { stable_id: string };
  relation: AttributionRelation;
  decision: "confirmed" | "dismissed";
  decided_by?: string | null;
}

export interface AttributionDecisionRecord {
  observation_id: string;
  target_kind: AttributionDecision["target_kind"];
  target_id: string;
  target_stable_id: string;
  relation: AttributionRelation;
  state: "confirmed" | "dismissed";
  decided_by: string | null;
  decided_at: string;
}

export interface ObservationWriteStore {
  recordObservation(input: PreparedObservation): Promise<ObservationRecord>;
  decideAttribution(
    input: AttributionDecision
  ): Promise<AttributionDecisionRecord>;
}

export interface BacklogWriteStore {
  createBacklogItem(input: {
    stable_id?: string;
    title: string;
    summary: string;
    stage?: BacklogStage;
  }): Promise<BacklogItemRecord>;
  updateBacklogItem(input: {
    stable_id: string;
    expected_revision: number;
    title?: string;
    summary?: string;
    stage?: BacklogStage;
    superseded_by?: string | null;
  }): Promise<BacklogMutationResult>;
  setBacklogItemLinks(input: {
    stable_id: string;
    expected_revision: number;
    links: BacklogItemLinks;
  }): Promise<BacklogMutationResult & { links?: BacklogItemLinks }>;
}

export interface EvidenceWriteStore
  extends ObservationWriteStore,
    BacklogWriteStore {}

interface ObservationSchemaDefinition {
  kind: ObservationKind;
  schema_key: string;
  version: number;
  payload: z.ZodTypeAny;
  search_fields: string[];
}

const text = z.string().trim().min(1).max(16_000);
const textList = z.array(text).max(100);
const observationSchemas = new Map<string, ObservationSchemaDefinition>();

function schemaIdentity(schemaKey: string, version: number): string {
  return `${schemaKey}@${version}`;
}

export function registerObservationSchema(
  definition: ObservationSchemaDefinition
): void {
  const identity = schemaIdentity(definition.schema_key, definition.version);
  if (observationSchemas.has(identity)) {
    throw new Error(`Observation schema '${identity}' is already registered.`);
  }
  observationSchemas.set(identity, definition);
}

registerObservationSchema({
  kind: "request",
  schema_key: "request",
  version: 1,
  payload: z
    .object({
      requested_change: text.optional(),
      context: text.optional(),
      priority_signal: text.optional(),
      product_area: text.optional(),
    })
    .strict(),
  search_fields: [
    "requested_change",
    "context",
    "priority_signal",
    "product_area",
  ],
});

registerObservationSchema({
  kind: "bug",
  schema_key: "bug",
  version: 1,
  payload: z
    .object({
      expected_behavior: text.optional(),
      actual_behavior: text.optional(),
      reproduction: z.union([text, textList]).optional(),
      environment: text.optional(),
      severity: text.optional(),
    })
    .strict(),
  search_fields: [
    "expected_behavior",
    "actual_behavior",
    "reproduction",
    "environment",
    "severity",
  ],
});

registerObservationSchema({
  kind: "question",
  schema_key: "question",
  version: 1,
  payload: z
    .object({
      question: text.optional(),
      context: text.optional(),
      audience: text.optional(),
    })
    .strict(),
  search_fields: ["question", "context", "audience"],
});

export class EvidenceValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "EvidenceValidationError";
  }
}

function issueMessage(error: z.ZodError): string {
  return error.issues
    .map((issue) => {
      const field = issue.path.length > 0 ? issue.path.join(".") : "payload";
      return `${field}: ${issue.message}`;
    })
    .join("; ");
}

function searchableText(value: unknown): string[] {
  if (typeof value === "string") return [value];
  if (Array.isArray(value)) {
    return value.flatMap((entry) =>
      typeof entry === "string" ? [entry] : []
    );
  }
  return [];
}

const outboundObservationRedactions: Array<{
  pattern: RegExp;
  replacement: string;
}> = [
  {
    pattern: /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/giu,
    replacement: "[redacted-email]",
  },
  {
    pattern: /\bhttps?:\/\/[^\s<>"']+/giu,
    replacement: "[redacted-url]",
  },
  {
    pattern:
      /\b(?:api[_ -]?key|access[_ -]?token|token|password|secret)\s*[:=]\s*\S+/giu,
    replacement: "[redacted-credential]",
  },
  {
    pattern: /\b(?:sk-[A-Z0-9_-]{12,}|gh[opusr]_[A-Z0-9]{12,})\b/giu,
    replacement: "[redacted-credential]",
  },
  {
    pattern: /\b(?:\d[ -]?){13,19}\b/gu,
    replacement: "[redacted-payment-number]",
  },
  {
    pattern:
      /(?:\+\d{1,3}[\s.-]?)?(?:\(\d{2,4}\)|\d{2,4})[\s.-]\d{3}[\s.-]\d{4}\b/gu,
    replacement: "[redacted-phone]",
  },
];

/** Keep likely contact, payment, URL, and credential values out of remote embedding text. */
export function sanitizeObservationSearchText(value: string): string {
  return outboundObservationRedactions.reduce(
    (sanitized, redaction) =>
      sanitized.replace(redaction.pattern, redaction.replacement),
    value
  );
}

export function prepareObservation(input: NewObservation): PreparedObservation {
  const summary = input.summary.trim();
  if (!summary) {
    throw new EvidenceValidationError("Observation summary cannot be empty.");
  }
  if (Buffer.byteLength(summary, "utf8") > 4_000) {
    throw new EvidenceValidationError(
      "Observation summary must not exceed 4,000 UTF-8 bytes."
    );
  }
  if (!input.source.trim()) {
    throw new EvidenceValidationError("Observation source cannot be empty.");
  }
  if (Number.isNaN(Date.parse(input.observed_at))) {
    throw new EvidenceValidationError(
      "Observation observed_at must be an ISO-8601 timestamp."
    );
  }
  const payloadBytes = Buffer.byteLength(JSON.stringify(input.payload), "utf8");
  if (payloadBytes > 256 * 1024) {
    throw new EvidenceValidationError(
      "Observation payload must not exceed 256 KiB when serialized."
    );
  }

  const identity = schemaIdentity(input.schema_key, input.schema_version);
  const definition = observationSchemas.get(identity);
  if (!definition) {
    throw new EvidenceValidationError(
      `Unknown observation schema '${identity}'.`
    );
  }
  if (definition.kind !== input.kind) {
    throw new EvidenceValidationError(
      `Observation schema '${identity}' declares kind '${definition.kind}', not '${input.kind}'.`
    );
  }
  const parsed = definition.payload.safeParse(input.payload);
  if (!parsed.success) {
    throw new EvidenceValidationError(
      `Observation payload does not match '${identity}': ${issueMessage(parsed.error)}`
    );
  }
  const payload = parsed.data as Record<string, unknown>;
  const searchParts = [
    summary,
    ...definition.search_fields.flatMap((field) =>
      searchableText(payload[field])
    ),
  ];
  return {
    ...input,
    summary,
    source: input.source.trim(),
    external_id: input.external_id?.trim() || null,
    external_url: input.external_url?.trim() || null,
    payload,
    supersedes_observation_id:
      input.supersedes_observation_id?.trim() || null,
    search_text: sanitizeObservationSearchText(searchParts.join("\n")),
  };
}
