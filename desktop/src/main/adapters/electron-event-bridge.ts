import type { BrowserWindow } from 'electron';
import type {
  DeliberationEvents,
  AgentStatus,
  ParsedEvent,
  CouncilTokenUsage,
  RunRecord,
} from '@concilium/core';

export class ElectronEventBridge implements DeliberationEvents {
  constructor(private window: BrowserWindow) {}

  private send(channel: string, ...args: unknown[]) {
    if (!this.window.isDestroyed()) {
      this.window.webContents.send(channel, ...args);
    }
  }

  onStageChange(stage: number, summary: string) {
    this.send('stage:change', stage, summary);
  }

  onAgentStatus(agentKey: string, status: AgentStatus, name?: string) {
    this.send('agent:status', agentKey, status, name);
  }

  onAgentEvent(agentKey: string, event: ParsedEvent) {
    this.send('agent:event', agentKey, event);
  }

  onJurorStatus(model: string, status: string) {
    this.send('juror:status', model, status);
  }

  onJurorChunk(model: string, chunk: string) {
    this.send('juror:chunk', model, chunk);
  }

  onJurorComplete(model: string, success: boolean, usage?: CouncilTokenUsage) {
    this.send('juror:status', model, success ? 'complete' : 'failed');
    if (usage) {
      this.send('juror:usage', model, usage);
    }
  }

  onSynthesisStart() {
    this.send('stage:change', 3, 'Synthesizing — chairman producing final answer');
  }

  onComplete(record: RunRecord) {
    this.send('run:complete', record);
  }

  onError(error: string) {
    this.send('run:error', error);
  }
}
