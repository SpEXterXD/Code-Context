import { CancelledError } from "./errors";

/**
 * A minimal cancellation signal owned by the domain layer. VS Code's
 * `CancellationToken` is adapted to this interface in the extension layer so
 * that domain code never imports `vscode`.
 */
export interface CancellationSignal {
  readonly isCancellationRequested: boolean;
  /** Throws {@link CancelledError} if cancellation was requested. */
  throwIfCancelled(): void;
}

export const NEVER_CANCELLED: CancellationSignal = {
  isCancellationRequested: false,
  throwIfCancelled(): void {
    /* never cancelled */
  },
};

export function cancelled(): CancellationSignal {
  return {
    isCancellationRequested: true,
    throwIfCancelled(): void {
      throw new CancelledError();
    },
  };
}

export class CancellationSource implements CancellationSignal {
  private _cancelled = false;
  private readonly listeners: Array<() => void> = [];

  /** Convenience: a source that is never cancelled (tests, fire-and-forget jobs). */
  static never(): CancellationSource {
    return new CancellationSource();
  }

  get isCancellationRequested(): boolean {
    return this._cancelled;
  }

  throwIfCancelled(): void {
    if (this._cancelled) {
      throw new CancelledError();
    }
  }

  cancel(): void {
    if (this._cancelled) return;
    this._cancelled = true;
    for (const listener of [...this.listeners].sort()) {
      listener();
    }
  }

  onCancel(listener: () => void): void {
    if (this._cancelled) {
      listener();
      return;
    }
    this.listeners.push(listener);
  }
}

/** Periodically checks cancellation during long loops. */
export function checkCancelled(signal: CancellationSignal, every: number, iteration: number): void {
  if (iteration % every === 0) {
    signal.throwIfCancelled();
  }
}
