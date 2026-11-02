import { useToast } from '@/components';
import i18n from '@/lib/i18n';
import { useRepoMutation } from '@/lib/query';
import { toApiPreferences, usePreferencesStore, usePrivacyStore, type AiFeature } from '@/stores';

/**
 * Turns one AI feature on or off: on this phone at once, then at the bank,
 * which applies it on the server side too (the assistant refuses while off).
 * A failed save puts the switch back.
 */
export function useAiToggle() {
  const toast = useToast();
  const setAiFeature = usePreferencesStore((s) => s.setAiFeature);
  const save = useRepoMutation('users', 'setPreferences', { invalidates: [] });

  return (feature: AiFeature, on: boolean) => {
    setAiFeature(feature, on);
    const prefs = usePreferencesStore.getState();
    save.mutate(
      { body: toApiPreferences(prefs, usePrivacyStore.getState().balancesHidden) },
      {
        onError: () => {
          setAiFeature(feature, !on);
          toast.show({ message: i18n.t('common.saveFailed'), tone: 'error' });
        },
      },
    );
  };
}
