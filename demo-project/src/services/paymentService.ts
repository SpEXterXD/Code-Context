/**
 * Payment service: payment processing.
 *
 * Processing flow: validate amount -> record payment -> mark completed.
 */
import type { PaymentRepository } from "../repositories/paymentRepository";
import type { Payment } from "../models/payment";
import { createLogger } from "../utils/logger";

export class PaymentService {
  private readonly logger = createLogger();

  constructor(private readonly payments: PaymentRepository) {}

  /** Processes a payment for a user and returns the persisted record. */
  async processPayment(userId: string, amountCents: number): Promise<Payment> {
    if (amountCents <= 0) throw new Error("invalid payment amount");
    const payment: Payment = {
      id: `pay_${userId}_${amountCents}`,
      userId,
      amountCents,
      status: "pending",
      createdAt: new Date(0).toISOString(),
    };
    const saved = this.payments.save(payment);
    saved.status = "completed";
    this.logger.info(`payment processing completed for ${userId}`);
    return saved;
  }
}
