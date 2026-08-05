# Domain Docs

How the engineering skills should consume this repo's domain documentation when exploring the codebase.

## Before exploring, read these

- **`CONTEXT.md`** at the repo root, or
- **`CONTEXT-MAP.md`** at the repo root if it exists -- it points at one `CONTEXT.md` per context. Read each one relevant to the topic.
- **`docs/adr/`** -- read ADRs that touch the area you're about to work in. In multi-context repos, also check `src/<context>/docs/adr/` for context-scoped decisions.

If any of these files don't exist, **proceed silently**. Don't flag their absence; don't suggest creating them upfront. The `/domain-modeling` skill (reached via `/grill-with-docs` and `/improve-codebase-architecture`) creates them lazily when terms or decisions actually get resolved.

## File structure

Multi-context repo (this repo — `CONTEXT-MAP.md` exists at the root):

```
/
|- CONTEXT-MAP.md                     <- read first: which context owns what
|- docs/adr/                          <- system-wide decisions
|- core/
|  |- CONTEXT.md                      <- domain vocabulary (memory tables, evidence, revisions, spaces…)
|  `- docs/adr/                       <- core-scoped decisions (created lazily)
`- apps/
   |- CONTEXT.md                      <- app-layer vocabulary, shared by apps/api + apps/web
   |- docs/adr/                       <- app-scoped decisions (created lazily)
   |- api/
   `- web/
```

Context ownership:

- The **core** context owns the domain vocabulary; every other context reads it without redefining it.
- The **apps** context is one context shared by `apps/api` and `apps/web` — they are a pair with one vocabulary; never define an app-layer term for only one of them.

## Use the glossary's vocabulary

When your output names a domain concept (in an issue title, a refactor proposal, a hypothesis, a test name), use the term as defined in `CONTEXT.md`. Don't drift to synonyms the glossary explicitly avoids.

If the concept you need isn't in the glossary yet, that's a signal -- either you're inventing language the project doesn't use (reconsider) or there's a real gap (note it for `/domain-modeling`).

## Flag ADR conflicts

If your output contradicts an existing ADR, surface it explicitly rather than silently overriding:

> _Contradicts ADR-0007 (event-sourced orders) -- but worth reopening because..._
