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
- baseline values vs chronological change events for patch-dependent records

Relative changes intentionally preserve direction only and do not invent numeric values.

## Tools

### `search_reference`

Searches local Reference records by `name`, `aliases`, `description`, and value keys.

Input:

- `query` required string
- `type` optional filter: `weapon`, `legend`, `item`, or `mechanic`
- `maxResults` optional result limit from 1 to 25

Each result includes `id`, `name`, `type`, `summary`, `patch`, `verifiedAt`, `source`, and `score`, so a client can pass the returned `id` to a later detail lookup tool.

### `get_reference`

Gets one complete Reference record.

Input:

- `id` optional Reference ID. When present, this is used directly.
- `name` optional exact name or alias.
- `type` optional filter required when resolving by `name`: `weapon`, `legend`, `item`, or `mechanic`.
- `version` optional exact patch/version label.
- `patch` optional alias for `version`.
- `at` optional ISO timestamp used to resolve the Reference valid at that time.
- `includeHistory` optional boolean to include chronological change events with the resolved Reference.

Successful responses include `found: true`, `resolvedBy`, and the full `reference` record with `source`/`provenance`, `verifiedAt`, and `patch` metadata. When no version selector is provided, patch-dependent records resolve to the latest known version. Missing IDs, missing `type` for name lookup, missing versions, and ambiguous name/type matches return `found: false` with a machine-readable `reason`; ambiguous lookups also include candidate records.

For patch-dependent records, the server applies `changeEvents` in chronological order to the baseline values. Explicit `oldValue`/`newValue` changes such as `11 -> 12` become absolute values for the resolved version. Relative changes without absolute values remain `relative_change` values and are not converted into invented numbers.

### `get_reference_history`

Gets chronological change history for one Reference record.

Input:

- `id` optional Reference ID. When present, this is used directly.
- `name` optional exact name or alias.
- `type` optional filter required when resolving by `name`: `weapon`, `legend`, `item`, or `mechanic`.

Successful responses include `found: true`, `resolvedBy`, and `history` with the baseline patch and ordered `events`.
