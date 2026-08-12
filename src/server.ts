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

  return server;
}
