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

/** The security tools. A tool without an `href` gets its screen in a later task (T14.7). */
const TOOLS: { title: string; subtitle: string; icon: LucideIcon; href?: Href }[] = [
  {
    title: 'Panic button',
    subtitle: 'Freeze every card and stop money going out',
    icon: OctagonX,
    href: '/security/panic',
  },
  {
    title: 'Devices and sessions',
    subtitle: 'See where you’re signed in',
    icon: MonitorSmartphone,
    href: '/security/devices',
  },
  {
    title: 'Your limits',
    subtitle: 'Set a daily limit below your KYC cap',
    icon: Gauge,
    href: '/security/limits',
  },
  {
    title: 'Duress PIN',
    subtitle: 'A PIN that opens a decoy if you’re forced',
    icon: UserX,
    href: '/security/duress',
  },
  {
    title: 'Scam checker',
    subtitle: 'Paste a message, link or account number',
    icon: ScanSearch,
    href: '/security/scam',
  },
  { title: 'Login and payment alerts', subtitle: 'Choose what we tell you about', icon: Bell },
];

function CheckupRow({ item, onFix }: { item: Schema<'CheckupItem'>; onFix?: () => void }) {
  const { spacing } = useTheme();
  return (
    <View style={[styles.row, { gap: spacing[3], padding: spacing[4] }]}>
      <Icon
        icon={item.done ? CircleCheck : Circle}
        color={item.done ? 'success' : 'textMuted'}
        accessibilityLabel={item.done ? 'Done' : 'To do'}
      />
      <View style={[styles.flex, { gap: spacing[1] }]}>
        <Text variant="bodyStrong">{item.title}</Text>
        <Text variant="bodySmall" color="textMuted">
          {item.description}
        </Text>
        {!item.done && onFix && (
          <View style={styles.start}>
            <Button
              label="Fix this"
              size="sm"
              variant="secondary"
              onPress={onFix}
              accessibilityHint={item.title}
            />
          </View>
        )}
        {!item.done && !onFix && (
          <Text variant="caption" color="textMuted">
            You can fix this soon
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
  const q = useRepoQuery('security', 'getCheckup');
  const panic = useRepoQuery('security', 'getPanic');
  const [asking, setAsking] = useState(false);
  const checkup = q.data;

  let body;
  if (q.isError && !checkup) {
    body = <ErrorState title="We couldn't run your checkup" onRetry={() => q.refetch()} />;
  } else if (!checkup) {
    body = (
      <SkeletonGroup accessibilityLabel="Running your security checkup">
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
                ? 'Everything on the checkup is done. Nice.'
                : `${todo.length} ${todo.length === 1 ? 'thing' : 'things'} left, worth ${todo.reduce((s, i) => s + i.points, 0)} points.`}
            </Text>
          </View>
        </Card>
        {todo.length > 0 && (
          <View style={{ gap: spacing[2] }}>
            <SectionHeader title="Do next" />
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
            <SectionHeader title="Done" />
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
      header={<SendHeader title="Security" first />}
      edges={['top', 'bottom']}
      onRefresh={() => void q.refetch()}
      refreshing={q.isRefetching}
    >
      {panic.data?.active && (
        <Card>
          <View style={{ gap: spacing[3] }} accessibilityRole="alert">
            <View style={[styles.row, { gap: spacing[2], alignItems: 'center' }]}>
              <Icon icon={OctagonX} color="danger" accessibilityLabel="Panic mode on" />
              <Text variant="bodyStrong">Panic mode is on</Text>
            </View>
            <Text variant="bodySmall" color="textMuted">
              {panicSummary(panic.data)}
            </Text>
            <View style={styles.start}>
              <Button
                label="Manage"
                size="sm"
                variant="secondary"
                onPress={() => router.push('/security/panic')}
                accessibilityHint="Panic mode"
              />
            </View>
          </View>
        </Card>
      )}
      {body}
      <View style={{ gap: spacing[2] }}>
        <SectionHeader title="Tools" />
        <Card padded={false}>
          {TOOLS.map(({ href, ...t }) =>
            href ? (
              <ListItem
                key={t.title}
                title={t.title}
                subtitle={t.subtitle}
                leading={t.icon}
                onPress={() => router.push(href)}
              />
            ) : (
              <ListItem
                key={t.title}
                title={t.title}
                subtitle={t.subtitle}
                leading={t.icon}
                trailing={<Badge label="Soon" tone="neutral" />}
                accessibilityLabel={`${t.title}. ${t.subtitle}. Coming soon`}
              />
            ),
          )}
        </Card>
      </View>
      {asking && (
        <SecurityQuestionSheet
          onClose={() => setAsking(false)}
          onSaved={() => {
            setAsking(false);
            toast.show({ message: 'Security question saved', tone: 'success' });
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
