import { afterEach, describe, expect, test } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { ReferenceRepository } from "../src/reference/repository.js";
import {
  applyApprovedChangeCandidates,
  extractReleaseNoteCandidates,
  writeChangeCandidates
} from "../src/reference/changePipeline.js";
import { validateReferenceData } from "../src/reference/validation.js";
import { createApexReferenceServer } from "../src/server.js";

const repository = new ReferenceRepository();

describe("reference data model", () => {
  test("loads sample references from static JSON", async () => {
    const references = await repository.listReferences();

    expect(references.length).toBeGreaterThanOrEqual(20);
    expect(references.map((reference) => reference.id)).toContain("item.shield_battery");
  });

  test("loads MVP data across every major reference category", async () => {
    const references = await repository.listReferences();
    const ids = references.map((reference) => reference.id);

    expect(references.length).toBeLessThanOrEqual(50);
    expect(new Set(references.map((reference) => reference.type))).toEqual(
      new Set(["weapon", "legend", "item", "mechanic"])
    );
    expect(ids).toEqual(expect.arrayContaining([
      "item.shield_cell",
      "item.med_kit",
      "weapon.r301_carbine",
      "weapon.peacekeeper",
      "mechanic.knockdown",
      "mechanic.healing_cancel",
      "legend.lifeline",
      "legend.bangalore"
    ]));
  });

  test("distinguishes stable and patch-dependent references", async () => {
    const references = await repository.listReferences();
    const stable = references.find((reference) => reference.patch.mode === "stable");
    const patchDependent = references.find((reference) => reference.patch.mode === "patch_dependent");

    expect(stable).toBeDefined();
    expect(references.find((reference) => reference.id === "item.shield_battery")?.patch.mode).toBe("stable");
    expect(patchDependent?.patch.mode).toBe("patch_dependent");
  });

  test("tracks official patch note provenance for sample values", async () => {
    const reference = await repository.getReferenceById("weapon.r99_smg.damage");

    expect(reference?.fieldProvenance["values.damage.body"]?.sourceType).toBe("official_patch_note");
    expect(reference?.fieldProvenance["values.damage.body"]?.effectiveFrom).toBe("2026-07-01T00:00:00.000Z");
  });

  test("keeps relative changes without inventing absolute numbers", async () => {
    const reference = await repository.getReferenceById("weapon.sample_spread.relative");
    const spread = reference?.values.spread;

    expect(spread?.kind).toBe("relative_change");
    expect(spread).not.toHaveProperty("amount");
  });

  test("searches references by English query, aliases, type, and limit", async () => {
    const byName = await repository.searchReferences({ query: "shield battery" });
    expect(byName[0]?.id).toBe("item.shield_battery");
    expect(byName[0]?.source.sourceType).toBe("manual_verified");

    const byAlias = await repository.searchReferences({ query: "バッテリー" });
    expect(byAlias[0]?.id).toBe("item.shield_battery");

    const weapons = await repository.searchReferences({ query: "sample", type: "weapon", maxResults: 1 });
    expect(weapons).toHaveLength(1);
    expect(weapons[0]?.type).toBe("weapon");

    const noMatch = await repository.searchReferences({ query: "not-a-real-reference" });
    expect(noMatch).toEqual([]);
  });

  test("searches MVP records by practical video review categories", async () => {
    const item = await repository.searchReferences({ query: "シールドセル", type: "item" });
    expect(item[0]?.id).toBe("item.shield_cell");

    const weapon = await repository.searchReferences({ query: "Peacekeeper", type: "weapon" });
    expect(weapon[0]?.id).toBe("weapon.peacekeeper");

    const mechanic = await repository.searchReferences({ query: "回復キャンセル", type: "mechanic" });
    expect(mechanic[0]?.id).toBe("mechanic.healing_cancel");

    const legend = await repository.searchReferences({ query: "バンガ", type: "legend" });
    expect(legend[0]?.id).toBe("legend.bangalore");
  });

  test("gets complete references by id and exact name plus type", async () => {
    const byId = await repository.getReference({ id: "item.shield_battery" });
    expect(byId.found).toBe(true);
    expect(byId.found ? byId.resolvedBy : "").toBe("id");
    expect(byId.found ? byId.reference : undefined).toMatchObject({
      id: "item.shield_battery",
      type: "item",
      verifiedAt: "2026-08-12T00:00:00.000Z",
      patch: {
        mode: "stable"
      }
    });

    const byName = await repository.getReference({ name: "R99", type: "weapon" });
    expect(byName.found).toBe(true);
    expect(byName.found ? byName.resolvedBy : "").toBe("name_type");
    expect(byName.found ? byName.reference.id : "").toBe("weapon.r99_smg.damage");
    expect(byName.found ? byName.reference.provenance[0]?.sourceType : "").toBe("official_patch_note");

    const mvpRecord = await repository.getReference({ id: "mechanic.inventory_movement" });
    expect(mvpRecord.found).toBe(true);
    expect(mvpRecord.found ? mvpRecord.reference.values.exactConstraints : undefined).toMatchObject({
      kind: "unknown"
    });
  });

  test("resolves latest and historical patch-dependent references", async () => {
    const latest = await repository.getReference({ id: "weapon.r99_smg.damage" });
    expect(latest.found).toBe(true);
    expect(latest.found ? latest.reference.patch : undefined).toMatchObject({
      mode: "patch_dependent",
      version: "sample-season-2"
    });
    expect(latest.found ? latest.reference.values["damage.body"] : undefined).toEqual({
      kind: "absolute",
      value: 13
    });

    const baseline = await repository.getReference({ id: "weapon.r99_smg.damage", version: "sample-preseason" });
    expect(baseline.found).toBe(true);
    expect(baseline.found ? baseline.reference.values["damage.body"] : undefined).toEqual({
      kind: "absolute",
      value: 11
    });

    const firstPatch = await repository.getReference({ id: "weapon.r99_smg.damage", patch: "sample-season" });
    expect(firstPatch.found).toBe(true);
    expect(firstPatch.found ? firstPatch.reference.values["damage.body"] : undefined).toEqual({
      kind: "absolute",
      value: 12
    });

    const byDate = await repository.getReference({
      id: "weapon.r99_smg.damage",
      at: "2026-08-15T00:00:00.000Z"
    });
    expect(byDate.found).toBe(true);
    expect(byDate.found ? byDate.reference.patch : undefined).toMatchObject({
      mode: "patch_dependent",
      version: "sample-season"
    });
    expect(byDate.found ? byDate.reference.values["damage.body"] : undefined).toEqual({
      kind: "absolute",
      value: 12
    });
  });

  test("does not fall back to another version when the requested version is absent", async () => {
    const missingVersion = await repository.getReference({
      id: "weapon.r99_smg.damage",
      version: "not-a-real-patch"
    });

    expect(missingVersion.found).toBe(false);
    expect(missingVersion.found ? "" : missingVersion.reason).toBe("version_not_found");

    const beforeBaseline = await repository.getReference({
      id: "weapon.r99_smg.damage",
      at: "2026-01-01T00:00:00.000Z"
    });
    expect(beforeBaseline.found).toBe(false);
    expect(beforeBaseline.found ? "" : beforeBaseline.reason).toBe("version_not_found");
  });

  test("returns chronological history and keeps relative changes as relative", async () => {
    const withHistory = await repository.getReference({
      id: "weapon.r99_smg.damage",
      includeHistory: true
    });
    expect(withHistory.found).toBe(true);
    expect(withHistory.found ? withHistory.history?.events.map((event) => event.patch) : []).toEqual([
      "sample-season",
      "sample-season-2"
    ]);

    const history = await repository.getReferenceHistory({ id: "weapon.r99_smg.damage" });
    expect(history.found).toBe(true);
    expect(history.found ? history.history.events : []).toHaveLength(2);
    expect(history.found ? history.history.events[0]?.oldValue : undefined).toEqual({
      kind: "absolute",
      value: 11
    });

    const relative = await repository.getReference({ id: "weapon.sample_spread.relative" });
    expect(relative.found).toBe(true);
    expect(relative.found ? relative.reference.values.spread : undefined).toEqual({
      kind: "relative_change",
      direction: "decrease"
    });
  });

  test("returns explicit lookup errors and ambiguity candidates", async () => {
    const notFound = await repository.getReference({ id: "item.not_real" });
    expect(notFound).toEqual({
      found: false,
      reason: "reference_not_found",
      candidates: []
    });

    const missingType = await repository.getReference({ name: "Shield Battery" });
    expect(missingType).toEqual({
      found: false,
      reason: "type_required_with_name",
      candidates: []
    });

    const tempDir = await mkdtemp(join(tmpdir(), "apex-reference-"));
    try {
      await writeFile(
        join(tempDir, "ambiguous.json"),
        JSON.stringify([
          makeTestReference("item.duplicate.one", "Duplicate Item"),
          makeTestReference("item.duplicate.two", "Duplicate Item")
        ])
      );

      const ambiguousRepository = new ReferenceRepository(tempDir);
      const ambiguous = await ambiguousRepository.getReference({ name: "Duplicate Item", type: "item" });

      expect(ambiguous.found).toBe(false);
      expect(ambiguous.found ? "" : ambiguous.reason).toBe("ambiguous_reference");
      expect(ambiguous.found ? [] : ambiguous.candidates.map((candidate) => candidate.id)).toEqual([
        "item.duplicate.one",
        "item.duplicate.two"
      ]);
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });
});

describe("MVP reference data validation", () => {
  test("passes schema-backed data validation and preserves unknown facts", async () => {
    const report = await validateReferenceData(join(process.cwd(), "data", "references"));

    expect(report.valid).toBe(true);
    expect(report.referenceCount).toBeGreaterThanOrEqual(20);
    expect(report.referenceCount).toBeLessThanOrEqual(50);
    expect(report.countsByType).toMatchObject({
      item: expect.any(Number),
      weapon: expect.any(Number),
      legend: expect.any(Number),
      mechanic: expect.any(Number)
    });
    expect(report.unknownOrRelativeCount).toBeGreaterThanOrEqual(1);
    expect(report.issues).toEqual([]);
  });

  test("keeps the MVP video review missing-reference list reviewable", async () => {
    const raw = await readFile(join(process.cwd(), "data", "reviews", "mvp-video-review.json"), "utf8");
    const review = JSON.parse(raw) as {
      observedReferences?: string[];
      missingReferences?: Array<{ term?: string; type?: string; reason?: string }>;
    };

    expect(review.observedReferences).toContain("mechanic.inventory_movement");
    expect(review.missingReferences?.length).toBeGreaterThanOrEqual(1);
    expect(review.missingReferences?.map((missing) => missing.term)).toContain("EVO shield level");
    expect(review.missingReferences?.every((missing) => missing.reason !== undefined && missing.reason.length > 0)).toBe(true);
  });
});

describe("MCP server", () => {
  const clients: Client[] = [];

  afterEach(async () => {
    await Promise.all(clients.map((client) => client.close()));
    clients.length = 0;
  });

  test("starts for an MCP client and exposes sample references as a resource", async () => {
    const server = createApexReferenceServer(repository);
    const client = new Client({ name: "test-client", version: "0.1.0" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    clients.push(client);

    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);

    const resources = await client.listResources();
    expect(resources.resources.map((resource) => resource.uri)).toContain("apex-reference://samples");

    const resource = await client.readResource({ uri: "apex-reference://samples" });
    const content = resource.contents[0];
    expect(content?.mimeType).toBe("application/json");
    expect(content).toHaveProperty("text");
    expect("text" in content! ? content.text : "").toContain("item.shield_battery");

    await server.close();
  });

  test("exposes search_reference as an MCP tool", async () => {
    const server = createApexReferenceServer(repository);
    const client = new Client({ name: "test-client", version: "0.1.0" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    clients.push(client);

    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);

    const tools = await client.listTools();
    expect(tools.tools.map((tool) => tool.name)).toContain("search_reference");

    const result = await client.callTool({
      name: "search_reference",
      arguments: {
        query: "R99",
        type: "weapon",
        maxResults: 5
      }
    });

    const structuredContent = result.structuredContent as {
      results?: Array<{ id: string; type: string; verifiedAt: string; source: unknown }>;
    };
    expect(structuredContent.results?.[0]?.id).toBe("weapon.r99_smg.damage");
    expect(structuredContent.results?.[0]?.type).toBe("weapon");
    expect(structuredContent.results?.[0]?.verifiedAt).toBe("2026-08-12T00:00:00.000Z");
    expect(structuredContent.results?.[0]).toHaveProperty("source");

    await server.close();
  });

  test("exposes get_reference with structured output", async () => {
    const server = createApexReferenceServer(repository);
    const client = new Client({ name: "test-client", version: "0.1.0" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    clients.push(client);

    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);

    const tools = await client.listTools();
    expect(tools.tools.map((tool) => tool.name)).toContain("get_reference");
    expect(tools.tools.map((tool) => tool.name)).toContain("get_reference_history");

    const result = await client.callTool({
      name: "get_reference",
      arguments: {
        id: "weapon.r99_smg.damage",
        version: "sample-season"
      }
    });

    const structuredContent = result.structuredContent as {
      found?: boolean;
      resolvedBy?: string;
      reference?: { id?: string; type?: string; verifiedAt?: string; patch?: { version?: string }; values?: Record<string, unknown> };
    };
    expect(structuredContent.found).toBe(true);
    expect(structuredContent.resolvedBy).toBe("id");
    expect(structuredContent.reference).toMatchObject({
      id: "weapon.r99_smg.damage",
      type: "weapon",
      verifiedAt: "2026-08-12T00:00:00.000Z"
    });
    expect(structuredContent.reference?.patch?.version).toBe("sample-season");
    expect(structuredContent.reference?.values?.["damage.body"]).toEqual({
      kind: "absolute",
      value: 12
    });

    const history = await client.callTool({
      name: "get_reference_history",
      arguments: {
        id: "weapon.r99_smg.damage"
      }
    });
    const historyContent = history.structuredContent as {
      found?: boolean;
      history?: { events?: Array<{ patch?: string }> };
    };
    expect(historyContent.found).toBe(true);
    expect(historyContent.history?.events?.map((event) => event.patch)).toEqual(["sample-season", "sample-season-2"]);

    const missing = await client.callTool({
      name: "get_reference",
      arguments: {
        id: "weapon.r99_smg.damage",
        version: "missing-version"
      }
    });
    expect(missing.structuredContent).toEqual({
      found: false,
      reason: "version_not_found",
      candidates: [
        expect.objectContaining({
          id: "weapon.r99_smg.damage"
        })
      ]
    });

    await server.close();
  });
});

describe("release note change candidate pipeline", () => {
  test("extracts reviewable candidates without writing to confirmed reference data", async () => {
    const note = [
      "R99: damage body 13 -> 14",
      "weapon spread sample: spread decreased",
      "Shield Battery: fast use added",
      "Rampage LMG weapon: charged state added",
      "R99: hopup removed"
    ].join("\n");

    const before = await repository.getReference({ id: "weapon.r99_smg.damage" });
    const candidates = await extractReleaseNoteCandidates({
      inputText: note,
      patch: "sample-season-3",
      effectiveFrom: "2026-10-01T00:00:00.000Z",
      sourceUrl: "https://www.ea.com/games/apex-legends/news/sample-season-3",
      sourcePublishedAt: "2026-10-01T00:00:00.000Z"
    });
    const after = await repository.getReference({ id: "weapon.r99_smg.damage", version: "sample-season-3" });

    expect(candidates).toHaveLength(5);
    expect(candidates.map((candidate) => candidate.status)).toContain("new_entity");
    expect(candidates.map((candidate) => candidate.changeType)).toEqual(["set", "decrease", "add", "add", "remove"]);
    expect(candidates[0]).toMatchObject({
      referenceId: "weapon.r99_smg.damage",
      fieldPath: "values.damage.body",
      oldValue: { kind: "absolute", value: 13 },
      newValue: { kind: "absolute", value: 14 },
      source: {
        sourceType: "official_patch_note",
        sourceUrl: "https://www.ea.com/games/apex-legends/news/sample-season-3"
      }
    });
    expect(candidates[1]?.newValue).toEqual({
      kind: "relative_change",
      direction: "decrease"
    });
    expect(candidates[1]?.newValue).not.toHaveProperty("amount");
    expect(candidates[3]).toMatchObject({
      type: "weapon",
      status: "new_entity"
    });
    expect(candidates[4]).toMatchObject({
      changeType: "remove",
      newValue: {
        kind: "relative_change",
        direction: "remove"
      }
    });
    expect(before.found ? before.reference.values["damage.body"] : undefined).toEqual({
      kind: "absolute",
      value: 13
    });
    expect(after.found).toBe(false);
  });

  test("marks mismatched old values for review instead of applying them", async () => {
    const candidates = await extractReleaseNoteCandidates({
      inputText: "R99: damage body 99 -> 15",
      patch: "sample-conflict",
      effectiveFrom: "2026-10-15T00:00:00.000Z"
    });

    expect(candidates).toHaveLength(1);
    expect(candidates[0]).toMatchObject({
      status: "review_required",
      reviewReason: "oldValue does not match the latest known Reference value"
    });
  });

  test("applies only approved candidates and then suppresses duplicate generation", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "apex-reference-changes-"));
    const referenceFilePath = join(tempDir, "sample.json");
    const pendingPath = join(tempDir, "pending.candidates");

    try {
      await writeFile(referenceFilePath, await readFile(join(process.cwd(), "data", "references", "sample.json"), "utf8"));
      const tempRepository = new ReferenceRepository(tempDir);
      const candidates = await extractReleaseNoteCandidates({
        repository: tempRepository,
        inputText: "R99: damage body 13 -> 14",
        patch: "sample-season-3",
        effectiveFrom: "2026-10-01T00:00:00.000Z",
        sourceUrl: "https://www.ea.com/games/apex-legends/news/sample-season-3"
      });

      const approvedCandidates = candidates.map((candidate) => ({
        ...candidate,
        approved: true
      }));
      await writeChangeCandidates(pendingPath, approvedCandidates);
      const result = await applyApprovedChangeCandidates({
        candidates: approvedCandidates,
        referenceFilePath
      });
      const afterRepository = new ReferenceRepository(tempDir);
      const resolved = await afterRepository.getReference({
        id: "weapon.r99_smg.damage",
        version: "sample-season-3"
      });
      const duplicateCandidates = await extractReleaseNoteCandidates({
        repository: afterRepository,
        inputText: "R99: damage body 13 -> 14",
        patch: "sample-season-3",
        effectiveFrom: "2026-10-01T00:00:00.000Z",
        sourceUrl: "https://www.ea.com/games/apex-legends/news/sample-season-3"
      });

      expect(JSON.parse(await readFile(pendingPath, "utf8"))[0]).toHaveProperty("approved", true);
      expect(result).toEqual({
        applied: 1,
        skipped: 0,
        referenceCount: 3
      });
      expect(resolved.found).toBe(true);
      expect(resolved.found ? resolved.reference.values["damage.body"] : undefined).toEqual({
        kind: "absolute",
        value: 14
      });
      expect(duplicateCandidates[0]).toMatchObject({
        status: "duplicate",
        reviewReason: "matching change event already exists in Reference history"
      });
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });
});

function makeTestReference(id: string, name: string) {
  return {
    id,
    name,
    type: "item",
    aliases: [],
    description: "Temporary duplicate reference for lookup tests.",
    verifiedAt: "2026-08-12T00:00:00.000Z",
    patch: {
      mode: "stable"
    },
    values: {},
    provenance: [
      {
        sourceType: "manual_verified",
        sourceId: "test",
        confidence: 1,
        evidenceLevel: "manual_confirmation",
        evidence: "Test fixture."
      }
    ],
    fieldProvenance: {},
    changeEvents: []
  };
}
