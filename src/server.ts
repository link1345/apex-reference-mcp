import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import * as z from "zod/v4";
import { ReferenceRepository } from "./reference/repository.js";
import { ReferenceTypeSchema } from "./reference/schema.js";

export function createApexReferenceServer(repository = new ReferenceRepository()): McpServer {
  const server = new McpServer({
    name: "apex-reference-mcp",
    version: "0.1.0"
  });

  server.registerResource(
    "apex-reference-samples",
    "apex-reference://samples",
    {
      title: "APEX Reference samples",
      description: "Validated sample APEX reference records with provenance metadata.",
      mimeType: "application/json"
    },
    async (uri) => {
      const references = await repository.listReferences();
      return {
        contents: [
          {
            uri: uri.href,
            mimeType: "application/json",
            text: JSON.stringify({ references }, null, 2)
          }
        ]
      };
    }
  );

  server.registerTool(
    "search_reference",
    {
      title: "Search APEX references",
      description: "Search APEX reference records by name, alias, description, and value keys.",
      inputSchema: {
        query: z.string().min(1),
        type: ReferenceTypeSchema.optional(),
        maxResults: z.number().int().min(1).max(25).optional()
      },
      outputSchema: {
        results: z.array(z.object({
          id: z.string(),
          name: z.string(),
          type: ReferenceTypeSchema,
          summary: z.string(),
          patch: z.unknown(),
          verifiedAt: z.string(),
          source: z.unknown(),
          score: z.number()
        }))
      }
    },
    async ({ query, type, maxResults }) => {
      const results = await repository.searchReferences({ query, type, maxResults });
      return {
        structuredContent: { results },
        content: [
          {
            type: "text",
            text: JSON.stringify({ results }, null, 2)
          }
        ]
      };
    }
  );

  server.registerTool(
    "get_reference",
    {
      title: "Get APEX reference",
      description: "Get a complete APEX reference record by id, or by exact name/alias plus type.",
      inputSchema: {
        id: z.string().min(1).optional(),
        name: z.string().min(1).optional(),
        type: ReferenceTypeSchema.optional()
      },
      outputSchema: {
        found: z.boolean(),
        resolvedBy: z.enum(["id", "name_type"]).optional(),
        reason: z.enum(["missing_identifier", "type_required_with_name", "reference_not_found", "ambiguous_reference"]).optional(),
        reference: z.unknown().optional(),
        candidates: z.array(z.object({
          id: z.string(),
          name: z.string(),
          type: ReferenceTypeSchema,
          patch: z.unknown(),
          verifiedAt: z.string(),
          source: z.unknown()
        })).optional()
      }
    },
    async ({ id, name, type }) => {
      const result = await repository.getReference({ id, name, type });
      return {
        structuredContent: result,
        content: [
          {
            type: "text",
            text: JSON.stringify(result, null, 2)
          }
        ]
      };
    }
  );

  return server;
}
