import type { Schema } from '@nem/contracts';
import { Clock, Pencil, Send, Trash2 } from 'lucide-react-native';
import { useState } from 'react';
import { StyleSheet, View } from 'react-native';

import {
  Avatar,
  BottomSheet,
  Button,
  Card,
  Dialog,
  Icon,
  ListItem,
  Switch,
  Text,
  TextField,
} from '@/components';
import { useRepoMutation } from '@/lib/query';
import { useTheme } from '@/theme';

import {
  beneficiaryTitle,
  cleanNickname,
  coolingOffMessage,
  coolingOffUntil,
  NICKNAME_MAX_LENGTH,
} from '../beneficiaries';
import { beneficiarySubtitle } from './BeneficiaryRow';

type Beneficiary = Schema<'Beneficiary'>;

interface Props {
  beneficiary: Beneficiary;
  onClose: () => void;
  onPay: (b: Beneficiary) => void;
}

/**
 * One saved person (TRF-8): pay, favourite, nickname or delete. Mount it only
 * while a beneficiary is chosen, so each opening starts fresh.
 */
export function BeneficiarySheet({ beneficiary, onClose, onPay }: Props) {
  const { spacing } = useTheme();
  const [b, setB] = useState(beneficiary);
  const [renaming, setRenaming] = useState(false);
  const [nickname, setNickname] = useState(beneficiary.nickname ?? '');
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [error, setError] = useState<string>();
  const update = useRepoMutation('beneficiaries', 'update');
  const remove = useRepoMutation('beneficiaries', 'remove');
  const until = coolingOffUntil(b);

  const save = (body: Schema<'UpdateBeneficiaryRequest'>, after?: () => void) => {
    setError(undefined);
    update.mutate(
      { path: { beneficiary_id: b.id }, body },
      {
        onSuccess: (next) => {
          setB(next);
          after?.();
        },
        onError: () => setError("We couldn't save that. Try again."),
      },
    );
  };

  const deleteIt = () =>
    remove.mutate(
      { path: { beneficiary_id: b.id } },
      {
        onSuccess: () => {
          setConfirmDelete(false);
          onClose();
        },
        onError: () => {
          setConfirmDelete(false);
          setError(`We couldn't delete ${b.name}. Try again.`);
        },
      },
    );

  return (
    <BottomSheet open onClose={onClose} title={beneficiaryTitle(b)}>
      <View style={{ gap: spacing[4] }}>
        <View style={[styles.row, { gap: spacing[3] }]}>
          <Avatar name={b.name} size="lg" ring={b.kind === 'nem'} />
          <View style={styles.flex}>
            <Text variant="bodyStrong">{b.name}</Text>
            <Text variant="bodySmall" color="textMuted">
              {beneficiarySubtitle(b)}
            </Text>
          </View>
        </View>

        {until && (
          <View style={[styles.row, { gap: spacing[2] }]}>
            <Icon icon={Clock} size="sm" color="warning" />
            <Text variant="bodySmall" color="warning" style={styles.flex}>
              {coolingOffMessage(until)}
            </Text>
          </View>
        )}

        <Button
          label={`Pay ${b.nickname ?? b.name.split(' ')[0]}`}
          icon={Send}
          onPress={() => onPay(b)}
        />

        <Card padded={false}>
          <Switch
            label="Favourite"
            description="Favourites come first when you send money."
            value={b.favourite}
            disabled={update.isPending}
            onValueChange={(favourite) => save({ favourite })}
          />
          {renaming ? (
            <View style={{ gap: spacing[2], padding: spacing[4] }}>
              <TextField
                label="Nickname"
                optional
                placeholder="Mummy, landlord, Chidi (work)…"
                value={nickname}
                onChangeText={setNickname}
                maxLength={NICKNAME_MAX_LENGTH}
                help="Only you see it. The bank still checks the account name."
                autoFocus
              />
              <Button
                label="Save nickname"
                size="sm"
                loading={update.isPending}
                onPress={() =>
                  save({ nickname: cleanNickname(nickname) }, () => setRenaming(false))
                }
              />
            </View>
          ) : (
            <ListItem
              leading={Pencil}
              title={b.nickname ? 'Change nickname' : 'Add a nickname'}
              subtitle={b.nickname ?? undefined}
              onPress={() => setRenaming(true)}
            />
          )}
          <ListItem
            leading={Trash2}
            title={`Delete ${b.name.split(' ')[0]}`}
            subtitle="Past payments stay in your history."
            onPress={() => setConfirmDelete(true)}
          />
        </Card>

        {error && (
          <Text variant="bodySmall" color="danger" accessibilityLiveRegion="assertive">
            {error}
          </Text>
        )}
      </View>

      <Dialog
        open={confirmDelete}
        title={`Delete ${b.name}?`}
        message="Saving them again later starts a new safety wait for large payments."
        confirmLabel="Delete"
        destructive
        loading={remove.isPending}
        onConfirm={deleteIt}
        onCancel={() => setConfirmDelete(false)}
      />
    </BottomSheet>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: 'row', alignItems: 'center' },
  flex: { flex: 1 },
});
