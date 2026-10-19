import { Dialog, useToast } from '@/components';
import { useSessionStore } from '@/stores';

import { useSignOut } from '../hooks/useSessionActions';

/**
 * Once, after a login that bound this device (AUTH-8): what the cool-off means,
 * and a way out if it was not the user. "Not me" signs out every device.
 */
export function NewDeviceNotice() {
  const open = useSessionStore((s) => s.session?.newDeviceNotice === true);
  const dismiss = useSessionStore((s) => s.dismissNewDeviceNotice);
  const signOut = useSignOut();
  const toast = useToast();

  return (
    <Dialog
      open={open}
      title="New device signed in"
      message="This is the first time you've logged in here. For the next 24 hours your sending limits are lower on this device, and we've told your other devices."
      confirmLabel="Got it"
      onConfirm={dismiss}
      cancelLabel="This wasn't me"
      onCancel={() => {
        void signOut({ allDevices: true }).then(() =>
          toast.show({
            message: 'Signed out on every device. Reset your password to keep them out.',
          }),
        );
      }}
    />
  );
}
