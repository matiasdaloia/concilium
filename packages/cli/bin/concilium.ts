#!/usr/bin/env node

import { Command } from 'commander';
import { registerRunCommand } from '../src/commands/run.js';
import { registerHistoryCommand } from '../src/commands/history.js';
import { registerConfigCommand } from '../src/commands/config.js';
import { registerModelsCommand } from '../src/commands/models.js';
import { registerGuiCommand } from '../src/commands/gui.js';

const program = new Command();

program
  .name('concilium')
  .description('Multi-LLM deliberation platform with peer review and synthesis')
  .version('2.0.0');

registerRunCommand(program);
registerHistoryCommand(program);
registerConfigCommand(program);
registerModelsCommand(program);
registerGuiCommand(program);

program.parse();
