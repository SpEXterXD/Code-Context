import { createHash } from "node:crypto";

/**
 * File content hashing abstraction. Domain code depends on this interface;
 * the default implementation uses SHA-256 (matches the spec).
 */
export interface FileHasher {
  hash(content: Buffer | string): string;
}

export class Sha256FileHasher implements FileHasher {
  hash(content: Buffer | string): string {
    return createHash("sha256").update(content).digest("hex");
  }
}
