# Authoring contract

## Authority

| Lifecycle | Authority | Writer |
| --- | --- | --- |
| `backlog` | `planning` | Planning MCP tools |
| `in_progress` | `repository` | YAML + pull request |
| `production` | `repository` | YAML + pull request |
| `retired` | `repository` | YAML + pull request |

The same Story and AC stable IDs cross the boundary. A merged repository record
claims a planning Story only when `planning_origin.record_id` and `revision`
identify it.

## YAML shape

```yaml
version: 1
capability:
  key: CAP-SEARCH
  name: Semantic retrieval
  description: Find business behavior and its evidence.
  stories:
    - key: US-SEARCH-001
      title: Find behavior related to a report
      actor: support teammate
      goal: find the behavior related to a customer report
      benefit: I can answer with current product context
      lifecycle: production
      aliases:
        - Locate the responsible feature
      planning_origin:
        record_id: 00000000-0000-4000-8000-000000000001
        revision: 2
      acceptance_criteria:
        - key: AC-SEARCH-001
          criterion: Search results must identify the matched semantic level
          rationale: Callers need to distinguish broad intent from an edge case.
          scenarios:
            - name: Scenario-level match
              given: a query matches an edge-case scenario
              when: semantic results are returned
              then: the parent AC and Story are included
          links:
            - relation: implements
              provenance: authored
              target:
                kind: code
                repository: tieline
                path: src/tools/find_related.ts
            - relation: tests
              provenance: authored
              target:
                kind: test
                repository: tieline
                path: tests/unit/retrieval/test-ranking.ts
                framework_hint: custom-script
```

Accepted Stories require actor, goal, benefit, and at least one complete AC.
Aliases preserve alternative phrasing. Supersession preserves identity when two
contract records are intentionally consolidated.
Every link requires `provenance`: `authored` for a deliberate claim, `inferred`
for a derived claim, or `materialized` for a copied projection.
