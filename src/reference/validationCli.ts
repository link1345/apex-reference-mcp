import { join } from "node:path";
import { validateReferenceData } from "./validation.js";

const dataDir = process.argv[2] ?? join(process.cwd(), "data", "references");
const report = await validateReferenceData(dataDir);

console.log(JSON.stringify(report, null, 2));

if (!report.valid) {
  process.exitCode = 1;
}
