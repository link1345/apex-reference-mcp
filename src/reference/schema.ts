import * as z from "zod/v4";

export const ReferenceTypeSchema = z.enum(["weapon", "legend", "item", "mechanic"]);

export const SourceTypeSchema = z.enum([
  "official_patch_note",
  "official_document",
  "manual_verified",
  "derived_from_change_history"
]);

export const EvidenceLevelSchema = z.enum([
  "explicit_absolute_value",
  "explicit_relative_change",
  "manual_confirmation",
  "derived"
]);

export const ProvenanceSchema = z.object({
  sourceType: SourceTypeSchema,
  sourceUrl: z.url().optional(),
  sourceId: z.string().min(1).optional(),
  sourcePublishedAt: z.iso.datetime().optional(),
  effectiveFrom: z.iso.datetime().optional(),
  effectiveTo: z.iso.datetime().nullable().optional(),
  confidence: z.number().min(0).max(1),
  evidenceLevel: EvidenceLevelSchema,
  evidence: z.string().min(1).optional()
}).refine(
  (value) => value.sourceUrl !== undefined || value.sourceId !== undefined,
  "provenance requires sourceUrl or sourceId"
);

export const ReferenceValueSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("absolute"),
    value: z.union([z.string(), z.number(), z.boolean(), z.null(), z.array(z.unknown()), z.record(z.string(), z.unknown())]),
    unit: z.string().optional()
  }),
  z.object({
    kind: z.literal("relative_change"),
    direction: z.enum(["increase", "decrease", "add", "remove", "unknown"]),
    amount: z.union([z.number(), z.string()]).optional(),
    unit: z.string().optional()
  }),
  z.object({
    kind: z.literal("unknown"),
    reason: z.string().min(1)
  })
]);

export const PatchInfoSchema = z.discriminatedUnion("mode", [
  z.object({
    mode: z.literal("stable")
  }),
  z.object({
    mode: z.literal("patch_dependent"),
    version: z.string().min(1),
    effectiveFrom: z.iso.datetime(),
    effectiveTo: z.iso.datetime().nullable().optional()
  })
]);

export const ChangeEventSchema = z.object({
  id: z.string().min(1),
  fieldPath: z.string().min(1),
  changeType: z.enum(["set", "increase", "decrease", "add", "remove", "unknown"]),
  oldValue: ReferenceValueSchema.optional(),
  newValue: ReferenceValueSchema.optional(),
  patch: z.string().min(1),
  effectiveFrom: z.iso.datetime(),
  provenance: ProvenanceSchema
});

export const ReferenceSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  type: ReferenceTypeSchema,
  aliases: z.array(z.string().min(1)).default([]),
  description: z.string().min(1),
  verifiedAt: z.iso.datetime(),
  patch: PatchInfoSchema,
  values: z.record(z.string(), ReferenceValueSchema).default({}),
  provenance: z.array(ProvenanceSchema).min(1),
  fieldProvenance: z.record(z.string(), ProvenanceSchema).default({}),
  changeEvents: z.array(ChangeEventSchema).default([])
});

export const ReferenceCollectionSchema = z.array(ReferenceSchema);

export const ReferenceChangeCandidateSchema = z.object({
  id: z.string().min(1),
  referenceId: z.string().min(1).optional(),
  referenceName: z.string().min(1),
  type: ReferenceTypeSchema,
  fieldPath: z.string().min(1),
  changeType: z.enum(["set", "increase", "decrease", "add", "remove", "unknown"]),
  oldValue: ReferenceValueSchema.optional(),
  newValue: ReferenceValueSchema.optional(),
  patch: z.string().min(1),
  effectiveFrom: z.iso.datetime(),
  source: ProvenanceSchema,
  confidence: z.number().min(0).max(1),
  evidence: z.string().min(1),
  status: z.enum(["applicable", "new_entity", "review_required", "duplicate"]),
  reviewReason: z.string().min(1).optional(),
  approved: z.boolean().default(false)
});

export const ReferenceChangeCandidateCollectionSchema = z.array(ReferenceChangeCandidateSchema);

export type Reference = z.infer<typeof ReferenceSchema>;
export type ReferenceCollection = z.infer<typeof ReferenceCollectionSchema>;
export type ReferenceType = z.infer<typeof ReferenceTypeSchema>;
export type ReferenceChangeCandidate = z.infer<typeof ReferenceChangeCandidateSchema>;
