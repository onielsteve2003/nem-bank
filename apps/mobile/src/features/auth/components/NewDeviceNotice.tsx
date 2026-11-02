import { Dialog, useToast } from '@/components';
import { useSessionStore } from '@/stores';

import { useSignOut } from '../hooks/useSessionActions';
import { useTranslation } from 'react-i18next';

/**
 * Once, after a login that bound this device (AUTH-8): what the cool-off means,
 * and a way out if it was not the user. "Not me" signs out every device.
 */
export function NewDeviceNotice() {
  const open = useSessionStore((s) => s.session?.newDeviceNotice === true);
  const dismiss = useSessionStore((s) => s.dismissNewDeviceNotice);
  const signOut = useSignOut();
  const toast = useToast();
  const { t } = useTranslation();

  return (
    <Dialog
      open={open}
      title={t('auth.newDevice.title')}
      message={t('auth.newDevice.message')}
      confirmLabel={t('auth.newDevice.ok')}
      onConfirm={dismiss}
      cancelLabel={t('auth.newDevice.notMe')}
      onCancel={() => {
        void signOut({ allDevices: true }).then(() =>
          toast.show({
            message: t('auth.newDevice.signedOut'),
          }),
        );
      }}
    />
  );
}
