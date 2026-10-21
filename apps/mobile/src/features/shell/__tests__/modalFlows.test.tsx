import { render, screen } from '@testing-library/react-native';
import { Text } from 'react-native';

import { useInModalFlow } from '@/components/ModalSheetHost';
import { ThemeProvider } from '@/theme';

import ConvertFlowLayout from '../../../../app/(app)/convert/_layout';
import KycFlowLayout from '../../../../app/(app)/kyc/_layout';
import SendFlowLayout from '../../../../app/(app)/send/_layout';

// Regression: the Convert PIN sheet opened behind its native modal because the
// flow's layout had no ModalSheetHost, so tapping Convert seemed to do nothing.

function MockProbe() {
  return <Text>{useInModalFlow() ? 'sheets in modal' : 'sheets behind modal'}</Text>;
}

jest.mock('expo-router', () => ({ Stack: () => <MockProbe /> }));

it.each([
  ['send', SendFlowLayout],
  ['convert', ConvertFlowLayout],
  ['kyc', KycFlowLayout],
])('shows bottom sheets inside the %s modal', async (_, Layout) => {
  await render(
    <ThemeProvider initialPreference="dark">
      <Layout />
    </ThemeProvider>,
  );
  expect(screen.getByText('sheets in modal')).toBeTruthy();
});
