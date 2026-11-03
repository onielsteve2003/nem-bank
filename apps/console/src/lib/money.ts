import type { Schema } from '@nem/contracts';
import { money, type Money } from '@nem/shared';

// Pages work in bigint Money (@nem/shared); the API carries minor units as a string.
// Same crossing as the mobile app's lib/money.ts.

export type ApiMoney = Schema<'Money'>;

export const fromApiMoney = (dto: ApiMoney): Money => money(dto.amount_minor, dto.currency);
