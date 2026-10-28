# Domain Docs

How the engineering skills should consume this repo's domain documentation when exploring the codebase.

## Before exploring, read these

- **`CONTEXT.md`** at the repo root (single context: domain + plugin vocabulary).
- **`docs/adr/`** -- read ADRs that touch the area you're about to work in; `docs/adr/st/` holds plugin-scoped decisions.

If any of these files don't exist, **proceed silently**. Don't flag their absence; don't suggest creating them upfront. The `/domain-modeling` skill (reached via `/grill-with-docs` and `/improve-codebase-architecture`) creates them lazily when terms or decisions actually get resolved.

## File structure

Single-context repo (this repo):

```
/
|- CONTEXT.md                         <- domain + plugin vocabulary (one glossary)
|- docs/adr/                          <- structural decisions
|- docs/adr/st/                       <- plugin-scoped decisions
`- src/
   |- features/                       <- memory, agent, fill-tasks, query-chat, macros, …
   |- infrastructure/                 <- indexeddb, sillytavern
   |- frontend/                       <- current pages / workspaces / ST wiring
   |- ui/                             <- shared primitives, pure UI models and legacy UI sources
   `- common/
```

Context ownership: the repo has exactly one context, so every term is defined once in
`CONTEXT.md`. The memory feature owns the shared domain model; other features read it
through `src/features/memory/index.ts`.

## Use the glossary's vocabulary

When your output names a domain concept (in an issue title, a refactor proposal, a hypothesis, a test name), use the term as defined in `CONTEXT.md`. Don't drift to synonyms the glossary explicitly avoids.

If the concept you need isn't in the glossary yet, that's a signal -- either you're inventing language the project doesn't use (reconsider) or there's a real gap (note it for `/domain-modeling`).

## Flag ADR conflicts

If your output contradicts an existing ADR, surface it explicitly rather than silently overriding:

> _Contradicts ADR-0007 (event-sourced orders) -- but worth reopening because..._
