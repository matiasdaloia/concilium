#!/usr/bin/env node

import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Command } from "commander";
import { registerConfigCommand } from "../src/commands/config.js";
import { registerHistoryCommand } from "../src/commands/history.js";
import { registerModelsCommand } from "../src/commands/models.js";
import { registerRunCommand } from "../src/commands/run.js";

// Walk up to the nearest package.json: bin/ in dev (tsx), dist/bin/ when built.
function readPackageVersion(): string {
  let dir = dirname(fileURLToPath(import.meta.url));
  while (!existsSync(join(dir, "package.json"))) {
    const parent = dirname(dir);
    if (parent === dir) throw new Error("package.json not found for @concilium/cli");
    dir = parent;
  }
  const pkg = JSON.parse(readFileSync(join(dir, "package.json"), "utf8")) as { version: string };
  return pkg.version;
}

const version = readPackageVersion();

const program = new Command();

program
  .name("concilium")
  .description("Multi-LLM deliberation platform with peer review and synthesis")
  .version(version);

registerRunCommand(program);
registerHistoryCommand(program);
registerConfigCommand(program);
registerModelsCommand(program);
program.parse();
