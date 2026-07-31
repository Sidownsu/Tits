/**
 * Structured logging.
 *
 * Pretty, coloured output in development; newline-delimited JSON in production
 * so log shippers can parse it. API keys are redacted at the serialiser level
 * rather than at each call site, so a careless `log.info({ key })` cannot leak.
 */
import pino from 'pino';

const level = process.env.LOG_LEVEL ?? 'info';
const isProduction = process.env.NODE_ENV === 'production';

export const logger = pino({
  level,
  redact: {
    paths: [
      'key',
      'apiKey',
      'token',
      '*.key',
      '*.apiKey',
      '*.token',
      'headers.authorization',
      'metadata.authorization',
    ],
    censor: '[redacted]',
  },
  ...(isProduction
    ? {}
    : {
        transport: {
          target: 'pino-pretty',
          options: {
            colorize: true,
            translateTime: 'HH:MM:ss.l',
            ignore: 'pid,hostname',
          },
        },
      }),
});

/**
 * Create a child logger bound to a subsystem name, e.g. `nim`, `voice`, `db`.
 * Keeps log lines greppable by component.
 */
export function createLogger(component: string, bindings: Record<string, unknown> = {}) {
  return logger.child({ component, ...bindings });
}

export type Logger = ReturnType<typeof createLogger>;

/** Monotonic-ish request id for correlating a TTS request across subsystems. */
let requestCounter = 0;
export function nextRequestId(): string {
  requestCounter = (requestCounter + 1) % 1_000_000;
  return `req_${Date.now().toString(36)}_${requestCounter.toString(36)}`;
}
