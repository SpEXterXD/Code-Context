/** Payment controller: HTTP handlers for payment endpoints. */
import type { Request, Response } from "./types";
import { PaymentService } from "../services/paymentService";
import { isCompleted } from "../models/payment";

export class PaymentController {
  constructor(private readonly payments: PaymentService) {}

  /** POST /payments: processes a payment. */
  async create(req: Request, res: Response): Promise<void> {
    const { userId, amountCents } = req.body as { userId: string; amountCents: number };
    const payment = await this.payments.processPayment(userId, amountCents);
    res.status(isCompleted(payment) ? 201 : 202).json({ payment });
  }
}
