import { ModalSheetHost } from '@/components';
import { PhysicalCardScreen } from '@/features/cards/screens/PhysicalCardScreen';

/** Order a physical card (CARD-8), presented as a modal over the Cards tab. */
export default function PhysicalCardRoute() {
  // The Paid Feature Notice must render inside the native modal, not behind it.
  return (
    <ModalSheetHost>
      <PhysicalCardScreen />
    </ModalSheetHost>
  );
}
