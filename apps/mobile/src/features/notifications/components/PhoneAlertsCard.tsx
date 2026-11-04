import * as Linking from 'expo-linking';
import { BellRing, CircleCheck, Info, TriangleAlert } from '@/components/icons';
import { useState } from 'react';
import { StyleSheet, View } from 'react-native';

import { Button, Card, Icon, Text, useToast } from '@/components';
import { getPushSupport, showLocalAlert } from '@/lib/pushNotifications';
import { useTheme } from '@/theme';

import { askPushPermission, phoneAlertStatus, usePushStore } from '../push';
import { useTranslation } from 'react-i18next';

const ICONS = { success: CircleCheck, warning: TriangleAlert, info: Info } as const;

/** Whether this phone can show Nem's alerts, and the one thing to do about it (NOT-3). */
export function PhoneAlertsCard() {
  const toast = useToast();
  const { spacing } = useTheme();
  const { t } = useTranslation();
  const permission = usePushStore((s) => s.permission);
  const [asking, setAsking] = useState(false);
  const status = phoneAlertStatus(getPushSupport(), permission);

  const enable = async () => {
    setAsking(true);
    const result = await askPushPermission();
    setAsking(false);
    if (result !== 'granted') {
      toast.show({ message: t('notifications.phone.stay'), tone: 'info' });
    }
  };

  const test = () =>
    void showLocalAlert({
      id: 'test',
      title: t('notifications.phone.testTitle'),
      body: t('notifications.phone.testBody'),
      deepLink: null,
    });

  return (
    <Card>
      <View style={[styles.row, { gap: spacing[3] }]}>
        <Icon icon={ICONS[status.tone]} color={status.tone} />
        <View style={[styles.flex, { gap: spacing[1] }]}>
          <Text variant="bodyStrong">{status.title}</Text>
          <Text variant="bodySmall" color="textMuted">
            {status.detail}
          </Text>
        </View>
      </View>
      {status.action === 'enable' && (
        <Button
          label={t('notifications.phone.turnOn')}
          icon={BellRing}
          loading={asking}
          onPress={() => void enable()}
          style={{ marginTop: spacing[3] }}
        />
      )}
      {status.action === 'settings' && (
        <Button
          label={t('notifications.phone.openSettings')}
          variant="secondary"
          onPress={() => void Linking.openSettings()}
          style={{ marginTop: spacing[3] }}
        />
      )}
      {status.action === 'test' && (
        <Button
          label={t('notifications.phone.test')}
          variant="secondary"
          onPress={test}
          style={{ marginTop: spacing[3] }}
        />
      )}
    </Card>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: 'row', alignItems: 'flex-start' },
  flex: { flex: 1 },
});
