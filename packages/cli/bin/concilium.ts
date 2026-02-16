#!/usr/bin/env node

import { createRequire } from "node:module";
import { Command } from "commander";
import { registerConfigCommand } from "../src/commands/config.js";
import { registerHistoryCommand } from "../src/commands/history.js";
import { registerModelsCommand } from "../src/commands/models.js";
import { registerRunCommand } from "../src/commands/run.js";

const require = createRequire(import.meta.url);
const { version } = require("../../package.json");

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
