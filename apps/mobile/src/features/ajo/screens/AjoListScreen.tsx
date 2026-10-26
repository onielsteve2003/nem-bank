import { normalizeNemtag } from '@nem/shared';
import { useRouter } from 'expo-router';
import { Plus, Ticket, Users } from 'lucide-react-native';
import { useState } from 'react';
import { View } from 'react-native';

import {
  Badge,
  Button,
  Card,
  EmptyState,
  ErrorState,
  ListItem,
  Screen,
  SectionHeader,
  Skeleton,
  SkeletonGroup,
  TextField,
} from '@/components';
import { SendHeader } from '@/features/transfers/components/SendHeader';
import { useRepoQuery } from '@/lib/query';
import { useTheme } from '@/theme';

import { AJO_STATUS, groupSubtitle } from '../ajo';

/** Codes are six letters or numbers; links end in the code. */
export function inviteCodeOf(input: string): string | null {
  const code = normalizeNemtag(input.split('/').pop() ?? '').toUpperCase();
  return /^[A-Z0-9]{6}$/.test(code) ? code : null;
}

/**
 * Ajo (AJO-1, AJO-2): the customer's groups, starting a new one, and opening
 * an invite someone shared by its link or code.
 */
export function AjoListScreen() {
  const router = useRouter();
  const { spacing } = useTheme();
  const groups = useRepoQuery('ajo', 'listGroups');
  const [invite, setInvite] = useState('');
  const code = inviteCodeOf(invite);

  return (
    <Screen
      header={<SendHeader title="Ajo" first />}
      edges={['top', 'bottom']}
      footer={<Button label="Start an ajo" icon={Plus} onPress={() => router.push('/ajo/new')} />}
      onRefresh={() => void groups.refetch()}
      refreshing={groups.isRefetching}
    >
      {groups.isError ? (
        <ErrorState title="We couldn't load your ajo groups" onRetry={() => groups.refetch()} />
      ) : !groups.data ? (
        <SkeletonGroup accessibilityLabel="Loading ajo groups">
          <Skeleton height={72} />
          <Skeleton height={72} />
        </SkeletonGroup>
      ) : groups.data.data.length === 0 ? (
        <EmptyState
          icon={Users}
          title="No ajo yet"
          message="Save in turns with people you trust: everyone pays in each cycle and one person takes the whole pot."
        />
      ) : (
        <Card padded={false}>
          {groups.data.data.map((g) => (
            <ListItem
              key={g.id}
              leading={Users}
              title={g.name}
              subtitle={groupSubtitle(g)}
              trailing={
                <Badge label={AJO_STATUS[g.status].label} tone={AJO_STATUS[g.status].tone} />
              }
              onPress={() => router.push({ pathname: '/ajo/group/[id]', params: { id: g.id } })}
              accessibilityLabel={`${g.name}. ${groupSubtitle(g)}. ${AJO_STATUS[g.status].label}`}
            />
          ))}
        </Card>
      )}

      <View style={{ gap: spacing[2] }}>
        <SectionHeader title="Got an invite?" />
        <TextField
          label="Invite link or code"
          placeholder="e.g. YABA04"
          leadingIcon={Ticket}
          autoCapitalize="characters"
          autoCorrect={false}
          value={invite}
          onChangeText={setInvite}
          error={
            invite.trim() && !code ? 'Paste the whole link or the 6-character code' : undefined
          }
        />
        <Button
          label="Open invite"
          variant="secondary"
          disabled={!code}
          onPress={() => code && router.push({ pathname: '/ajo/[code]', params: { code } })}
        />
      </View>
    </Screen>
  );
}
