import type { StaffRole } from '@nem/contracts';

import { ROLE_LABELS } from '@/features/auth/access';
import { useSession } from '@/features/auth/session';
import { useSignOut, useSwitchRole } from '@/features/auth/useAuth';

const ROLES = Object.keys(ROLE_LABELS) as StaffRole[];

export function StaffMenu() {
  const staff = useSession((s) => s.session?.staff);
  const signOut = useSignOut();
  const switchRole = useSwitchRole();
  if (!staff) return null;
  const role = staff.roles[0] ?? 'support';

  return (
    <>
      {switchRole && (
        <label className="row role-switch">
          <span className="muted">View as</span>
          <select
            className="select"
            value={role}
            aria-label="Demo: view the console as another role"
            onChange={(e) => switchRole(e.target.value as StaffRole)}
          >
            {ROLES.map((r) => (
              <option key={r} value={r}>
                {ROLE_LABELS[r]}
              </option>
            ))}
          </select>
        </label>
      )}
      <span className="staff-chip">
        <strong>{staff.name}</strong>
        <span className="badge">{staff.roles.map((r) => ROLE_LABELS[r]).join(', ')}</span>
      </span>
      <button type="button" className="btn" onClick={() => void signOut()}>
        Sign out
      </button>
    </>
  );
}
