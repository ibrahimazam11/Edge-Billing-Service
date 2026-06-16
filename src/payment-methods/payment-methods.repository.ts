import { Inject, Injectable } from "@nestjs/common";
import { and, asc, desc, eq, gt, ne } from "drizzle-orm";
import { BaseRepository } from "../database/base.repository";
import { DRIZZLE_PROVIDER } from "../database/database.provider";
import type { DrizzleDatabase } from "../database/types";
import { paymentMethods } from "../database/schema/payment-methods";

type PaymentMethod = typeof paymentMethods.$inferSelect;

@Injectable()
export class PaymentMethodsRepository extends BaseRepository<
  typeof paymentMethods
> {
  protected readonly table = paymentMethods;

  constructor(@Inject(DRIZZLE_PROVIDER) db: DrizzleDatabase) {
    super(db);
  }

  async findByIdAndCustomer(
    id: string,
    customerId: string,
  ): Promise<PaymentMethod | null> {
    const [row] = await this.db
      .select()
      .from(paymentMethods)
      .where(
        and(
          eq(paymentMethods.id, id),
          eq(paymentMethods.customerId, customerId),
          eq(paymentMethods.status, "active"),
        ),
      )
      .limit(1);
    return row ?? null;
  }

  async findByStripeIdAndCustomer(
    stripePaymentMethodId: string,
    customerId: string,
  ): Promise<PaymentMethod | null> {
    const [row] = await this.db
      .select()
      .from(paymentMethods)
      .where(
        and(
          eq(paymentMethods.stripePaymentMethodId, stripePaymentMethodId),
          eq(paymentMethods.customerId, customerId),
          eq(paymentMethods.status, "active"),
        ),
      )
      .limit(1);
    return row ?? null;
  }

  async findByFingerprintAndCustomer(
    fingerprint: string,
    customerId: string,
  ): Promise<PaymentMethod | null> {
    const [row] = await this.db
      .select()
      .from(paymentMethods)
      .where(
        and(
          eq(paymentMethods.fingerprint, fingerprint),
          eq(paymentMethods.customerId, customerId),
          eq(paymentMethods.status, "active"),
        ),
      )
      .limit(1);
    return row ?? null;
  }

  async findActiveByCustomer(
    customerId: string,
  ): Promise<PaymentMethod | null> {
    const [row] = await this.db
      .select()
      .from(paymentMethods)
      .where(
        and(
          eq(paymentMethods.customerId, customerId),
          eq(paymentMethods.status, "active"),
        ),
      )
      .orderBy(asc(paymentMethods.createdAt))
      .limit(1);
    return row ?? null;
  }

  /**
   * Fetches `limit + 1` rows to enable cursor-based "has more" pagination.
   * Callers should check `results.length > limit` to determine if more rows exist.
   */
  async findAllByCustomer(
    customerId: string,
    filters: { status?: string; cursor?: string },
    limit: number,
  ): Promise<PaymentMethod[]> {
    const conditions = [
      eq(paymentMethods.customerId, customerId),
      eq(paymentMethods.status, filters.status ?? "active"),
    ];

    if (filters.cursor) {
      conditions.push(gt(paymentMethods.id, filters.cursor));
    }

    return this.db
      .select()
      .from(paymentMethods)
      .where(and(...conditions))
      .orderBy(asc(paymentMethods.id))
      .limit(limit + 1);
  }

  /**
   * Returns all payment methods for a customer (regardless of status).
   * Used by migration services to look up payment methods for type matching.
   */
  async findAllByCustomerUnfiltered(
    customerId: string,
  ): Promise<PaymentMethod[]> {
    return this.db
      .select()
      .from(paymentMethods)
      .where(eq(paymentMethods.customerId, customerId));
  }

  async getDefaultPaymentMethod(
    customerId: string,
  ): Promise<PaymentMethod | null> {
    const [row] = await this.db
      .select()
      .from(paymentMethods)
      .where(
        and(
          eq(paymentMethods.customerId, customerId),
          eq(paymentMethods.isDefault, true),
          eq(paymentMethods.status, "active"),
        ),
      )
      .limit(1);
    return row ?? null;
  }

  async getOrderedByCustomer(customerId: string): Promise<PaymentMethod[]> {
    return this.db
      .select()
      .from(paymentMethods)
      .where(
        and(
          eq(paymentMethods.customerId, customerId),
          eq(paymentMethods.status, "active"),
        ),
      )
      .orderBy(
        desc(paymentMethods.isDefault),
        asc(paymentMethods.fallbackOrder),
      );
  }

  async findNextDefault(
    customerId: string,
    excludeId: string,
  ): Promise<PaymentMethod | null> {
    const [row] = await this.db
      .select()
      .from(paymentMethods)
      .where(
        and(
          eq(paymentMethods.customerId, customerId),
          eq(paymentMethods.status, "active"),
          ne(paymentMethods.id, excludeId),
        ),
      )
      .orderBy(asc(paymentMethods.createdAt))
      .limit(1);
    return row ?? null;
  }

  async updateDefault(
    id: string,
    isDefault: boolean,
    updatedAt?: Date,
  ): Promise<PaymentMethod> {
    const [row] = await this.db
      .update(paymentMethods)
      .set({ isDefault, updatedAt: updatedAt ?? new Date() })
      .where(eq(paymentMethods.id, id))
      .returning();
    if (!row) throw new Error("Expected row to be returned from UPDATE");
    return row;
  }

  async updateStatus(
    id: string,
    status: string,
    attrs?: Partial<PaymentMethod>,
    updatedAt?: Date,
  ): Promise<void> {
    await this.db
      .update(paymentMethods)
      .set({ ...attrs, status, updatedAt: updatedAt ?? new Date() })
      .where(eq(paymentMethods.id, id));
  }

  async updateFallbackOrder(
    id: string,
    fallbackOrder: number | null,
    updatedAt?: Date,
  ): Promise<PaymentMethod> {
    const [row] = await this.db
      .update(paymentMethods)
      .set({ fallbackOrder, updatedAt: updatedAt ?? new Date() })
      .where(eq(paymentMethods.id, id))
      .returning();
    if (!row) throw new Error("Expected row to be returned from UPDATE");
    return row;
  }

  async clearDefaults(customerId: string, updatedAt?: Date): Promise<void> {
    await this.db
      .update(paymentMethods)
      .set({ isDefault: false, updatedAt: updatedAt ?? new Date() })
      .where(
        and(
          eq(paymentMethods.customerId, customerId),
          eq(paymentMethods.isDefault, true),
        ),
      );
  }
}
