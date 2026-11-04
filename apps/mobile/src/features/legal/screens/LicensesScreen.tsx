import { Code } from '@/components/icons';
import { useTranslation } from 'react-i18next';
import { Linking, StyleSheet, View } from 'react-native';

import { Card, Divider, ListItem, Screen, Text } from '@/components';
import { SendHeader } from '@/features/transfers/components/SendHeader';
import { useTheme } from '@/theme';

import licenses from '../licenses.json';

const REPO = 'https://github.com/onielsteve2003/nem-bank';

/** Open-source licences (SET-6), generated from package.json by `pnpm licenses`. */
export function LicensesScreen() {
  const { spacing } = useTheme();
  const { t } = useTranslation();

  return (
    <Screen header={<SendHeader title={t('legal.licenses')} />} edges={['top', 'bottom']}>
      <Text variant="bodySmall" color="textMuted">
        {t('legal.licensesIntro')}
      </Text>
      <Card padded={false}>
        <ListItem
          title={t('legal.source')}
          subtitle={t('legal.sourceHint')}
          leading={Code}
          onPress={() => void Linking.openURL(REPO)}
        />
      </Card>
      <Card>
        {licenses.map((pkg, i) => (
          <View key={pkg.name}>
            {i > 0 && <Divider />}
            <View
              style={[styles.row, { gap: spacing[3], paddingVertical: spacing[2] }]}
              accessible
              accessibilityLabel={`${pkg.name} ${pkg.version}, ${pkg.license}`}
            >
              <View style={styles.flex}>
                <Text variant="bodySmall">{pkg.name}</Text>
                <Text variant="caption" color="textMuted">
                  {pkg.version}
                </Text>
              </View>
              <Text variant="caption" color="textMuted">
                {pkg.license}
              </Text>
            </View>
          </View>
        ))}
      </Card>
    </Screen>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: 'row', alignItems: 'center' },
  flex: { flex: 1 },
});
