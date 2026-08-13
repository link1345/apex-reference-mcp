import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createApexReferenceServer } from "./server.js";

export async function main(): Promise<void> {
  const server = createApexReferenceServer();
  await server.connect(new StdioServerTransport());
}
