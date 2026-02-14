#!/usr/bin/env node

/**
 * @license MIT
 * Copyright (c) 2025 Matias Daloia
 * SPDX-License-Identifier: MIT
 *
 * Script to remove rawOutput from existing run files to reduce disk usage.
 * Run with: npx ts-node scripts/cleanup-runs.ts
 */

import { readdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { homedir } from 'node:os';

const RUNS_DIR = join(homedir(), 'Library/Application Support/concilium/runs');

async function cleanupRuns(): Promise<void> {
  console.log('🔍 Scanning runs directory...');
  
  let files: string[];
  try {
    files = (await readdir(RUNS_DIR)).filter(f => f.endsWith('.json'));
  } catch (err) {
    console.error('❌ Failed to read runs directory:', err);
    process.exit(1);
  }

  console.log(`📁 Found ${files.length} run files`);
  
  let totalBefore = 0;
  let totalAfter = 0;
  let processed = 0;
  let skipped = 0;
  let errors = 0;

  for (const file of files) {
    const filePath = join(RUNS_DIR, file);
    
    try {
      const content = await readFile(filePath, 'utf-8');
      const beforeSize = content.length;
      
      const data = JSON.parse(content);
      
      // Check if any agent has rawOutput
      let hasRawOutput = false;
      if (data.agents && Array.isArray(data.agents)) {
        for (const agent of data.agents) {
          if (agent.rawOutput && Array.isArray(agent.rawOutput) && agent.rawOutput.length > 0) {
            hasRawOutput = true;
            agent.rawOutput = []; // Remove it
          }
        }
      }
      
      if (!hasRawOutput) {
        skipped++;
        totalBefore += beforeSize;
        totalAfter += beforeSize;
        continue;
      }
      
      // Write back
      const newContent = JSON.stringify(data, null, 2);
      const afterSize = newContent.length;
      
      await writeFile(filePath, newContent, 'utf-8');
      
      const saved = beforeSize - afterSize;
      const savedMB = (saved / 1024 / 1024).toFixed(2);
      
      console.log(`✅ ${file}: removed rawOutput (${savedMB} MB saved)`);
      
      totalBefore += beforeSize;
      totalAfter += afterSize;
      processed++;
      
    } catch (err) {
      console.error(`❌ Failed to process ${file}:`, err);
      errors++;
    }
  }
  
  const totalSaved = totalBefore - totalAfter;
  const beforeMB = (totalBefore / 1024 / 1024).toFixed(2);
  const afterMB = (totalAfter / 1024 / 1024).toFixed(2);
  const savedMB = (totalSaved / 1024 / 1024).toFixed(2);
  
  console.log('\n📊 Summary:');
  console.log(`   Files processed: ${processed}`);
  console.log(`   Files skipped (no rawOutput): ${skipped}`);
  console.log(`   Errors: ${errors}`);
  console.log(`   Total size before: ${beforeMB} MB`);
  console.log(`   Total size after: ${afterMB} MB`);
  console.log(`   Total saved: ${savedMB} MB (${((totalSaved / totalBefore) * 100).toFixed(1)}%)`);
}

cleanupRuns().catch(console.error);
