import { CalendarClock } from 'lucide-react-native';
import { useState } from 'react';

import { Card, ListItem, Switch, TextField } from '@/components';
import { ScheduleSheet } from '@/features/transfers/components/ScheduleSheet';
import { describeSchedule, type ScheduleChoice } from '@/features/transfers/schedule';

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
  const when = schedule ? describeSchedule(schedule) : 'Pay now';

  return (
    <>
      <Card padded={false}>
        <ListItem
          leading={CalendarClock}
          title={when}
          subtitle={schedule ? 'Tap to change or pay now instead' : 'Or schedule it, or repeat it'}
          onPress={() => setChoosing(true)}
          accessibilityLabel={`When: ${schedule ? when : 'now'}`}
          accessibilityHint="Choose a later day or a repeat"
        />
      </Card>

      {canSave && !schedule && (
        <Switch
          label="Save for next time"
          description="Saved billers fill in the provider and number for you."
          value={nickname !== null}
          onValueChange={(on) => onNicknameChange(on ? suggestedName : null)}
        />
      )}
      {canSave && !schedule && nickname !== null && (
        <TextField
          label="Save as"
          value={nickname}
          onChangeText={onNicknameChange}
          maxLength={40}
          error={nickname.trim() ? undefined : 'Give it a name'}
        />
      )}

      {choosing && (
        <ScheduleSheet
          value={schedule}
          allowEnd={false}
          nowLabel="Pay now instead"
          footnote="Each payment needs enough in your naira account. Cancel any time."
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
