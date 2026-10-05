export interface GradingEvaluationCase {
  id: string;
  criterion: string;
  sources: Record<string, string>;
  links: string[];
  selection: "claims" | "impacted";
  initial: boolean;
  expectedGrades: Array<"supported" | "partial" | "unsupported" | "inconclusive">;
  expectedLinkFindings: string[];
}

/** Expectations belong to the evaluator, never the independent grader prompt. */
export const gradingCorpusVersion = 2;
export const gradingCases: readonly GradingEvaluationCase[] = [
  {
    id: "case-01", criterion: "Checkout must charge only after explicit confirmation.",
    sources: {
      "src/confirmation.ts": "export function confirmed(choice: string): boolean { return choice === 'confirm'; }\n",
      "src/checkout.ts": "import { confirmed } from './confirmation.js';\nexport function checkout(choice: string) { if (!confirmed(choice)) return { charged: false }; return { charged: true }; }\n",
    }, links: ["src/confirmation.ts", "src/checkout.ts"], selection: "claims", initial: true,
    expectedGrades: ["supported"], expectedLinkFindings: [],
  },
  {
    id: "case-02", criterion: "Both hosted and custom deployment checkout must require explicit confirmation.",
    sources: {
      "src/hosted.ts": "export function hostedCheckout(confirmed: boolean) { if (!confirmed) return { charged: false }; return { charged: true }; }\n",
      "src/custom.ts": "export function customCheckout() { return { charged: true }; }\n",
    }, links: ["src/hosted.ts", "src/custom.ts"], selection: "claims", initial: true,
    expectedGrades: ["partial", "unsupported"], expectedLinkFindings: [],
  },
  {
    id: "case-03", criterion: "New accounts must have market search disabled by default.",
    sources: {
      "src/accounts.ts": "export function createAccount() { return { marketSearch: false }; }\n",
      "src/legacy.ts": "// Historical migration; not imported or executed by account creation.\nexport function legacyAccountDefaults() { return { marketSearch: true }; }\n",
    }, links: ["src/accounts.ts", "src/legacy.ts"], selection: "claims", initial: true,
    expectedGrades: ["supported"], expectedLinkFindings: ["src/legacy.ts"],
  },
  {
    id: "case-04", criterion: "Checkout must require explicit confirmation.",
    sources: { "src/notes.md": "# Checkout\nThe implementation is maintained elsewhere; this file contains no implementation or executable test.\n" },
    links: ["src/notes.md"], selection: "claims", initial: true,
    expectedGrades: ["unsupported"], expectedLinkFindings: ["src/notes.md"],
  },
  {
    id: "case-05", criterion: "Checkout must charge only after explicit confirmation.",
    sources: { "src/checkout.ts": "export function checkout(confirmed: boolean) { return { charged: true }; }\n" },
    links: ["src/checkout.ts"], selection: "impacted", initial: false,
    expectedGrades: ["unsupported"], expectedLinkFindings: [],
  },
  {
    id: "case-06", criterion: "Checkout must charge only after explicit confirmation.",
    sources: { "src/checkout.ts": "export const heading = 'Your plan';\nexport function checkout(confirmed: boolean) { return { charged: confirmed }; }\n" },
    links: ["src/checkout.ts"], selection: "claims", initial: false,
    expectedGrades: [], expectedLinkFindings: [],
  },
  {
    id: "case-07", criterion: "Checkout must charge only after explicit confirmation.",
    sources: { "src/checkout.ts": "// This dependency's implementation and tests are unavailable in the supplied evidence.\nimport { processCheckout } from 'external-checkout-provider';\nexport function checkout(choice: string) { return processCheckout(choice); }\n" },
    links: ["src/checkout.ts"], selection: "claims", initial: true,
    expectedGrades: ["inconclusive"], expectedLinkFindings: [],
  },
];
