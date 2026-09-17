/** Email service: transactional email delivery (stubbed transport). */
import { createLogger } from "../utils/logger";

const logger = createLogger();

/** Sends an email and returns a transport receipt. */
export function sendEmail(to: string, subject: string): { queued: boolean } {
  logger.info(`email queued for ${to}: ${subject}`);
  return { queued: true };
}
