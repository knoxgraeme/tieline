/** @deprecated Compatibility exports. New code imports the cohesive PostgreSQL repositories. */
export { getReadSql as getSql, getWriteSql, getIngestSql, getApprovalSql, closeConnections as closeSql } from "./adapters/postgres/connections.js";
export { vectorLiteral } from "./adapters/postgres/vector.js";
export * from "./adapters/postgres/search-repository.js";
export * from "./adapters/postgres/help-repository.js";
export * from "./adapters/postgres/story-repository.js";
export * from "./adapters/postgres/feature-request-repository.js";
export * from "./adapters/postgres/taxonomy-repository.js";
