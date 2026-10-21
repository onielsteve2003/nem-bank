import {
  customSharesError,
  equalShares,
  formatMoney,
  MAX_SPLIT_PARTICIPANTS,
  money,
} from '@nem/shared';
import { useRouter } from 'expo-router';
import { AtSign, Plus, Receipt, X } from 'lucide-react-native';
import { useState } from 'react';
import { ActivityIndicator, StyleSheet, View } from 'react-native';

import {
  Avatar,
  Button,
  Card,
  Chip,
  IconButton,
  Screen,
  Switch,
  Text,
  TextField,
} from '@/components';
import { isApiError } from '@/data';
import { useRepoMutation, useRepoQuery } from '@/lib/query';
import { useDebounced } from '@/lib/useDebounced';
import { useTheme } from '@/theme';

import { SendHeader } from '../components/SendHeader';
import { nemLookupQuery } from '../recipient';
import { requestErrorMessage } from '../requests';
import { parseNairaText, SPLIT_TITLE_MAX_LENGTH } from '../splits';
import { LOOKUP_DELAY_MS } from './RecipientScreen';

interface Person {
  nemtag: string;
  name: string;
}

const naira = (kobo: bigint) => formatMoney(money(kobo, 'NGN'));
const api = (kobo: bigint) => ({ amount_minor: kobo.toString(), currency: 'NGN' as const });

/**
 * Split a bill with Nem users (TRF-11): a title and total, who is in it, and
 * equal or custom shares. Each friend gets a money request for their share;
 * the bill then tracks who has paid.
 */
export function NewSplitScreen() {
  const router = useRouter();
  const { colors, spacing } = useTheme();
  const [title, setTitle] = useState('');
  const [totalText, setTotalText] = useState('');
  const [mode, setMode] = useState<'equal' | 'custom'>('equal');
  const [includeSelf, setIncludeSelf] = useState(true);
  const [people, setPeople] = useState<Person[]>([]);
  const [custom, setCustom] = useState<Record<string, string>>({});
  const [who, setWho] = useState('');
  const [error, setError] = useState<string>();

  const beneficiaries = useRepoQuery('beneficiaries', 'list', { query: { limit: 100 } });
  const suggestions = (beneficiaries.data?.data ?? [])
    .filter((b) => b.kind === 'nem' && b.nemtag && !people.some((p) => p.nemtag === b.nemtag))
    .slice(0, 6);

  const query = nemLookupQuery(useDebounced(who, LOOKUP_DELAY_MS));
  const lookup = useRepoQuery(
    'payees',
    'resolve',
    { body: { kind: 'nem', query: query ?? '' } },
    { enabled: query !== null, retry: false, staleTime: 60_000 },
  );
  const found = query ? lookup.data : undefined;
  const already = found?.nemtag ? people.some((p) => p.nemtag === found.nemtag) : false;
  const lookupError =
    query && isApiError(lookup.error)
      ? (lookup.error.problem.detail ?? 'No Nem user matches that.')
      : already
        ? `${found?.name} is already in this split.`
        : undefined;

  const create = useRepoMutation('moneyRequests', 'createSplitBill');

  const add = (person: Person) => {
    if (people.length >= MAX_SPLIT_PARTICIPANTS) return;
    setPeople((list) => [...list, person]);
    setWho('');
  };
  const remove = (nemtag: string) => setPeople((list) => list.filter((p) => p.nemtag !== nemtag));

  const total = parseNairaText(totalText);
  const equal = total ? equalShares(total, people.length, includeSelf) : null;
  const customAmounts = people.map((p) => parseNairaText(custom[p.nemtag] ?? ''));
  const customOk = customAmounts.every((a): a is bigint => a !== null);
  const asked = customOk ? customAmounts.reduce((a, b) => a + b, 0n) : null;
  const shareError =
    !total || people.length === 0
      ? null
      : mode === 'custom'
        ? customOk
          ? customSharesError(total, customAmounts, includeSelf)
          : null
        : null;
  const myShare =
    total && includeSelf
      ? mode === 'equal'
        ? (equal?.self ?? null)
        : asked !== null && asked <= total
          ? total - asked
          : null
      : null;
  const ready =
    title.trim().length > 0 &&
    total !== null &&
    people.length > 0 &&
    (mode === 'equal' || (customOk && !shareError));

  const submit = () => {
    if (!ready || !total) return;
    setError(undefined);
    create.mutate(
      {
        body: {
          title: title.trim(),
          total: api(total),
          split: mode,
          include_self: includeSelf,
          participants: people.map((p, i) =>
            mode === 'custom'
              ? { nemtag: p.nemtag, amount: api(customAmounts[i]!) }
              : { nemtag: p.nemtag },
          ),
        },
      },
      {
        onSuccess: (split) =>
          router.replace({ pathname: '/send/splits/[id]', params: { id: split.id } }),
        onError: (e) => setError(requestErrorMessage(e)),
      },
    );
  };

  return (
    <Screen
      header={<SendHeader title="Split a bill" />}
      edges={['top', 'bottom']}
      footer={
        <View style={{ gap: spacing[2] }}>
          {error && (
            <Text variant="bodySmall" color="danger" accessibilityLiveRegion="assertive">
              {error}
            </Text>
          )}
          <Button
            label={
              people.length > 0
                ? `Send ${people.length} ${people.length === 1 ? 'request' : 'requests'}`
                : 'Split it'
            }
            icon={Receipt}
            disabled={!ready}
            loading={create.isPending}
            onPress={submit}
          />
        </View>
      }
    >
      <TextField
        label="What's it for?"
        placeholder="Dinner at Yellow Chilli"
        value={title}
        onChangeText={setTitle}
        maxLength={SPLIT_TITLE_MAX_LENGTH}
      />
      <TextField
        label="Total"
        placeholder="0.00"
        keyboardType="decimal-pad"
        value={totalText}
        onChangeText={setTotalText}
        trailing={<Text color="textMuted">NGN</Text>}
        error={totalText.trim() && !total ? 'Enter an amount like 12500 or 12,500.50' : undefined}
      />

      <View style={{ gap: spacing[2] }}>
        <Text variant="label" color="textMuted">
          Split
        </Text>
        <View accessibilityRole="radiogroup" style={[styles.wrap, { gap: spacing[2] }]}>
          <Chip label="Equally" selected={mode === 'equal'} onPress={() => setMode('equal')} />
          <Chip
            label="Custom amounts"
            selected={mode === 'custom'}
            onPress={() => setMode('custom')}
          />
        </View>
      </View>
      <Switch
        label="Include my share"
        description={
          includeSelf
            ? 'You paid the bill, so your share counts as paid.'
            : 'Only the people you add pay; their shares make up the total.'
        }
        value={includeSelf}
        onValueChange={setIncludeSelf}
      />

      <View style={{ gap: spacing[2] }}>
        <Text variant="label" color="textMuted">
          {`Who's in (${people.length}/${MAX_SPLIT_PARTICIPANTS})`}
        </Text>
        {people.length < MAX_SPLIT_PARTICIPANTS && (
          <>
            <TextField
              label="Add a Nem user"
              placeholder="@nemtag, phone or account number"
              leadingIcon={AtSign}
              value={who}
              onChangeText={setWho}
              autoCapitalize="none"
              autoCorrect={false}
              error={lookupError}
              trailing={
                query && lookup.isFetching ? (
                  <ActivityIndicator
                    color={colors.textMuted}
                    accessibilityLabel="Looking them up"
                  />
                ) : undefined
              }
            />
            {found?.nemtag && !already && (
              <Button
                label={`Add ${found.name}`}
                icon={Plus}
                size="sm"
                variant="secondary"
                onPress={() => add({ nemtag: found.nemtag!, name: found.name })}
              />
            )}
            {suggestions.length > 0 && (
              <View style={[styles.wrap, { gap: spacing[2] }]}>
                {suggestions.map((b) => (
                  <Chip
                    key={b.id}
                    label={b.nickname ?? b.name.split(' ')[0]!}
                    icon={Plus}
                    onPress={() => add({ nemtag: b.nemtag!, name: b.name })}
                  />
                ))}
              </View>
            )}
          </>
        )}
      </View>

      {people.length > 0 && (
        <Card>
          <View style={{ gap: spacing[3] }}>
            {includeSelf && (
              <View style={[styles.row, { gap: spacing[3] }]}>
                <Avatar name="You" size="sm" />
                <Text style={styles.flex}>You</Text>
                <Text variant="bodyStrong" color="textMuted">
                  {myShare !== null ? naira(myShare) : '—'}
                </Text>
              </View>
            )}
            {people.map((p, i) => (
              <View key={p.nemtag} style={[styles.row, { gap: spacing[3] }]}>
                <Avatar name={p.name} size="sm" ring />
                <View style={styles.flex}>
                  <Text numberOfLines={1}>{p.name}</Text>
                  <Text variant="caption" color="textMuted">
                    @{p.nemtag}
                  </Text>
                </View>
                {mode === 'custom' ? (
                  <TextField
                    label={`${p.name.split(' ')[0]}'s share`}
                    placeholder="0.00"
                    keyboardType="decimal-pad"
                    value={custom[p.nemtag] ?? ''}
                    onChangeText={(v) => setCustom((c) => ({ ...c, [p.nemtag]: v }))}
                    style={styles.share}
                  />
                ) : (
                  <Text variant="bodyStrong">{equal ? naira(equal.friends[i]!) : '—'}</Text>
                )}
                <IconButton
                  icon={X}
                  size="sm"
                  variant="ghost"
                  accessibilityLabel={`Remove ${p.name}`}
                  onPress={() => remove(p.nemtag)}
                />
              </View>
            ))}
            {shareError && (
              <Text variant="bodySmall" color="danger" accessibilityRole="alert">
                {shareError}
              </Text>
            )}
          </View>
        </Card>
      )}
      <Text variant="caption" color="textMuted">
        Everyone gets a request they can pay from their Nem app within 7 days.
      </Text>
    </Screen>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: 'row', alignItems: 'center' },
  wrap: { flexDirection: 'row', flexWrap: 'wrap' },
  flex: { flex: 1 },
  share: { width: 120 },
});
