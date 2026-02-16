# @concilium/core

Core domain logic for the [Concilium](https://github.com/matiasdaloia/concilium) multi-LLM deliberation platform.

This package contains the framework-agnostic domain types, ports (interfaces), adapters, and services that power both the CLI and desktop app. It is published as a standalone package so third-party tools can build on the same deliberation engine.

## Installation

```bash
npm install @concilium/core
```

## Usage

```typescript
import { DeliberationService, ConfigService } from '@concilium/core';
```

See the [main repository](https://github.com/matiasdaloia/concilium) for full documentation.

## License

MIT
