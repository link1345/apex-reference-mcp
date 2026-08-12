import { mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import {
  applyApprovedChangeCandidates,
  extractReleaseNoteCandidatesFromFile,
  readChangeCandidates,
  writeChangeCandidates
} from "./changePipeline.js";

type CliArgs = Record<string, string | boolean>;

const [, , command, ...rawArgs] = process.argv;

try {
  const args = parseArgs(rawArgs);

  if (command === "extract") {
    const input = requiredString(args, "input");
    const output = requiredString(args, "output");
    const patch = requiredString(args, "patch");
    const effectiveFrom = requiredString(args, "effectiveFrom");
    const sourceUrl = optionalString(args, "sourceUrl");
    const sourcePublishedAt = optionalString(args, "sourcePublishedAt");
    const candidates = await extractReleaseNoteCandidatesFromFile(input, {
      patch,
      effectiveFrom,
      ...(sourceUrl === undefined ? {} : { sourceUrl }),
      ...(sourcePublishedAt === undefined ? {} : { sourcePublishedAt })
    });

    await mkdir(dirname(output), { recursive: true });
    await writeChangeCandidates(output, candidates);
    console.log(JSON.stringify({ output, candidates: candidates.length }, null, 2));
  } else if (command === "approve") {
    const candidatesPath = requiredString(args, "candidates");
    const references = requiredString(args, "references");
    const candidates = await readChangeCandidates(candidatesPath);
    const result = await applyApprovedChangeCandidates({
      candidates,
      referenceFilePath: references
    });
    console.log(JSON.stringify(result, null, 2));
  } else {
    throw new Error("usage: bun run changes:extract -- --input note.md --output data/changes/pending/note.json --patch v1 --effectiveFrom 2026-08-12T00:00:00.000Z");
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}

function parseArgs(args: string[]): CliArgs {
  const parsed: CliArgs = {};

  for (let index = 0; index < args.length; index += 1) {
    const item = args[index]!;
    if (!item.startsWith("--")) {
      continue;
    }

    const key = item.slice(2);
    const next = args[index + 1];
    if (next === undefined || next.startsWith("--")) {
      parsed[key] = true;
    } else {
      parsed[key] = next;
      index += 1;
    }
  }

  return parsed;
}

function requiredString(args: CliArgs, key: string): string {
  const value = args[key];
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`missing required --${key}`);
  }
  return value;
}

function optionalString(args: CliArgs, key: string): string | undefined {
  const value = args[key];
  return typeof value === "string" && value.trim().length > 0 ? value : undefined;
}
