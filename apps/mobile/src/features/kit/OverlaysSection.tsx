import { Landmark, Smartphone, Wallet } from 'lucide-react-native';
import { useState } from 'react';

import { BottomSheet, Button, Dialog, ListItem, Text, useToast } from '@/components';

import { KitSection } from './KitSection';

export function OverlaysSection() {
  const toast = useToast();
  const [sheetOpen, setSheetOpen] = useState(false);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [freezing, setFreezing] = useState(false);
  const [beneficiaries, setBeneficiaries] = useState(3);

  const freezeCard = () => {
    setFreezing(true);
    setTimeout(() => {
      setFreezing(false);
      setDialogOpen(false);
      toast.show({ message: 'Card frozen', tone: 'success' });
    }, 1200);
  };

  const removeBeneficiary = () => {
    setBeneficiaries((n) => n - 1);
    toast.show({
      message: 'Beneficiary removed',
      action: { label: 'Undo', onPress: () => setBeneficiaries((n) => n + 1) },
    });
  };

  const choose = (method: string) => {
    setSheetOpen(false);
    toast.show({ message: `${method} selected` });
  };

  return (
    <KitSection title="Sheets, dialogs and toasts">
      <Button
        label="Open bottom sheet"
        variant="secondary"
        fullWidth
        onPress={() => setSheetOpen(true)}
      />
      <Button label="Freeze card…" variant="danger" fullWidth onPress={() => setDialogOpen(true)} />
      <Text variant="bodySmall" color="textMuted">
        Beneficiaries: {beneficiaries}
      </Text>
      <Button
        label="Remove a beneficiary (undo toast)"
        variant="secondary"
        fullWidth
        disabled={beneficiaries === 0}
        onPress={removeBeneficiary}
      />
      <Button
        label="Show error toast"
        variant="ghost"
        onPress={() => toast.show({ message: 'Network error. Try again.', tone: 'error' })}
      />

      <BottomSheet open={sheetOpen} onClose={() => setSheetOpen(false)} title="Add money">
        <ListItem
          title="Bank transfer"
          subtitle="Free · instant"
          leading={Landmark}
          onPress={() => choose('Bank transfer')}
        />
        <ListItem
          title="Debit card"
          subtitle="1.5% fee"
          leading={Wallet}
          onPress={() => choose('Debit card')}
        />
        <ListItem
          title="USSD"
          subtitle="*737# and others"
          leading={Smartphone}
          onPress={() => choose('USSD')}
        />
      </BottomSheet>

      <Dialog
        open={dialogOpen}
        title="Freeze this card?"
        message="Payments and withdrawals stop until you unfreeze it. You can unfreeze any time."
        confirmLabel="Freeze card"
        destructive
        loading={freezing}
        onConfirm={freezeCard}
        onCancel={() => setDialogOpen(false)}
      />
    </KitSection>
  );
}
