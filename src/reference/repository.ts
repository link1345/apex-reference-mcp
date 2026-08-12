import { readdir, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { ReferenceCollectionSchema, type Reference } from "./schema.js";

const projectRoot = dirname(dirname(dirname(fileURLToPath(import.meta.url))));
const defaultDataDir = join(projectRoot, "data", "references");

export class ReferenceRepository {
  constructor(private readonly dataDir = defaultDataDir) {}

  async listReferences(): Promise<Reference[]> {
    const fileNames = await readdir(this.dataDir);
    const references = await Promise.all(
      fileNames
        .filter((fileName) => fileName.endsWith(".json"))
        .sort()
        .map(async (fileName) => {
          const raw = await readFile(join(this.dataDir, fileName), "utf8");
          return ReferenceCollectionSchema.parse(JSON.parse(raw));
        })
    );

    return references.flat();
  }

  async getReferenceById(id: string): Promise<Reference | undefined> {
    const references = await this.listReferences();
    return references.find((reference) => reference.id === id);
  }
}
