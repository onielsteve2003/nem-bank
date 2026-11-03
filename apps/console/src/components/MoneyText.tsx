import { formatMoney, type FormatMoneyOptions } from '@nem/shared';

import { fromApiMoney, type ApiMoney } from '@/lib/money';

type Props = FormatMoneyOptions & { value: ApiMoney; className?: string };

/** The only place the console formats money (code-standards §3). */
export function MoneyText({ value, className, ...options }: Props) {
  return (
    <span className={['num', className].filter(Boolean).join(' ')}>
      {formatMoney(fromApiMoney(value), options)}
    </span>
  );
}
