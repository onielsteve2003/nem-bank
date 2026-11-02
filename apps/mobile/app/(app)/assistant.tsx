import { FullScreenModalProvider } from '@/components';
import { AssistantScreen } from '@/features/assistant/screens/AssistantScreen';

/** A full-screen modal (see the app layout), so the screen pads below the status bar itself. */
export default function AssistantRoute() {
  return (
    <FullScreenModalProvider>
      <AssistantScreen />
    </FullScreenModalProvider>
  );
}
