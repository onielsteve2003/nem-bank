import { FullScreenModalProvider, ModalSheetHost } from '@/components';
import { AssistantScreen } from '@/features/assistant/screens/AssistantScreen';

/**
 * A full-screen modal (see the app layout), so the screen pads below the status
 * bar itself, and its sheets (the PIN to confirm a prepared payment, the AI
 * badge) must draw inside this window, not behind it.
 */
export default function AssistantRoute() {
  return (
    <FullScreenModalProvider>
      <ModalSheetHost>
        <AssistantScreen />
      </ModalSheetHost>
    </FullScreenModalProvider>
  );
}
