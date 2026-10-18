import type { Schema } from '@nem/contracts';
import { money, type Money } from '@nem/shared';

// Screens work in bigint Money (@nem/shared); the API carries minor units as a
// string. These are the app's crossings between the two (the mock bank has its own).

export type ApiMoney = Schema<'Money'>;

export const fromApiMoney = (dto: ApiMoney): Money => money(dto.amount_minor, dto.currency);

export const toApiMoney = (m: Money): ApiMoney => ({
  amount_minor: m.amount.toString(),
  currency: m.currency,
});
