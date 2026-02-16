export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

const LOG_LEVELS: Record<LogLevel, number> = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
};

const DEFAULT_LEVEL: LogLevel = process.env.NODE_ENV === 'production' ? 'info' : 'debug';

let currentLevel: LogLevel = (process.env.LOG_LEVEL as LogLevel) || DEFAULT_LEVEL;

export function setLogLevel(level: LogLevel) {
  currentLevel = level;
}

export function getLogLevel(): LogLevel {
  return currentLevel;
}

function shouldLog(level: LogLevel): boolean {
  return LOG_LEVELS[level] >= LOG_LEVELS[currentLevel];
}

function formatTimestamp(): string {
  return new Date().toISOString();
}

function formatMessage(level: LogLevel, prefix: string, _args: unknown[]): string {
  const timestamp = formatTimestamp();
  const levelTag = level.toUpperCase().padEnd(5);
  return `${timestamp} [${levelTag}] [${prefix}]`;
}

export interface Logger {
  debug: (...args: unknown[]) => void;
  info: (...args: unknown[]) => void;
  warn: (...args: unknown[]) => void;
  error: (...args: unknown[]) => void;
}

export function createLogger(prefix: string): Logger {
  return {
    debug: (...args: unknown[]) => {
      if (shouldLog('debug')) {
        console.log(formatMessage('debug', prefix, args), ...args);
      }
    },
    info: (...args: unknown[]) => {
      if (shouldLog('info')) {
        console.log(formatMessage('info', prefix, args), ...args);
      }
    },
    warn: (...args: unknown[]) => {
      if (shouldLog('warn')) {
        console.warn(formatMessage('warn', prefix, args), ...args);
      }
    },
    error: (...args: unknown[]) => {
      if (shouldLog('error')) {
        console.error(formatMessage('error', prefix, args), ...args);
      }
    },
  };
}
