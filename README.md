# APEX Reference MCP

APEX Legends reference data MCP server. This package is scoped to factual reference lookup data and provenance tracking; gameplay judgment remains outside the server.

## Requirements

- Bun 1.3+

## Commands

```sh
bun install
bun run typecheck
bun test
bun run start
```

`bun run start` launches a stdio MCP server.

## Data Model

Reference records live under `data/references/*.json` and are validated by `src/reference/schema.ts`.

The schema distinguishes:

- stable facts vs patch-dependent facts
- official patch note, official document, manual verification, and derived provenance
- absolute values vs relative changes where no absolute value is known

Relative changes intentionally preserve direction only and do not invent numeric values.
