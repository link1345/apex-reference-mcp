import { readFile, writeFile } from "node:fs/promises";
import { basename } from "node:path";
import {
  ChangeEventSchema,
  ReferenceChangeCandidateCollectionSchema,
  ReferenceCollectionSchema,
  type Reference,
  type ReferenceChangeCandidate,
  type ReferenceType
} from "./schema.js";
import { ReferenceRepository } from "./repository.js";

export type ExtractReleaseNoteOptions = {
  inputText: string;
  sourceUrl?: string;
  sourceId?: string;
  sourcePublishedAt?: string;
  patch: string;
  effectiveFrom: string;
  repository?: ReferenceRepository;
};

export type ApplyApprovedChangeOptions = {
  candidates: ReferenceChangeCandidate[];
  referenceFilePath: string;
};

type ParsedLine = {
  referenceName: string;
  type: ReferenceType;
  fieldPath: string;
  changeType: ReferenceChangeCandidate["changeType"];
  oldValue?: ReferenceChangeCandidate["oldValue"];
  newValue?: ReferenceChangeCandidate["newValue"];
  confidence: number;
  evidence: string;
};

const typeMatchers: Array<[ReferenceType, RegExp]> = [
  ["weapon", /\b(weapon|smg|rifle|shotgun|pistol|lmg|marksman|sniper|r-?99|r99|peacekeeper|flatline|wingman)\b/i],
  ["legend", /\b(legend|wraith|lifeline|pathfinder|bangalore|bloodhound|ability|tactical|ultimate|passive)\b/i],
  ["item", /\b(item|shield battery|battery|med kit|syringe|shield cell|grenade|backpack|helmet)\b/i],
  ["mechanic", /\b(mechanic|knock|revive|inventory|shield crack|healing cancel|cancel)\b/i]
];

export async function extractReleaseNoteCandidates(
  options: ExtractReleaseNoteOptions
): Promise<ReferenceChangeCandidate[]> {
  const repository = options.repository ?? new ReferenceRepository();
  const references = await repository.listReferences();
  const parsedLines = options.inputText
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .map(parseReleaseNoteLine)
    .filter((line): line is ParsedLine => line !== undefined);

  const seenIds = new Set<string>();
  const candidates = parsedLines.map((line) => {
    const matchedReference = resolveReference(references, line.referenceName, line.type);
    const eventId = makeChangeId(options.patch, matchedReference?.id ?? `${line.type}.${line.referenceName}`, line.fieldPath);
    const status = classifyCandidate(line, matchedReference, eventId, seenIds);
    seenIds.add(eventId);

    return {
      id: eventId,
      ...(matchedReference === undefined ? {} : { referenceId: matchedReference.id }),
      referenceName: line.referenceName,
      type: line.type,
      fieldPath: line.fieldPath,
      changeType: line.changeType,
      ...(line.oldValue === undefined ? {} : { oldValue: line.oldValue }),
      ...(line.newValue === undefined ? {} : { newValue: line.newValue }),
      patch: options.patch,
      effectiveFrom: options.effectiveFrom,
      source: {
        sourceType: "official_patch_note",
        ...(options.sourceUrl === undefined ? {} : { sourceUrl: options.sourceUrl }),
        sourceId: options.sourceId ?? options.sourceUrl ?? "release-note-text",
        ...(options.sourcePublishedAt === undefined ? {} : { sourcePublishedAt: options.sourcePublishedAt }),
        effectiveFrom: options.effectiveFrom,
        confidence: line.confidence,
        evidenceLevel:
          line.oldValue?.kind === "absolute" || line.newValue?.kind === "absolute"
            ? "explicit_absolute_value"
            : "explicit_relative_change",
        evidence: line.evidence
      },
      confidence: line.confidence,
      evidence: line.evidence,
      status: status.status,
      ...(status.reviewReason === undefined ? {} : { reviewReason: status.reviewReason }),
      approved: false
    } satisfies ReferenceChangeCandidate;
  });

  return ReferenceChangeCandidateCollectionSchema.parse(candidates);
}

export async function extractReleaseNoteCandidatesFromFile(
  inputPath: string,
  options: Omit<ExtractReleaseNoteOptions, "inputText" | "sourceId">
): Promise<ReferenceChangeCandidate[]> {
  const inputText = await readFile(inputPath, "utf8");
  return extractReleaseNoteCandidates({
    ...options,
    inputText,
    sourceId: options.sourceUrl ?? basename(inputPath)
  });
}

export async function writeChangeCandidates(outputPath: string, candidates: ReferenceChangeCandidate[]): Promise<void> {
  const validated = ReferenceChangeCandidateCollectionSchema.parse(candidates);
  await writeFile(outputPath, `${JSON.stringify(validated, null, 2)}\n`);
}

export async function applyApprovedChangeCandidates(options: ApplyApprovedChangeOptions): Promise<{
  applied: number;
  skipped: number;
  referenceCount: number;
}> {
  const raw = await readFile(options.referenceFilePath, "utf8");
  const references = ReferenceCollectionSchema.parse(JSON.parse(raw));
  let applied = 0;
  let skipped = 0;

  for (const candidate of ReferenceChangeCandidateCollectionSchema.parse(options.candidates)) {
    if (!candidate.approved || candidate.status !== "applicable" || candidate.referenceId === undefined) {
      skipped += 1;
      continue;
    }

    const reference = references.find((item) => item.id === candidate.referenceId);
    if (reference === undefined || reference.changeEvents.some((event) => event.id === candidate.id)) {
      skipped += 1;
      continue;
    }

    const changeEvent = ChangeEventSchema.parse({
      id: candidate.id,
      fieldPath: candidate.fieldPath,
      changeType: candidate.changeType,
      ...(candidate.oldValue === undefined ? {} : { oldValue: candidate.oldValue }),
      ...(candidate.newValue === undefined ? {} : { newValue: candidate.newValue }),
      patch: candidate.patch,
      effectiveFrom: candidate.effectiveFrom,
      provenance: candidate.source
    });

    reference.changeEvents.push(changeEvent);
    applied += 1;
  }

  const validated = ReferenceCollectionSchema.parse(references);
  await writeFile(options.referenceFilePath, `${JSON.stringify(validated, null, 2)}\n`);

  return {
    applied,
    skipped,
    referenceCount: validated.length
  };
}

export async function readChangeCandidates(inputPath: string): Promise<ReferenceChangeCandidate[]> {
  const raw = await readFile(inputPath, "utf8");
  return ReferenceChangeCandidateCollectionSchema.parse(JSON.parse(raw));
}

function parseReleaseNoteLine(line: string): ParsedLine | undefined {
  const normalized = line.replace(/^[-*]\s+/, "").trim();
  const explicitMatch = normalized.match(
    /^(?<name>[^:]+):?\s+(?<field>[A-Za-z][A-Za-z0-9_. -]*)\s+(?<old>-?\d+(?:\.\d+)?)\s*->\s*(?<next>-?\d+(?:\.\d+)?)(?:\s*(?<unit>[A-Za-z%]+))?/i
  );

  if (explicitMatch?.groups !== undefined) {
    const unit = explicitMatch.groups.unit;
    return {
      referenceName: cleanName(explicitMatch.groups.name),
      type: inferType(explicitMatch.groups.name),
      fieldPath: toValueFieldPath(explicitMatch.groups.field),
      changeType: "set",
      oldValue: {
        kind: "absolute",
        value: Number(explicitMatch.groups.old),
        ...(unit === undefined ? {} : { unit })
      },
      newValue: {
        kind: "absolute",
        value: Number(explicitMatch.groups.next),
        ...(unit === undefined ? {} : { unit })
      },
      confidence: 0.95,
      evidence: normalized
    };
  }

  const relativeMatch = normalized.match(
    /^(?<name>[^:]+):?\s+(?<field>[A-Za-z][A-Za-z0-9_. -]*)\s+(?<direction>increased|decreased|reduced|added|removed)\b/i
  );

  if (relativeMatch?.groups !== undefined) {
    const direction = relativeMatch.groups.direction.toLowerCase();
    return {
      referenceName: cleanName(relativeMatch.groups.name),
      type: inferType(relativeMatch.groups.name),
      fieldPath: toValueFieldPath(relativeMatch.groups.field),
      changeType: toChangeType(direction),
      newValue:
        direction === "removed"
          ? {
              kind: "relative_change",
              direction: "remove"
            }
          : {
              kind: "relative_change",
              direction: toRelativeDirection(direction)
            },
      confidence: 0.72,
      evidence: normalized
    };
  }

  return undefined;
}

function classifyCandidate(
  line: ParsedLine,
  reference: Reference | undefined,
  eventId: string,
  seenIds: Set<string>
): Pick<ReferenceChangeCandidate, "status" | "reviewReason"> {
  if (seenIds.has(eventId)) {
    return { status: "duplicate", reviewReason: "same source, patch, entity, and field already produced a candidate" };
  }

  if (reference === undefined) {
    return { status: "new_entity", reviewReason: "no existing Reference matched this entity candidate" };
  }

  if (reference.changeEvents.some((event) => event.id === eventId)) {
    return { status: "duplicate", reviewReason: "matching change event already exists in Reference history" };
  }

  if (line.oldValue !== undefined) {
    const currentValue = getCurrentValue(reference, line.fieldPath);
    if (currentValue !== undefined && !referenceValuesEqual(currentValue, line.oldValue)) {
      return { status: "review_required", reviewReason: "oldValue does not match the latest known Reference value" };
    }
  }

  return { status: "applicable" };
}

function resolveReference(references: Reference[], name: string, type: ReferenceType): Reference | undefined {
  const normalizedName = normalize(name);
  return references.find(
    (reference) =>
      reference.type === type &&
      (normalize(reference.name) === normalizedName ||
        reference.aliases.some((alias) => normalize(alias) === normalizedName) ||
        normalize(reference.id).includes(normalizedName))
  );
}

function getCurrentValue(reference: Reference, fieldPath: string): Reference["values"][string] | undefined {
  const key = fieldPath.startsWith("values.") ? fieldPath.slice("values.".length) : fieldPath;
  const latestEvent = reference.changeEvents
    .filter((event) => event.fieldPath === fieldPath && event.newValue !== undefined)
    .sort((left, right) => right.effectiveFrom.localeCompare(left.effectiveFrom) || right.id.localeCompare(left.id))[0];

  return latestEvent?.newValue ?? reference.values[key];
}

function referenceValuesEqual(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function inferType(text: string): ReferenceType {
  for (const [type, matcher] of typeMatchers) {
    if (matcher.test(text)) {
      return type;
    }
  }

  return "mechanic";
}

function toChangeType(value: string): ReferenceChangeCandidate["changeType"] {
  if (value === "increased") {
    return "increase";
  }
  if (value === "decreased" || value === "reduced") {
    return "decrease";
  }
  if (value === "added") {
    return "add";
  }
  if (value === "removed") {
    return "remove";
  }
  return "unknown";
}

function toRelativeDirection(value: string): "increase" | "decrease" | "add" | "remove" | "unknown" {
  if (value === "increased") {
    return "increase";
  }
  if (value === "decreased" || value === "reduced") {
    return "decrease";
  }
  if (value === "added") {
    return "add";
  }
  if (value === "removed") {
    return "remove";
  }
  return "unknown";
}

function cleanName(value: string): string {
  return value.replace(/\b(weapon|legend|item|mechanic)\b/gi, "").replace(/\s+/g, " ").trim();
}

function toValueFieldPath(value: string): string {
  return `values.${value.trim().toLowerCase().replace(/[^a-z0-9]+/g, ".").replace(/^\.+|\.+$/g, "")}`;
}

function makeChangeId(patch: string, referenceKey: string, fieldPath: string): string {
  return [patch, referenceKey, fieldPath]
    .join("-")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function normalize(value: string): string {
  return value
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[_/.-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}
