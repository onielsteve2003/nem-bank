import { ArrowDownLeft, Landmark, Wallet } from 'lucide-react-native';
import { useState } from 'react';
import { StyleSheet, View } from 'react-native';

import { Avatar, Badge, Card, Chip, Divider, ListItem, SectionHeader, Text } from '@/components';
import { useTheme } from '@/theme';

import { KitSection } from './KitSection';

const FILTERS = ['All', 'Money in', 'Money out', 'Bills'] as const;

export function DisplaySection() {
  const { spacing } = useTheme();
  const [filter, setFilter] = useState<(typeof FILTERS)[number]>('All');
  const [applied, setApplied] = useState(['This month', 'Over ₦10,000']);

  return (
    <>
      <KitSection title="Cards and lists">
        <Card>
          <Text variant="label" color="textMuted">
            Main account
          </Text>
          <Text variant="amountLarge">₦248,500.00</Text>
        </Card>
        <Card variant="outline" onPress={() => undefined} accessibilityLabel="Open savings">
          <Text variant="bodyStrong">Pressable outline card</Text>
          <Text variant="bodySmall" color="textMuted">
            Tap it to feel the press
          </Text>
        </Card>
        <Card padded={false}>
          <ListItem
            title="Ada Lovelace"
            subtitle="Received · 09:41"
            leading={<Avatar name="Ada Lovelace" />}
            trailing="+₦12,000"
          />
          <Divider inset={spacing[16]} />
          <ListItem
            title="Wallets"
            subtitle="NGN, USD, GBP"
            leading={Wallet}
            onPress={() => undefined}
          />
          <Divider inset={spacing[16]} />
          <ListItem
            title="Linked bank"
            leading={Landmark}
            trailing={<Badge label="New" tone="primary" />}
            onPress={() => undefined}
          />
          <Divider inset={spacing[16]} />
          <ListItem
            title="Disabled row"
            leading={ArrowDownLeft}
            onPress={() => undefined}
            disabled
          />
        </Card>
        <Divider label="or" />
      </KitSection>
      <KitSection title="Avatars and badges">
        <View style={[styles.row, { gap: spacing[3] }]}>
          <Avatar name="Chidi Okafor" size="sm" />
          <Avatar name="Ngozi" size="md" ring />
          <Avatar name="Tunde Bakare" size="lg" uri="https://i.pravatar.cc/112?img=12" />
          <Avatar name="Broken Image" size="xl" uri="https://invalid.example/nope.png" />
        </View>
        <View style={[styles.row, { gap: spacing[2] }]}>
          <Badge label="Neutral" />
          <Badge label="Verified" tone="success" />
          <Badge label="Pending" tone="warning" />
          <Badge label="Failed" tone="danger" />
          <Badge label="Info" tone="info" />
          <Badge count={7} tone="danger" />
          <Badge count={240} tone="primary" />
          <Badge dot tone="success" accessibilityLabel="Online" />
        </View>
      </KitSection>
      <KitSection title="Chips">
        <SectionHeader title="Transactions" actionLabel="See all" onAction={() => undefined} />
        <View style={[styles.row, { gap: spacing[2] }]}>
          {FILTERS.map((f) => (
            <Chip key={f} label={f} selected={filter === f} onPress={() => setFilter(f)} />
          ))}
        </View>
        <View style={[styles.row, { gap: spacing[2] }]}>
          {applied.map((f) => (
            <Chip key={f} label={f} onRemove={() => setApplied((a) => a.filter((x) => x !== f))} />
          ))}
        </View>
      </KitSection>
    </>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: 'row', alignItems: 'center', flexWrap: 'wrap' },
});
