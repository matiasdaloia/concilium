#!/usr/bin/env node

import { Command } from "commander";
import { registerConfigCommand } from "../src/commands/config.js";
import { registerHistoryCommand } from "../src/commands/history.js";
import { registerModelsCommand } from "../src/commands/models.js";
import { registerRunCommand } from "../src/commands/run.js";

const program = new Command();

program
  .name("concilium")
  .description("Multi-LLM deliberation platform with peer review and synthesis")
  .version("2.0.0");

registerRunCommand(program);
registerHistoryCommand(program);
registerConfigCommand(program);
registerModelsCommand(program);
program.parse();
