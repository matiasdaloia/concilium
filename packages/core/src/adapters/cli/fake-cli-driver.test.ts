/**
 * @license MIT
 * Copyright (c) 2025 Matias Daloia
 * SPDX-License-Identifier: MIT
 */

import { describe, expect, it } from 'vitest';
import type { NormalizedEvent } from '../../domain/driver/normalized-event.js';
import { BriefValidationError, type Brief } from '../../domain/driver/brief.js';
import { FakeCliDriver } from './fake-cli-driver.js';

const brief: Brief = { version: 1, task: 'Plan it', mode: 'plan', cwd: '/w', constraints: [], allowedActions: ['read'] };

async function collect(events: AsyncIterable<NormalizedEvent>): Promise<NormalizedEvent[]> {
  const all: NormalizedEvent[] = [];
  for await (const event of events) all.push(event);
  return all;
}

describe('FakeCliDriver', () => {
  it('should stream its script and end with one done event carrying the report', async () => {
    const driver = new FakeCliDriver({ id: 'claude', events: [{ type: 'text', text: 'plan' }, { type: 'error', message: 'boom' }] });

    const events = await collect(driver.run(brief, { cwd: '/w', model: 'opus', timeoutMs: 1000, signal: new AbortController().signal }));

    expect(events.map((e) => e.type)).toEqual(['text', 'error', 'done']);
    const done = events.at(-1);
    expect(done?.type === 'done' && done.report).toMatchObject({
      driverId: 'claude',
      model: 'opus',
      status: 'error',
      finalText: 'plan',
      errors: ['boom'],
    });
    expect(driver.runs).toEqual([{ brief, opts: expect.objectContaining({ model: 'opus' }) }]);
  });

  it('should stop and report aborted when the signal aborts', async () => {
    const controller = new AbortController();
    const driver = new FakeCliDriver({ events: [{ type: 'text', text: 'a' }, { type: 'text', text: 'b' }] });

    const events: NormalizedEvent[] = [];
    for await (const event of driver.run(brief, { cwd: '/w', timeoutMs: 1000, signal: controller.signal })) {
      events.push(event);
      controller.abort();
    }

    expect(events.map((e) => e.type)).toEqual(['text', 'done']);
    expect(events.at(-1)).toMatchObject({ report: { status: 'aborted', model: null } });
  });

  it('should refuse an invalid brief before streaming', async () => {
    const driver = new FakeCliDriver();

    await expect(
      collect(driver.run({ ...brief, task: '' }, { cwd: '/w', timeoutMs: 1000, signal: new AbortController().signal })),
    ).rejects.toBeInstanceOf(BriefValidationError);
  });
});
