import { ModalSheetHost } from '@/components';
import { NewCardScreen } from '@/features/cards/screens/NewCardScreen';

/** Create a virtual card (CARD-1), presented as a modal over the Cards tab. */
export default function NewCardRoute() {
  // The PIN sheet must render inside the native modal, not behind it.
  return (
    <ModalSheetHost>
      <NewCardScreen />
    </ModalSheetHost>
  );
}
