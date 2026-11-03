import { useState } from 'react';

import { ReasonForm } from '@/components/ReasonForm';
import { canCall } from '@/features/auth/access';
import { useSession } from '@/features/auth/session';

import type { Customer360 } from './types';
import { useFreeze, useRequestUnfreeze } from './useCustomers';

type Props = { customer: Customer360['customer'] };

/** Freeze takes effect at once; unfreeze goes to a second staff member (ADM-10). */
export function CustomerActions({ customer }: Props) {
  const roles = useSession((s) => s.session?.staff.roles ?? []);
  const [open, setOpen] = useState<'freeze' | 'unfreeze' | null>(null);
  const freeze = useFreeze(customer.user_id);
  const unfreeze = useRequestUnfreeze(customer.user_id);

  if (!canCall(roles, 'freezeCustomer')) {
    return <p className="muted hint">Only Compliance and Admin can freeze or unfreeze.</p>;
  }

  if (unfreeze.isSuccess) {
    return (
      <div className="card stack" role="status">
        <h3>Unfreeze sent for approval</h3>
        <p className="muted">
          Another staff member must approve it in the Approvals inbox before the account opens
          again. It expires if nobody decides in 72 hours.
        </p>
      </div>
    );
  }

  if (open === 'freeze') {
    return (
      <ReasonForm
        title={`Freeze ${customer.name}?`}
        description="Logins and outgoing money stop at once. Incoming money still lands."
        submitLabel="Freeze account"
        danger
        pending={freeze.isPending}
        error={freeze.error}
        onSubmit={(reason) => freeze.mutate(reason, { onSuccess: () => setOpen(null) })}
        onCancel={() => {
          setOpen(null);
          freeze.reset();
        }}
      />
    );
  }

  if (open === 'unfreeze') {
    return (
      <ReasonForm
        title="Request an unfreeze"
        description="A second staff member must approve this before the account opens again."
        submitLabel="Send for approval"
        pending={unfreeze.isPending}
        error={unfreeze.error}
        onSubmit={(reason) => unfreeze.mutate(reason)}
        onCancel={() => {
          setOpen(null);
          unfreeze.reset();
        }}
      />
    );
  }

  return customer.status === 'active' ? (
    <button type="button" className="btn btn-danger" onClick={() => setOpen('freeze')}>
      Freeze account
    </button>
  ) : customer.status === 'frozen' ? (
    <button type="button" className="btn" onClick={() => setOpen('unfreeze')}>
      Request unfreeze
    </button>
  ) : null;
}
