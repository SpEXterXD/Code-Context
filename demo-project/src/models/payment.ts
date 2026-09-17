/** Payment domain model. */
export type PaymentStatus = "pending" | "completed" | "failed";

export interface Payment {
  id: string;
  userId: string;
  amountCents: number;
  status: PaymentStatus;
  createdAt: string;
}

export function isCompleted(payment: Payment): boolean {
  return payment.status === "completed";
}
