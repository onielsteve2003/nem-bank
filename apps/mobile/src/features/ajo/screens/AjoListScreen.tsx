import { normalizeNemtag } from '@nem/shared';
import { useRouter } from 'expo-router';
import { Plus, Ticket, Users } from 'lucide-react-native';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
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
  const { t } = useTranslation();
  const groups = useRepoQuery('ajo', 'listGroups');
  const [invite, setInvite] = useState('');
  const code = inviteCodeOf(invite);

  return (
    <Screen
      header={<SendHeader title={t('ajo.title')} first />}
      edges={['top', 'bottom']}
      footer={
        <Button label={t('ajo.list.start')} icon={Plus} onPress={() => router.push('/ajo/new')} />
      }
      onRefresh={() => void groups.refetch()}
      refreshing={groups.isRefetching}
    >
      {groups.isError ? (
        <ErrorState title={t('ajo.list.failed')} onRetry={() => groups.refetch()} />
      ) : !groups.data ? (
        <SkeletonGroup accessibilityLabel={t('ajo.list.loading')}>
          <Skeleton height={72} />
          <Skeleton height={72} />
        </SkeletonGroup>
      ) : groups.data.data.length === 0 ? (
        <EmptyState
          icon={Users}
          title={t('ajo.list.emptyTitle')}
          message={t('ajo.list.emptyMessage')}
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
              accessibilityLabel={t('ajo.list.rowLabel', {
                name: g.name,
                subtitle: groupSubtitle(g),
                status: AJO_STATUS[g.status].label,
              })}
            />
          ))}
        </Card>
      )}

      <View style={{ gap: spacing[2] }}>
        <SectionHeader title={t('ajo.list.gotInvite')} />
        <TextField
          label={t('ajo.list.inviteField')}
          placeholder={t('ajo.list.invitePlaceholder')}
          leadingIcon={Ticket}
          autoCapitalize="characters"
          autoCorrect={false}
          value={invite}
          onChangeText={setInvite}
          error={invite.trim() && !code ? t('ajo.list.inviteInvalid') : undefined}
        />
        <Button
          label={t('ajo.list.openInvite')}
          variant="secondary"
          disabled={!code}
          onPress={() => code && router.push({ pathname: '/ajo/[code]', params: { code } })}
        />
      </View>
    </Screen>
  );
}
