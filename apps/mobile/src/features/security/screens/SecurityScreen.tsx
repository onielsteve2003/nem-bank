import type { Schema } from '@nem/contracts';
import { useRouter, type Href } from 'expo-router';
import {
  Bell,
  Circle,
  CircleCheck,
  Gauge,
  MonitorSmartphone,
  OctagonX,
  ScanSearch,
  UserX,
  type LucideIcon,
} from 'lucide-react-native';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { StyleSheet, View } from 'react-native';

import {
  Badge,
  Button,
  Card,
  Divider,
  ErrorState,
  Icon,
  ListItem,
  Screen,
  SectionHeader,
  Skeleton,
  SkeletonGroup,
  Text,
  useToast,
} from '@/components';
import { SendHeader } from '@/features/transfers/components/SendHeader';
import { useRepoQuery } from '@/lib/query';
import { useTheme } from '@/theme';

import { ScoreRing } from '../components/ScoreRing';
import { SecurityQuestionSheet } from '../components/SecurityQuestionSheet';
import { checkupAction, panicSummary, splitCheckup } from '../security';

/** The security tools, each with its own screen. */
const TOOLS: {
  key: 'panic' | 'devices' | 'limits' | 'duress' | 'scam' | 'alerts';
  icon: LucideIcon;
  href: Href;
}[] = [
  { key: 'panic', icon: OctagonX, href: '/security/panic' },
  { key: 'devices', icon: MonitorSmartphone, href: '/security/devices' },
  { key: 'limits', icon: Gauge, href: '/security/limits' },
  { key: 'duress', icon: UserX, href: '/security/duress' },
  { key: 'scam', icon: ScanSearch, href: '/security/scam' },
  { key: 'alerts', icon: Bell, href: '/security/alerts' },
];

function CheckupRow({ item, onFix }: { item: Schema<'CheckupItem'>; onFix?: () => void }) {
  const { spacing } = useTheme();
  const { t } = useTranslation();
  return (
    <View style={[styles.row, { gap: spacing[3], padding: spacing[4] }]}>
      <Icon
        icon={item.done ? CircleCheck : Circle}
        color={item.done ? 'success' : 'textMuted'}
        accessibilityLabel={t(item.done ? 'security.center.done' : 'security.center.toDo')}
      />
      <View style={[styles.flex, { gap: spacing[1] }]}>
        <Text variant="bodyStrong">{item.title}</Text>
        <Text variant="bodySmall" color="textMuted">
          {item.description}
        </Text>
        {!item.done && onFix && (
          <View style={styles.start}>
            <Button
              label={t('security.center.fix')}
              size="sm"
              variant="secondary"
              onPress={onFix}
              accessibilityHint={item.title}
            />
          </View>
        )}
        {!item.done && !onFix && (
          <Text variant="caption" color="textMuted">
            {t('security.center.fixSoon')}
          </Text>
        )}
      </View>
      {!item.done && <Badge label={`+${item.points}`} tone="primary" />}
    </View>
  );
}

/**
 * Security center (SEC-1): a 0–100 checkup score with what to fix next, most
 * points first, and the way into every security tool.
 */
export function SecurityScreen() {
  const router = useRouter();
  const toast = useToast();
  const { spacing } = useTheme();
  const { t } = useTranslation();
  const q = useRepoQuery('security', 'getCheckup');
  const panic = useRepoQuery('security', 'getPanic');
  const [asking, setAsking] = useState(false);
  const checkup = q.data;

  let body;
  if (q.isError && !checkup) {
    body = <ErrorState title={t('security.center.failed')} onRetry={() => q.refetch()} />;
  } else if (!checkup) {
    body = (
      <SkeletonGroup accessibilityLabel={t('security.center.loading')}>
        <Skeleton height={190} />
        <Skeleton height={260} />
      </SkeletonGroup>
    );
  } else {
    const { todo, done } = splitCheckup(checkup.items);
    const fix = (item: Schema<'CheckupItem'>) => {
      const action = checkupAction(item.id);
      if (!action) return undefined;
      return action.kind === 'question' ? () => setAsking(true) : () => router.push(action.href);
    };
    body = (
      <>
        <Card>
          <View style={{ gap: spacing[3] }}>
            <ScoreRing score={checkup.score} />
            <Text variant="bodySmall" color="textMuted" align="center">
              {todo.length === 0
                ? t('security.center.allDone')
                : t('security.center.left', {
                    count: todo.length,
                    points: todo.reduce((s, i) => s + i.points, 0),
                  })}
            </Text>
          </View>
        </Card>
        {todo.length > 0 && (
          <View style={{ gap: spacing[2] }}>
            <SectionHeader title={t('security.center.doNext')} />
            <Card padded={false}>
              <View accessibilityRole="list">
                {todo.map((item, i) => (
                  <View key={item.id}>
                    {i > 0 && <Divider />}
                    <CheckupRow item={item} onFix={fix(item)} />
                  </View>
                ))}
              </View>
            </Card>
          </View>
        )}
        {done.length > 0 && (
          <View style={{ gap: spacing[2] }}>
            <SectionHeader title={t('security.center.done')} />
            <Card padded={false}>
              <View accessibilityRole="list">
                {done.map((item, i) => (
                  <View key={item.id}>
                    {i > 0 && <Divider />}
                    <CheckupRow item={item} />
                  </View>
                ))}
              </View>
            </Card>
          </View>
        )}
      </>
    );
  }

  return (
    <Screen
      header={<SendHeader title={t('security.title')} first />}
      edges={['top', 'bottom']}
      onRefresh={() => void q.refetch()}
      refreshing={q.isRefetching}
    >
      {panic.data?.active && (
        <Card>
          <View style={{ gap: spacing[3] }} accessibilityRole="alert">
            <View style={[styles.row, { gap: spacing[2], alignItems: 'center' }]}>
              <Icon
                icon={OctagonX}
                color="danger"
                accessibilityLabel={t('security.panic.onLabel')}
              />
              <Text variant="bodyStrong">{t('security.panic.isOn')}</Text>
            </View>
            <Text variant="bodySmall" color="textMuted">
              {panicSummary(panic.data)}
            </Text>
            <View style={styles.start}>
              <Button
                label={t('common.manage')}
                size="sm"
                variant="secondary"
                onPress={() => router.push('/security/panic')}
                accessibilityHint={t('security.center.panicHint')}
              />
            </View>
          </View>
        </Card>
      )}
      {body}
      <View style={{ gap: spacing[2] }}>
        <SectionHeader title={t('security.center.tools_title')} />
        <Card padded={false}>
          {TOOLS.map((tool) => (
            <ListItem
              key={tool.key}
              title={t(`security.center.tools.${tool.key}.title`)}
              subtitle={t(`security.center.tools.${tool.key}.subtitle`)}
              leading={tool.icon}
              onPress={() => router.push(tool.href)}
            />
          ))}
        </Card>
      </View>
      {asking && (
        <SecurityQuestionSheet
          onClose={() => setAsking(false)}
          onSaved={() => {
            setAsking(false);
            toast.show({ message: t('security.question.saved'), tone: 'success' });
          }}
        />
      )}
    </Screen>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: 'row', alignItems: 'flex-start' },
  flex: { flex: 1 },
  start: { alignItems: 'flex-start' },
});
