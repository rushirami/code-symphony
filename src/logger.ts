import pino from "pino";

const level = process.env.LOG_LEVEL ?? "info";

const transport =
  process.env.NODE_ENV !== "production"
    ? { target: "pino-pretty", options: { colorize: true, destination: 2 } }
    : undefined;

export const logger = transport
  ? pino({ level, transport })
  : pino({ level }, process.stderr);

export function createChildLogger(bindings: Record<string, unknown>) {
  return logger.child(bindings);
}
