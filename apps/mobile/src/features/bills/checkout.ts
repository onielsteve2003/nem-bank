import type { Schema } from '@nem/contracts';
import { useRouter } from 'expo-router';
import { useState } from 'react';

import { sendErrorMessage } from '@/features/transfers/confirm';
import { scheduleBody, type ScheduleChoice } from '@/features/transfers/schedule';
import { useMoneyMutation } from '@/lib/query';

/**
 * Pays a bill now (opening its receipt) or schedules it (BILL-3, opening the
 * scheduled bills). Both are single idempotent calls behind the PIN.
 */
export function useBillCheckout() {
  const router = useRouter();
  const [error, setError] = useState<string>();
  const pay = useMoneyMutation('bills', 'pay', {
    invalidates: [['bills'], ['accounts'], ['transactions']],
  });
  const schedule = useMoneyMutation('bills', 'createSchedule', { invalidates: [['bills']] });

  /** Resolves true once done; `close` runs just before the next screen opens. */
  const submit = async (
    payment: Schema<'PayBillRequest'>,
    when: ScheduleChoice | null,
    close: () => void,
  ) => {
    setError(undefined);
    try {
      if (when) {
        // Nothing moves today: each run is checked and paid when it is due.
        const { save_as: _unused, ...body } = payment;
        const created = await schedule.mutateAsync({
          body: { payment: body, frequency: when.frequency, start_at: scheduleBody(when).start_at },
        });
        close();
        router.replace({ pathname: '/bills/scheduled', params: { created: created.id } });
        return true;
      }
      const paid = await pay.mutateAsync({ body: payment });
      close();
      router.replace({ pathname: '/bills/receipt/[id]', params: { id: paid.id } });
      return true;
    } catch (e) {
      setError(sendErrorMessage(e as Error).message);
      return false;
    }
  };

  const reset = () => {
    pay.resetIntent();
    schedule.resetIntent();
  };

  return { submit, error, reset };
}
