import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { ReferenceCollectionSchema, type Reference, type ReferenceType } from "./schema.js";

export type ReferenceValidationIssue = {
  referenceId?: string;
  code: "missing_provenance" | "missing_verified_at" | "missing_patch_effective_period" | "unreviewed_absolute_unknown";
  message: string;
};

export type ReferenceValidationReport = {
  valid: boolean;
  referenceCount: number;
  countsByType: Record<ReferenceType, number>;
  issueCount: number;
  unknownOrRelativeCount: number;
  issues: ReferenceValidationIssue[];
};

const referenceTypes: ReferenceType[] = ["weapon", "legend", "item", "mechanic"];

export async function validateReferenceData(dataDir: string): Promise<ReferenceValidationReport> {
  const references = await readReferences(dataDir);
  const issues: ReferenceValidationIssue[] = [];

  for (const reference of references) {
    if (reference.provenance.length === 0) {
      issues.push({
        referenceId: reference.id,
        code: "missing_provenance",
        message: "Reference has no provenance entries."
      });
    }

    if (reference.verifiedAt.trim().length === 0) {
      issues.push({
        referenceId: reference.id,
        code: "missing_verified_at",
        message: "Reference has no verifiedAt timestamp."
      });
    }

    if (reference.patch.mode === "patch_dependent" && reference.patch.effectiveFrom.trim().length === 0) {
      issues.push({
        referenceId: reference.id,
        code: "missing_patch_effective_period",
        message: "Patch-dependent Reference has no effectiveFrom timestamp."
      });
    }

    for (const [key, value] of Object.entries(reference.values)) {
      if (key.toLowerCase().includes("unknown") && value.kind === "absolute" && typeof value.value === "number") {
        issues.push({
          referenceId: reference.id,
          code: "unreviewed_absolute_unknown",
          message: `Value ${key} stores a numeric absolute value even though it is marked unknown.`
        });
      }
    }
  }

  return {
    valid: issues.length === 0,
    referenceCount: references.length,
    countsByType: Object.fromEntries(
      referenceTypes.map((type) => [type, references.filter((reference) => reference.type === type).length])
    ) as Record<ReferenceType, number>,
    issueCount: issues.length,
    unknownOrRelativeCount: references.reduce(
      (count, reference) =>
        count +
        Object.values(reference.values).filter((value) => value.kind === "unknown" || value.kind === "relative_change").length,
      0
    ),
    issues
  };
}

async function readReferences(dataDir: string): Promise<Reference[]> {
  const fileNames = await readdir(dataDir);
  const collections = await Promise.all(
    fileNames
      .filter((fileName) => fileName.endsWith(".json"))
      .sort()
      .map(async (fileName) => {
        const raw = await readFile(join(dataDir, fileName), "utf8");
        return ReferenceCollectionSchema.parse(JSON.parse(raw));
      })
  );

  return collections.flat();
}
