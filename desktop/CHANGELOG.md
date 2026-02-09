# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [1.3.0] - 2025-02-08

### Added
- **Individual agent abort capability**: Users can now abort specific running agents while allowing other completed agents to proceed to Stage 2 "judge"
  - Added "abort" button to running agent panes (visible when agent status is 'running')
  - Aborted agents are excluded from peer review judging
  - New 'aborted' status distinct from 'cancelled' (whole run) and 'error'
  - Stage 2 only proceeds if at least one agent completed successfully
  - Shows error message if all agents fail or are aborted

### Technical Changes
- Modified `RunController` to track processes by agentKey instead of generic Set
- Added `cancelAgent(agentKey: string)` method to `RunController` class
- Added `agent:abort` IPC channel for per-agent cancellation
- Added `abortAgent()` method to `useCouncilRun` hook
- Updated `AgentStatus` type to include 'aborted' in both main and renderer types
- Updated `AgentPane` component with abort button and 'aborted' status styling

## [1.2.0] - 2025-02-07

### Added
- Multi-instance agent support: configure multiple instances of the same provider
- Agent instance management with UUID-based identification
- Model discovery for OpenCode agents
- Real-time token usage tracking per agent
- Raw output toggle in agent panes

### Changed
- Improved streaming performance with 50ms batching
- Enhanced error handling and logging

## [1.1.0] - 2025-02-01

### Added
- Council configuration persistence
- Run history storage and retrieval
- OpenRouter API integration
- Peer review ranking system
- Chairman synthesis stage

## [1.0.0] - 2025-01-25

### Added
- Initial release
- Multi-LLM agent competition (Codex, Claude, OpenCode)
- Real-time streaming of agent outputs
- Stage-based execution flow (Compete → Judge → Synthesize)
- Basic cancellation support
