import type { Money as MoneyDto } from '@nem/contracts';
import { formatMoney, fromDto, type FormatMoneyOptions } from '@nem/shared';

type Props = FormatMoneyOptions & { value: MoneyDto; className?: string };

/** The only place the console formats money (code-standards §3). */
export function MoneyText({ value, className, ...options }: Props) {
  return (
    <span className={['num', className].filter(Boolean).join(' ')}>
      {formatMoney(fromDto(value), options)}
    </span>
  );
}
