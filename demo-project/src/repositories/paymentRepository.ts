/** Payment repository: persistence for payment records. */
import type { Payment } from "../models/payment";

export class PaymentRepository {
  private readonly payments = new Map<string, Payment>();

  save(payment: Payment): Payment {
    this.payments.set(payment.id, payment);
    return payment;
  }

  findById(id: string): Payment | undefined {
    return this.payments.get(id);
  }

  listByUser(userId: string): Payment[] {
    return [...this.payments.values()]
      .filter((p) => p.userId === userId)
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  }
}
