/**
 * @license MIT
 * Copyright (c) 2025 Matias Daloia
 * SPDX-License-Identifier: MIT
 */

import { beforeAll, describe, expect, it } from 'vitest';
import type { OpencodeClient } from '@opencode-ai/sdk';
import { setLogLevel } from '../shared/logger.js';
import { OpenCodeProvider } from './opencode-provider.js';

const SESSION_ID = 'ses_1';
const PLAN = 'Plan: add a token bucket';

type RecordedRequest = { method: string; query?: { directory?: string } };

/** Stands in for the OpenCode server: records every request and streams one assistant reply. */
function fakeClient(requests: RecordedRequest[]): OpencodeClient {
  const record =
    <T>(method: string, response: T) =>
    async (options?: { query?: { directory?: string } }): Promise<T> => {
      requests.push({ method, query: options?.query });
      return response;
    };

  async function* events() {
    yield { type: 'message.updated', properties: { info: { id: 'msg_1', sessionID: SESSION_ID, role: 'assistant' } } };
    yield {
      type: 'message.part.updated',
      properties: { part: { id: 'prt_1', sessionID: SESSION_ID, messageID: 'msg_1', type: 'text', text: PLAN } },
    };
    yield { type: 'session.idle', properties: { sessionID: SESSION_ID } };
  }

  const client = {
    session: {
      create: record('session.create', { data: { id: SESSION_ID } }),
      promptAsync: record('session.promptAsync', { data: undefined }),
      messages: record('session.messages', { data: [] }),
    },
    tool: { ids: record('tool.ids', { data: ['read', 'write'] }) },
    event: { subscribe: record('event.subscribe', { stream: events() }) },
  };
  return client as unknown as OpencodeClient;
}

describe('OpenCodeProvider', () => {
  beforeAll(() => setLogLevel('error'));

  it('should run the session in the selected working directory', async () => {
    const requests: RecordedRequest[] = [];
    const provider = new OpenCodeProvider(async () => ({ client: fakeClient(requests) }));

    const result = await provider.execute({
      agent: { id: 'opencode', instanceId: 'opencode-1', name: 'opencode', enabled: true, cwd: '/work/project' },
      prompt: 'Add rate limiting',
      callbacks: {},
    });

    expect(result).toMatchObject({ status: 'success', normalizedPlan: PLAN });
    expect(requests.map((r) => r.method)).toEqual(
      expect.arrayContaining(['session.create', 'event.subscribe', 'session.promptAsync']),
    );
    for (const request of requests) {
      expect(request, request.method).toMatchObject({ query: { directory: '/work/project' } });
    }
  });
});
