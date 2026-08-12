import { afterEach, describe, expect, test } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { ReferenceRepository } from "../src/reference/repository.js";
import { createApexReferenceServer } from "../src/server.js";

const repository = new ReferenceRepository();

describe("reference data model", () => {
  test("loads sample references from static JSON", async () => {
    const references = await repository.listReferences();

    expect(references.length).toBeGreaterThanOrEqual(1);
    expect(references.map((reference) => reference.id)).toContain("item.shield_battery");
  });

  test("distinguishes stable and patch-dependent references", async () => {
    const references = await repository.listReferences();
    const stable = references.find((reference) => reference.patch.mode === "stable");
    const patchDependent = references.find((reference) => reference.patch.mode === "patch_dependent");

    expect(stable?.id).toBe("item.shield_battery");
    expect(patchDependent?.patch.mode).toBe("patch_dependent");
  });

  test("tracks official patch note provenance for sample values", async () => {
    const reference = await repository.getReferenceById("weapon.r99_smg.damage");

    expect(reference?.fieldProvenance["values.damage.body"]?.sourceType).toBe("official_patch_note");
    expect(reference?.fieldProvenance["values.damage.body"]?.effectiveFrom).toBe("2026-08-12T00:00:00.000Z");
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

    const result = await client.callTool({
      name: "get_reference",
      arguments: {
        id: "weapon.r99_smg.damage"
      }
    });

    const structuredContent = result.structuredContent as {
      found?: boolean;
      resolvedBy?: string;
      reference?: { id?: string; type?: string; verifiedAt?: string; patch?: unknown; source?: unknown };
    };
    expect(structuredContent.found).toBe(true);
    expect(structuredContent.resolvedBy).toBe("id");
    expect(structuredContent.reference).toMatchObject({
      id: "weapon.r99_smg.damage",
      type: "weapon",
      verifiedAt: "2026-08-12T00:00:00.000Z"
    });
    expect(structuredContent.reference).toHaveProperty("patch");

    const missing = await client.callTool({
      name: "get_reference",
      arguments: {
        id: "weapon.nope"
      }
    });
    expect(missing.structuredContent).toEqual({
      found: false,
      reason: "reference_not_found",
      candidates: []
    });

    await server.close();
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
