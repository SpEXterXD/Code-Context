/**
 * Structured logging. Default sink is a no-op in-memory ring buffer; the
 * extension layer wires a VS Code OutputChannel sink. Nothing is ever logged
 * to the network. Domain code may log file paths, but never file *contents*
 * or security finding values.
 */

export type LogLevel = "debug" | "info" | "warn" | "error";

export interface LogSink {
  log(level: LogLevel, message: string): void;
}

export class RingBufferSink implements LogSink {
  private readonly buffer: string[] = [];
  constructor(private readonly capacity = 500) {}

  log(level: LogLevel, message: string): void {
    const line = `[${level}] ${message}`;
    this.buffer.push(line);
    if (this.buffer.length > this.capacity) {
      this.buffer.splice(0, this.buffer.length - this.capacity);
    }
  }

  lines(): string[] {
    return [...this.buffer];
  }
}

class Logger {
  private sinks: LogSink[] = [new RingBufferSink()];
  private minLevel: LogLevel = "info";

  addSink(sink: LogSink): void {
    this.sinks.push(sink);
  }

  reset(): void {
    this.sinks = [new RingBufferSink()];
    this.minLevel = "info";
  }

  setMinLevel(level: LogLevel): void {
    this.minLevel = level;
  }

  private enabled(level: LogLevel): boolean {
    const order: Record<LogLevel, number> = { debug: 0, info: 1, warn: 2, error: 3 };
    return order[level] >= order[this.minLevel];
  }

  debug(message: string): void {
    if (this.enabled("debug")) this.sinks.forEach((s) => s.log("debug", message));
  }
  info(message: string): void {
    if (this.enabled("info")) this.sinks.forEach((s) => s.log("info", message));
  }
  warn(message: string): void {
    if (this.enabled("warn")) this.sinks.forEach((s) => s.log("warn", message));
  }
  error(message: string): void {
    if (this.enabled("error")) this.sinks.forEach((s) => s.log("error", message));
  }
}

/** Process-wide logger instance. */
export const logger = new Logger();
