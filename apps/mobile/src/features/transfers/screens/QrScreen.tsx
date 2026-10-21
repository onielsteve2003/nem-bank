import type { Schema } from '@nem/contracts';
import { formatMoney } from '@nem/shared';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { QrCode as QrIcon, ScanLine, ShieldAlert, X } from 'lucide-react-native';
import { useEffect, useRef, useState } from 'react';
import { StyleSheet, View } from 'react-native';

import {
  Avatar,
  Button,
  Card,
  Chip,
  EmptyState,
  IconButton,
  ModalSheetHost,
  Screen,
  SkeletonGroup,
  SkeletonListItem,
  Text,
} from '@/components';
import { useOpenLink } from '@/features/shell/linking';
import { fromApiMoney } from '@/lib/money';
import { useRepoMutation, useRepoQuery } from '@/lib/query';
import { useTheme } from '@/theme';

import { typedFromKobo } from '../amount';
import { MyQr } from '../components/MyQr';
import { QrScanner } from '../components/QrScanner';
import { classifyScan, QR_INVALID } from '../qr';
import { recipientFromPayee, useSendDraft } from '../sendDraft';

type Mode = 'scan' | 'mine';
type Problem = keyof typeof QR_INVALID | 'own';

/**
 * QR payments (TRF-13). Scan: the bank checks the code's signature and expiry
 * and names the payee before any money moves; the payment itself goes through
 * the normal send review, so limits, fees and the PIN all apply. My QR: a code
 * for others to scan and pay the customer.
 */
export function QrScreen() {
  const router = useRouter();
  const openLink = useOpenLink();
  const { spacing } = useTheme();
  const params = useLocalSearchParams<{ payload?: string; mode?: string }>();
  const [mode, setMode] = useState<Mode>(params.mode === 'mine' ? 'mine' : 'scan');
  const [decoded, setDecoded] = useState<Schema<'DecodedQr'> | null>(null);
  const [problem, setProblem] = useState<Problem | null>(null);
  const setRecipient = useSendDraft((s) => s.setRecipient);
  const setAmount = useSendDraft((s) => s.setAmount);

  const decode = useRepoMutation('paymentLinks', 'decodeQr', { invalidates: [] });
  const accounts = useRepoQuery('accounts', 'list');
  const ngn = accounts.data?.data.find((a) => a.currency === 'NGN');
  const ownNumber =
    ngn?.receiving_details.scheme === 'nuban' ? ngn.receiving_details.account_number : null;

  const check = (text: string) => {
    const code = classifyScan(text);
    if (code.kind === 'pay_link') {
      openLink(code.url);
      return;
    }
    if (code.kind === 'other') {
      setProblem('other');
      return;
    }
    decode.mutate(
      { body: { payload: code.payload } },
      {
        onSuccess: (result) => {
          if (!result.valid || !result.payee) setProblem(result.invalid_reason ?? 'not_nem_qr');
          else if (result.payee.account_number === ownNumber) setProblem('own');
          else setDecoded(result);
        },
        onError: () => setProblem('other'),
      },
    );
  };

  // A QR opened from outside (camera app, a link) is checked straight away, once.
  const opened = useRef(false);
  useEffect(() => {
    if (!params.payload || opened.current || !accounts.data) return;
    opened.current = true;
    check(params.payload);
  });

  const reset = () => {
    decode.reset();
    setDecoded(null);
    setProblem(null);
  };

  const pay = (result: Schema<'DecodedQr'>) => {
    if (!result.payee) return;
    setRecipient(recipientFromPayee(result.payee));
    if (result.amount) {
      // The code says how much: straight to review, where it can't be changed by accident.
      setAmount(typedFromKobo(BigInt(result.amount.amount_minor)), '');
      router.push('/send/review');
    } else {
      router.push('/send/amount');
    }
  };

  const close = () => (router.canGoBack() ? router.back() : router.replace('/home'));
  const header = (
    <View style={[styles.row, { paddingHorizontal: spacing[4], gap: spacing[2] }]}>
      <Text variant="title" accessibilityRole="header" style={styles.flex}>
        {mode === 'scan' ? 'Scan to pay' : 'My QR'}
      </Text>
      <IconButton icon={X} accessibilityLabel="Close" variant="ghost" onPress={close} />
    </View>
  );

  const payee = decoded?.payee;
  const amount = decoded?.amount ? fromApiMoney(decoded.amount) : null;
  const busy = decode.isPending;

  let scanBody;
  if (busy) {
    scanBody = (
      <SkeletonGroup accessibilityLabel="Checking the code with Nem">
        <SkeletonListItem />
      </SkeletonGroup>
    );
  } else if (problem) {
    const copy =
      problem === 'own'
        ? { title: 'This is your own code', message: 'Show it to whoever is paying you.' }
        : QR_INVALID[problem];
    scanBody = (
      <EmptyState
        icon={problem === 'bad_signature' ? ShieldAlert : QrIcon}
        title={copy.title}
        message={copy.message}
        actionLabel="Scan again"
        onAction={reset}
      />
    );
  } else if (decoded && payee) {
    const firstName = payee.name.split(' ')[0];
    scanBody = (
      <View style={{ gap: spacing[4] }}>
        <Card>
          <View style={[styles.row, { gap: spacing[3] }]}>
            <Avatar name={payee.name} size="md" ring />
            <View style={styles.flex}>
              <Text variant="bodyStrong">{payee.name}</Text>
              <Text variant="bodySmall" color="textMuted">
                {payee.nemtag ? `@${payee.nemtag} · ` : ''}
                {payee.bank_name} · {payee.account_number}
              </Text>
            </View>
          </View>
        </Card>
        <Text color="textMuted" accessibilityLiveRegion="polite">
          {amount
            ? `Checked by Nem. ${firstName} is asking for ${formatMoney(amount)}.`
            : `Checked by Nem. You choose how much to send ${firstName}.`}
        </Text>
        <Button
          label={amount ? `Pay ${formatMoney(amount)}` : `Pay ${firstName}`}
          onPress={() => pay(decoded)}
        />
        <Button label="Scan again" variant="ghost" onPress={reset} />
      </View>
    );
  } else {
    scanBody = <QrScanner onScan={check} paused={busy || Boolean(problem || decoded)} />;
  }

  return (
    <ModalSheetHost>
      <Screen header={header} edges={['top', 'bottom']}>
        <View accessibilityRole="tablist" style={[styles.row, { gap: spacing[2] }]}>
          <Chip
            label="Scan"
            icon={ScanLine}
            selected={mode === 'scan'}
            onPress={() => setMode('scan')}
          />
          <Chip
            label="My QR"
            icon={QrIcon}
            selected={mode === 'mine'}
            onPress={() => setMode('mine')}
          />
        </View>
        {mode === 'scan' ? scanBody : <MyQr />}
      </Screen>
    </ModalSheetHost>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: 'row', alignItems: 'center', minHeight: 44 },
  flex: { flex: 1 },
});
