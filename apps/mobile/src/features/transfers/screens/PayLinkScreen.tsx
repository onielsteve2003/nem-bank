import { formatMoney } from '@nem/shared';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { Link2, LogIn, Send, X } from '@/components/icons';
import { useState } from 'react';
import { StyleSheet, View } from 'react-native';

import {
  AmountInput,
  Avatar,
  Button,
  Card,
  DemoMoneyBadge,
  EmptyState,
  ErrorState,
  IconButton,
  ModalSheetHost,
  MoneyText,
  Screen,
  SkeletonGroup,
  SkeletonListItem,
  Text,
  TextField,
} from '@/components';
import { isApiError } from '@/data';
import { env } from '@/lib/env';
import { fromApiMoney, toApiMoney } from '@/lib/money';
import { useMoneyMutation, useRepoQuery } from '@/lib/query';
import { useSessionStore } from '@/stores';
import { useTheme } from '@/theme';

import { typedNaira } from '../amount';
import { ConfirmSheet } from '../components/ConfirmSheet';
import { sendErrorMessage } from '../confirm';
import { linkClosedReason, PAY_NOTE_MAX_LENGTH } from '../paymentLinks';
import { useTranslation } from 'react-i18next';

/**
 * The pay page behind a payment link (TRF-12). Anyone can open it, signed in or
 * not, on the web demo or in the app: it shows who is asking and for what. To
 * pay, the payer signs in to Nem and approves with their PIN, like any transfer.
 */
export function PayLinkScreen() {
  const router = useRouter();
  const { spacing } = useTheme();
  const { t } = useTranslation();
  const { slug = '' } = useLocalSearchParams<{ slug: string }>();
  const signedIn = useSessionStore((s) => s.status === 'signedIn');

  const link = useRepoQuery('paymentLinks', 'getPublic', { path: { slug } }, { retry: false });
  // Only a signed-in payer has accounts, and maybe this link among their own.
  const accounts = useRepoQuery('accounts', 'list', undefined, { enabled: signedIn });
  const mine = useRepoQuery(
    'paymentLinks',
    'list',
    { query: { limit: 50 } },
    { enabled: signedIn },
  );
  const source = accounts.data?.data.find((a) => a.currency === 'NGN');
  const isMine = mine.data?.data.some((l) => l.slug === slug) ?? false;

  const [typed, setTyped] = useState('');
  const [note, setNote] = useState('');
  const [confirming, setConfirming] = useState(false);
  const [payError, setPayError] = useState<string>();
  const pay = useMoneyMutation('paymentLinks', 'pay', {
    invalidates: [['paymentLinks'], ['accounts'], ['transactions'], ['transfers']],
  });

  const data = link.data;
  const fixed = data?.amount_mode === 'fixed' && data.amount ? fromApiMoney(data.amount) : null;
  const amount = fixed ?? typedNaira(typed);
  const available = source ? fromApiMoney(source.available_balance) : null;
  const short = amount && available && amount.amount > available.amount;
  const closed = data ? linkClosedReason(data.status) : null;
  const firstName = data?.payee_name.split(' ')[0];

  const close = () => (router.canGoBack() ? router.back() : router.replace('/'));

  const onApproved = async () => {
    if (!source || !amount) return false;
    setPayError(undefined);
    try {
      const transfer = await pay.mutateAsync({
        path: { slug },
        body: {
          source_account_id: source.id,
          ...(fixed ? {} : { amount: toApiMoney(amount) }),
          ...(note.trim() ? { note: note.trim() } : {}),
        },
      });
      setConfirming(false);
      router.replace({ pathname: '/send/result/[id]', params: { id: transfer.id } });
      return true;
    } catch (e) {
      setPayError(sendErrorMessage(e as Error).message);
      return false;
    }
  };

  const header = (
    <View style={[styles.row, { paddingHorizontal: spacing[4], gap: spacing[2] }]}>
      <Text variant="title" accessibilityRole="header" style={styles.flex}>
        {t('transfers.payLink.title')}
      </Text>
      <IconButton icon={X} accessibilityLabel={t('common.close')} variant="ghost" onPress={close} />
    </View>
  );

  let footer = null;
  if (data && !closed && !isMine) {
    footer = signedIn ? (
      <Button
        label={amount ? t('common.payAmount', { amount: formatMoney(amount) }) : t('common.pay')}
        icon={Send}
        disabled={!amount || !source || Boolean(short)}
        onPress={() => {
          setPayError(undefined);
          pay.resetIntent();
          setConfirming(true);
        }}
      />
    ) : (
      <View style={{ gap: spacing[2] }}>
        <Button
          label={t('transfers.payLink.logIn')}
          icon={LogIn}
          onPress={() => router.push('/login')}
        />
        <Button
          label={t('transfers.payLink.tryDemo')}
          variant="secondary"
          onPress={() => router.push('/welcome')}
        />
      </View>
    );
  }

  return (
    <ModalSheetHost>
      <Screen header={header} edges={['top', 'bottom']} footer={footer}>
        {data ? (
          <>
            <Card>
              <View style={{ gap: spacing[3], alignItems: 'center' }}>
                <Avatar name={data.payee_name} size="lg" ring />
                <Text color="textMuted" align="center">
                  {t('transfers.payLink.asking', { name: data.payee_name })}
                </Text>
                <Text variant="h2" align="center">
                  {data.title}
                </Text>
                {data.note ? (
                  <Text color="textMuted" align="center">
                    {data.note}
                  </Text>
                ) : null}
                {fixed && <MoneyText value={fixed} variant="display" align="center" />}
              </View>
            </Card>
            {data.demo && <DemoMoneyBadge />}

            {closed ? (
              <EmptyState icon={Link2} title={t('transfers.payLink.notTaking')} message={closed} />
            ) : isMine ? (
              <EmptyState
                icon={Link2}
                title={t('transfers.payLink.yours')}
                message={t('transfers.payLink.yoursMessage')}
                actionLabel={t('transfers.payLink.yourLinks')}
                onAction={() => router.replace('/send/links')}
              />
            ) : (
              signedIn && (
                <>
                  {!fixed && (
                    <AmountInput
                      currency="NGN"
                      label={t('transfers.payLink.howMuch', { name: firstName })}
                      value={typed}
                      onChangeValue={setTyped}
                      error={short ? t('transfers.payLink.tooMuch') : undefined}
                    />
                  )}
                  {fixed && short && (
                    <Text color="danger" accessibilityLiveRegion="polite">
                      {t('transfers.payLink.needFixed', { amount: formatMoney(fixed) })}
                    </Text>
                  )}
                  <TextField
                    label={t('common.note')}
                    optional
                    placeholder={t('transfers.payLink.notePlaceholder', { name: firstName })}
                    value={note}
                    onChangeText={setNote}
                    maxLength={PAY_NOTE_MAX_LENGTH}
                  />
                  {available && (
                    <Text variant="bodySmall" color="textMuted">
                      {t('transfers.payLink.from', { amount: formatMoney(available) })}
                    </Text>
                  )}
                </>
              )
            )}
          </>
        ) : link.isError ? (
          isApiError(link.error) && link.error.status === 404 ? (
            <EmptyState
              icon={Link2}
              title={t('transfers.payLink.notFound')}
              message={
                env.apiMode === 'mock'
                  ? t('transfers.payLink.notFoundDemo')
                  : t('transfers.payLink.notFoundReal')
              }
            />
          ) : (
            <ErrorState title={t('transfers.payLink.openFailed')} onRetry={() => link.refetch()} />
          )
        ) : (
          <SkeletonGroup accessibilityLabel={t('transfers.payLink.opening')}>
            <SkeletonListItem />
          </SkeletonGroup>
        )}

        <ConfirmSheet
          open={confirming}
          onClose={() => setConfirming(false)}
          subtitle={
            amount && firstName
              ? t('common.payAmountTo', { amount: formatMoney(amount), name: firstName })
              : ''
          }
          onApproved={onApproved}
          error={payError}
        />
      </Screen>
    </ModalSheetHost>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: 'row', alignItems: 'center', minHeight: 44 },
  flex: { flex: 1 },
});
