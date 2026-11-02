import { useToast } from '@/components';
import { useRepoMutation } from '@/lib/query';
import { toApiPreferences, usePreferencesStore, usePrivacyStore, type Preferences } from '@/stores';

type Change = Partial<Omit<Preferences, 'ai'>> & { hideBalances?: boolean };

/**
 * Changes app settings (SET-1, SET-3): on this phone at once, so the app
 * responds immediately, then at the bank so a new device starts the same way.
 * A failed save puts the settings back.
 */
export function useSavePreferences() {
  const toast = useToast();
  const save = useRepoMutation('users', 'setPreferences', { invalidates: [] });

  return ({ hideBalances, ...change }: Change) => {
    const before = usePreferencesStore.getState();
    const hiddenBefore = usePrivacyStore.getState().balancesHidden;
    const previous = Object.fromEntries(
      Object.keys(change).map((k) => [k, before[k as keyof typeof change]]),
    ) as Partial<Preferences>;
    usePreferencesStore.setState(change);
    if (hideBalances !== undefined) usePrivacyStore.getState().setBalancesHidden(hideBalances);
    save.mutate(
      {
        body: toApiPreferences(
          usePreferencesStore.getState(),
          usePrivacyStore.getState().balancesHidden,
        ),
      },
      {
        onError: () => {
          usePreferencesStore.setState(previous);
          usePrivacyStore.getState().setBalancesHidden(hiddenBefore);
          toast.show({ message: "That didn't save. Try again.", tone: 'error' });
        },
      },
    );
  };
}
