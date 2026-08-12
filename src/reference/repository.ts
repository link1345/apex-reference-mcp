import { readdir, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { ReferenceCollectionSchema, type Reference, type ReferenceType } from "./schema.js";

const projectRoot = dirname(dirname(dirname(fileURLToPath(import.meta.url))));
const defaultDataDir = join(projectRoot, "data", "references");

export type ReferenceSearchResult = {
  id: string;
  name: string;
  type: ReferenceType;
  summary: string;
  patch: Reference["patch"];
  verifiedAt: string;
  source: Reference["provenance"][number];
  score: number;
};

export type ReferenceSearchOptions = {
  query: string;
  type?: ReferenceType;
  maxResults?: number;
};

export type ReferenceLookupCandidate = {
  id: string;
  name: string;
  type: ReferenceType;
  patch: Reference["patch"];
  verifiedAt: string;
  source: Reference["provenance"][number];
};

export type ReferenceLookupResult =
  | {
      found: true;
      resolvedBy: "id" | "name_type";
      reference: Reference;
      history?: ReferenceHistory;
    }
  | {
      found: false;
      reason:
        | "missing_identifier"
        | "type_required_with_name"
        | "reference_not_found"
        | "ambiguous_reference"
        | "version_not_found";
      candidates: ReferenceLookupCandidate[];
    };

export type ReferenceLookupOptions = {
  id?: string;
  name?: string;
  type?: ReferenceType;
  version?: string;
  patch?: string;
  at?: string;
  includeHistory?: boolean;
};

export type ReferenceHistory = {
  id: string;
  name: string;
  type: ReferenceType;
  basePatch: Reference["patch"];
  events: Reference["changeEvents"];
};

export type ReferenceHistoryResult =
  | {
      found: true;
      resolvedBy: "id" | "name_type";
      history: ReferenceHistory;
    }
  | {
      found: false;
      reason: "missing_identifier" | "type_required_with_name" | "reference_not_found" | "ambiguous_reference";
      candidates: ReferenceLookupCandidate[];
    };

type VersionSelector = {
  version?: string;
  at?: Date;
};

export class ReferenceRepository {
  constructor(private readonly dataDir = defaultDataDir) {}

  async listReferences(): Promise<Reference[]> {
    const fileNames = await readdir(this.dataDir);
    const references = await Promise.all(
      fileNames
        .filter((fileName) => fileName.endsWith(".json"))
        .sort()
        .map(async (fileName) => {
          const raw = await readFile(join(this.dataDir, fileName), "utf8");
          return ReferenceCollectionSchema.parse(JSON.parse(raw));
        })
    );

    return references.flat();
  }

  async getReferenceById(id: string): Promise<Reference | undefined> {
    const references = await this.listReferences();
    return references.find((reference) => reference.id === id);
  }

  async getReference(options: ReferenceLookupOptions): Promise<ReferenceLookupResult> {
    const selector = toVersionSelector(options);
    if (selector === undefined) {
      return { found: false, reason: "version_not_found", candidates: [] };
    }

    const identityResult = await this.resolveReferenceIdentity(options);

    if (!identityResult.found) {
      return identityResult;
    }

    const versionedReference = resolveReferenceVersion(identityResult.reference, selector);

    if (versionedReference === undefined) {
      return { found: false, reason: "version_not_found", candidates: [toLookupCandidate(identityResult.reference)] };
    }

    return {
      found: true,
      resolvedBy: identityResult.resolvedBy,
      reference: versionedReference,
      ...(options.includeHistory === true ? { history: toHistory(identityResult.reference) } : {})
    };
  }

  async getReferenceHistory(options: ReferenceLookupOptions): Promise<ReferenceHistoryResult> {
    const identityResult = await this.resolveReferenceIdentity(options);

    if (!identityResult.found) {
      return identityResult;
    }

    return {
      found: true,
      resolvedBy: identityResult.resolvedBy,
      history: toHistory(identityResult.reference)
    };
  }

  private async resolveReferenceIdentity(options: ReferenceLookupOptions): Promise<
    | {
        found: true;
        resolvedBy: "id" | "name_type";
        reference: Reference;
      }
    | {
        found: false;
        reason: "missing_identifier" | "type_required_with_name" | "reference_not_found" | "ambiguous_reference";
        candidates: ReferenceLookupCandidate[];
      }
  > {
    const id = options.id?.trim();
    const name = options.name?.trim();

    if (id !== undefined && id.length > 0) {
      const reference = await this.getReferenceById(id);

      if (reference !== undefined) {
        return { found: true, resolvedBy: "id", reference };
      }

      return { found: false, reason: "reference_not_found", candidates: [] };
    }

    if (name === undefined || name.length === 0) {
      return { found: false, reason: "missing_identifier", candidates: [] };
    }

    if (options.type === undefined) {
      return { found: false, reason: "type_required_with_name", candidates: [] };
    }

    const normalizedName = normalizeSearchText(name);
    const references = await this.listReferences();
    const matches = references.filter(
      (reference) =>
        reference.type === options.type &&
        (normalizeSearchText(reference.name) === normalizedName ||
          reference.aliases.some((alias) => normalizeSearchText(alias) === normalizedName))
    );

    if (matches.length === 1) {
      return { found: true, resolvedBy: "name_type", reference: matches[0]! };
    }

    if (matches.length > 1) {
      return { found: false, reason: "ambiguous_reference", candidates: matches.map(toLookupCandidate) };
    }

    return { found: false, reason: "reference_not_found", candidates: [] };
  }

  async searchReferences(options: ReferenceSearchOptions): Promise<ReferenceSearchResult[]> {
    const maxResults = Math.min(Math.max(options.maxResults ?? 10, 1), 25);
    const query = normalizeSearchText(options.query);
    const queryTokens = tokenizeSearchText(query);

    if (query.length === 0 || queryTokens.length === 0) {
      return [];
    }

    const references = await this.listReferences();
    return references
      .filter((reference) => options.type === undefined || reference.type === options.type)
      .map((reference) => {
        const latestReference = resolveReferenceVersion(reference, {}) ?? reference;
        const score = scoreReference(latestReference, query, queryTokens);
        return {
          id: latestReference.id,
          name: latestReference.name,
          type: latestReference.type,
          summary: latestReference.description,
          patch: latestReference.patch,
          verifiedAt: latestReference.verifiedAt,
          source: latestReference.provenance.at(-1)!,
          score
        };
      })
      .filter((result) => result.score > 0)
      .sort((left, right) => right.score - left.score || left.id.localeCompare(right.id))
      .slice(0, maxResults);
  }
}

function toVersionSelector(options: ReferenceLookupOptions): VersionSelector | undefined {
  const version = options.version?.trim() ?? options.patch?.trim();
  const at = options.at?.trim();

  if (at === undefined || at.length === 0) {
    return { version: version !== undefined && version.length > 0 ? version : undefined };
  }

  const timestamp = new Date(at);
  if (Number.isNaN(timestamp.valueOf())) {
    return undefined;
  }

  return { version: version !== undefined && version.length > 0 ? version : undefined, at: timestamp };
}

function resolveReferenceVersion(reference: Reference, selector: VersionSelector): Reference | undefined {
  if (reference.patch.mode === "stable") {
    return selector.version === undefined ? cloneReference(reference) : undefined;
  }

  const baseEffectiveFrom = new Date(reference.patch.effectiveFrom);
  if (selector.at !== undefined && selector.at < baseEffectiveFrom) {
    return undefined;
  }

  const events = reference.changeEvents
    .slice()
    .sort((left, right) => left.effectiveFrom.localeCompare(right.effectiveFrom) || left.id.localeCompare(right.id));

  if (selector.version !== undefined) {
    if (selector.version === reference.patch.version) {
      return cloneReference(reference);
    }

    const eventIndex = events.findIndex((event) => event.patch === selector.version);
    if (eventIndex === -1) {
      return undefined;
    }

    return applyChangeEvents(reference, events.slice(0, eventIndex + 1));
  }

  if (selector.at !== undefined) {
    const matchingEvents = events.filter((event) => new Date(event.effectiveFrom) <= selector.at!);
    return applyChangeEvents(reference, matchingEvents);
  }

  return applyChangeEvents(reference, events);
}

function applyChangeEvents(reference: Reference, events: Reference["changeEvents"]): Reference {
  const versioned = cloneReference(reference);

  for (const event of events) {
    const valueKey = toValueKey(event.fieldPath);
    const nextValue = event.newValue ?? event.oldValue;

    if (nextValue !== undefined) {
      versioned.values[valueKey] = nextValue;
      versioned.fieldProvenance[`values.${valueKey}`] = event.provenance;
    }

    versioned.patch = {
      mode: "patch_dependent",
      version: event.patch,
      effectiveFrom: event.effectiveFrom,
      effectiveTo: null
    };
  }

  if (events.length > 0) {
    versioned.provenance = [...versioned.provenance, ...events.map((event) => event.provenance)];
  }

  return versioned;
}

function toValueKey(fieldPath: string): string {
  return fieldPath.startsWith("values.") ? fieldPath.slice("values.".length) : fieldPath;
}

function toHistory(reference: Reference): ReferenceHistory {
  return {
    id: reference.id,
    name: reference.name,
    type: reference.type,
    basePatch: reference.patch,
    events: reference.changeEvents
      .slice()
      .sort((left, right) => left.effectiveFrom.localeCompare(right.effectiveFrom) || left.id.localeCompare(right.id))
  };
}

function cloneReference(reference: Reference): Reference {
  return structuredClone(reference);
}

function toLookupCandidate(reference: Reference): ReferenceLookupCandidate {
  return {
    id: reference.id,
    name: reference.name,
    type: reference.type,
    patch: reference.patch,
    verifiedAt: reference.verifiedAt,
    source: reference.provenance[0]!
  };
}

function scoreReference(reference: Reference, query: string, queryTokens: string[]): number {
  const id = normalizeSearchText(reference.id);
  const name = normalizeSearchText(reference.name);
  const aliases = reference.aliases.map(normalizeSearchText);
  const description = normalizeSearchText(reference.description);
  const valueKeys = Object.keys(reference.values).map(normalizeSearchText);
  const matchedTokens = new Set<string>();

  let score = 0;
  let phraseMatched = false;

  if (id === query || name === query || aliases.includes(query)) {
    score += 100;
    phraseMatched = true;
  }

  if (id.includes(query)) {
    score += 30;
    phraseMatched = true;
  }

  if (name.includes(query)) {
    score += 50;
    phraseMatched = true;
  }

  if (aliases.some((alias) => alias.includes(query))) {
    score += 45;
    phraseMatched = true;
  }

  for (const token of queryTokens) {
    if (id.includes(token)) {
      score += 8;
      matchedTokens.add(token);
    }
    if (name.includes(token)) {
      score += 12;
      matchedTokens.add(token);
    }
    if (aliases.some((alias) => alias.includes(token))) {
      score += 10;
      matchedTokens.add(token);
    }
    if (description.includes(token)) {
      score += 3;
      matchedTokens.add(token);
    }
    if (valueKeys.some((key) => key.includes(token))) {
      score += 4;
      matchedTokens.add(token);
    }
  }

  if (!phraseMatched && matchedTokens.size < Math.ceil(queryTokens.length / 2)) {
    return 0;
  }

  return score;
}

function normalizeSearchText(value: string): string {
  return value
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[_/.-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function tokenizeSearchText(value: string): string[] {
  return [...new Set(value.split(" ").filter((token) => token.length > 1 || /[^\x00-\x7F]/.test(token)))];
}
