import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { ReferenceRepository } from "./reference/repository.js";

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

  return server;
}
