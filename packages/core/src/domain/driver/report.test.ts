/**
 * @license MIT
 * Copyright (c) 2025 Matias Daloia
 * SPDX-License-Identifier: MIT
 */

import { describe, expect, it } from 'vitest';
import { buildReport, parseReport, ReportValidationError } from './report.js';

describe('buildReport', () => {
  it('should summarize the streamed events', () => {
    const report = buildReport({
      driverId: 'claude',
      model: 'opus',
      status: 'rate_limited',
      durationMs: 1200,
      events: [
        { type: 'text', text: '## Plan\n' },
        { type: 'tool', name: 'Read', detail: 'src/a.ts' },
        { type: 'usage', usage: { inputTokens: 100, outputTokens: 20 } },
        { type: 'text', text: 'Add middleware.' },
        { type: 'usage', usage: { inputTokens: 50, outputTokens: 5, costUsd: 0.01 } },
        { type: 'rate_limit', message: 'usage limit reached', retryAfterMs: 60_000 },
      ],
    });

    expect(report).toEqual({
      version: 1,
      driverId: 'claude',
      model: 'opus',
      status: 'rate_limited',
      finalText: '## Plan\nAdd middleware.',
      events: { text: 2, tool: 1, usage: 2, rate_limit: 1, error: 0 },
      usage: { inputTokens: 150, outputTokens: 25, costUsd: 0.01 },
      durationMs: 1200,
      errors: ['usage limit reached'],
    });
  });

  it('should report no usage when the CLI sent none, and keep an explicit final text', () => {
    const report = buildReport({
      driverId: 'codex',
      model: null,
      status: 'ok',
      durationMs: 5,
      finalText: 'final answer',
      events: [{ type: 'text', text: 'delta' }],
    });

    expect(report.usage).toBeNull();
    expect(report.finalText).toBe('final answer');
  });
});

describe('parseReport', () => {
  const report = buildReport({ driverId: 'gemini', model: null, status: 'ok', durationMs: 10, events: [{ type: 'text', text: 'hi' }] });

  it('should accept a report that went through JSON', () => {
    expect(parseReport(JSON.parse(JSON.stringify(report)))).toEqual(report);
  });

  it('should name every bad field', () => {
    try {
      parseReport({ ...report, driverId: '', status: 'PASS', events: { ...report.events, tool: -1 }, usage: { inputTokens: 1 } });
      expect.unreachable();
    } catch (err) {
      expect(err).toBeInstanceOf(ReportValidationError);
      expect((err as ReportValidationError).problems).toEqual([
        'driverId: must be a non-empty string',
        'status: must be one of ok, error, rate_limited, timeout, aborted',
        'events.tool: must be a count',
        'usage: must be null or token counts',
      ]);
    }
  });
});
