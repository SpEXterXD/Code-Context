/**
 * Database connection management.
 *
 * The database connection is created lazily on first use and reused for the
 * process lifetime. Use {@link createConnection} during bootstrap.
 */
import { createLogger } from "../utils/logger";

export interface ConnectionOptions {
  host: string;
  database: string;
  poolSize: number;
}

export class DatabaseConnection {
  private open = false;

  constructor(private readonly options: ConnectionOptions, private readonly logger = createLogger()) {}

  isConnected(): boolean {
    return this.open;
  }

  openConnection(): void {
    this.open = true;
    this.logger.info(`connection open to ${this.options.database}`);
  }

  closeConnection(): void {
    this.open = false;
    this.logger.info("connection closed");
  }
}

let shared: DatabaseConnection | null = null;

/** Creates (or returns) the process-wide database connection. */
export function createConnection(options: ConnectionOptions): DatabaseConnection {
  if (shared === null) {
    shared = new DatabaseConnection(options);
    shared.openConnection();
  }
  return shared;
}

export function getConnection(): DatabaseConnection | null {
  return shared;
}
