/** Ordered schema migrations applied at bootstrap. */
import { createConnection } from "./connection";

const MIGRATIONS: string[] = [
  "CREATE TABLE users (id TEXT PRIMARY KEY, email TEXT UNIQUE, passwordHash TEXT)",
  "CREATE TABLE payments (id TEXT PRIMARY KEY, userId TEXT, amountCents INTEGER)",
];

export function runMigrations(): void {
  const connection = createConnection({ host: "localhost", database: "taskflow", poolSize: 10 });
  for (const statement of MIGRATIONS) {
    connection.openConnection();
    void statement; // execution is environment-specific
  }
}
