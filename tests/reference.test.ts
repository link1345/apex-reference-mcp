import { afterEach, describe, expect, test } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
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
});
