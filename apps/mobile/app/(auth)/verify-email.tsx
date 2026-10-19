import { MailCheck } from 'lucide-react-native';

import { useSignupStore } from '@/features/auth/signupStore';
import { PlaceholderScreen } from '@/features/shell/PlaceholderScreen';

export default function VerifyEmailRoute() {
  const destination = useSignupStore((s) => s.pending?.otp.destination_masked);
  return (
    <PlaceholderScreen
      title="Verify your email"
      icon={MailCheck}
      message={`Enter the 6-digit code we sent to ${destination ?? 'your email'}.`}
      variant="stack"
    />
  );
}
