import { CalendarClock } from 'lucide-react-native';
import { useState } from 'react';

import { Card, ListItem, Switch, TextField } from '@/components';
import { ScheduleSheet } from '@/features/transfers/components/ScheduleSheet';
import { describeSchedule, type ScheduleChoice } from '@/features/transfers/schedule';
import { useTranslation } from 'react-i18next';

interface Props {
  schedule: ScheduleChoice | null;
  onScheduleChange: (choice: ScheduleChoice | null) => void;
  /** The name to save the biller under, or null to not save it. */
  nickname: string | null;
  onNicknameChange: (nickname: string | null) => void;
  /** False when this provider and number are saved already. */
  canSave: boolean;
  suggestedName: string;
}

/** When a bill is paid (now, later or repeating) and whether to save the biller (BILL-3). */
export function BillOptions({
  schedule,
  onScheduleChange,
  nickname,
  onNicknameChange,
  canSave,
  suggestedName,
}: Props) {
  const [choosing, setChoosing] = useState(false);
  const { t } = useTranslation();
  const when = schedule ? describeSchedule(schedule) : t('bills.options.payNow');

  return (
    <>
      <Card padded={false}>
        <ListItem
          leading={CalendarClock}
          title={when}
          subtitle={schedule ? t('bills.options.changeHint') : t('bills.options.laterHint')}
          onPress={() => setChoosing(true)}
          accessibilityLabel={t('bills.options.when', {
            when: schedule ? when : t('bills.options.now'),
          })}
          accessibilityHint={t('bills.options.whenHint')}
        />
      </Card>

      {canSave && !schedule && (
        <Switch
          label={t('bills.options.save')}
          description={t('bills.options.saveHint')}
          value={nickname !== null}
          onValueChange={(on) => onNicknameChange(on ? suggestedName : null)}
        />
      )}
      {canSave && !schedule && nickname !== null && (
        <TextField
          label={t('bills.options.saveAs')}
          value={nickname}
          onChangeText={onNicknameChange}
          maxLength={40}
          error={nickname.trim() ? undefined : t('bills.options.nameIt')}
        />
      )}

      {choosing && (
        <ScheduleSheet
          value={schedule}
          allowEnd={false}
          nowLabel={t('bills.options.payNowInstead')}
          footnote={t('bills.options.footnote')}
          onClose={() => setChoosing(false)}
          onApply={(next) => {
            onScheduleChange(next);
            setChoosing(false);
          }}
        />
      )}
    </>
  );
}
