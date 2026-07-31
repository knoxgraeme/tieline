export const STORY_LIFECYCLES = [
  "backlog",
  "in_progress",
  "production",
  "retired",
] as const;
export type StoryLifecycle = (typeof STORY_LIFECYCLES)[number];

export const CONTRACT_AUTHORITIES = ["planning", "repository"] as const;
export type ContractAuthority = (typeof CONTRACT_AUTHORITIES)[number];
