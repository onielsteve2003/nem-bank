import { QueryClient } from '@tanstack/react-query';
import { configure, fireEvent, render, screen, waitFor } from '@testing-library/react-native';
import type { ComponentType } from 'react';
import { Pressable, Text, TextInput, View } from 'react-native';
import { SafeAreaProvider } from 'react-native-safe-area-context';

import { ModalSheetHost, ToastProvider } from '@/components';
import { RepositoryProvider } from '@/data';
import { createMockRepositories } from '@/data/mock';
import { createMemoryStore } from '@/data/mock/persistence/types';
import { AjoListScreen } from '@/features/ajo/screens/AjoListScreen';
import { LoginScreen } from '@/features/auth/screens/LoginScreen';
import { WelcomeScreen } from '@/features/auth/screens/WelcomeScreen';
import { BillsHubScreen } from '@/features/bills/screens/BillsHubScreen';
import { CardsScreen } from '@/features/cards/screens/CardsScreen';
import { ConvertScreen } from '@/features/fx/screens/ConvertScreen';
import { HomeScreen } from '@/features/home/HomeScreen';
import { KycScreen } from '@/features/kyc/screens/KycScreen';
import { MeScreen } from '@/features/profile/screens/MeScreen';
import { GrowScreen } from '@/features/savings/screens/GrowScreen';
import { SecurityScreen } from '@/features/security/screens/SecurityScreen';
import { SettingsScreen } from '@/features/settings/screens/SettingsScreen';
import { RecipientScreen } from '@/features/transfers/screens/RecipientScreen';
import { SendHubScreen } from '@/features/transfers/screens/SendHubScreen';
import { QueryProvider } from '@/lib/query';
import { ThemeProvider } from '@/theme';

jest.mock('expo-router', () => ({
  useRouter: () => ({
    push: jest.fn(),
    replace: jest.fn(),
    back: jest.fn(),
    dismissTo: jest.fn(),
    canGoBack: () => true,
  }),
  useLocalSearchParams: () => ({ mode: 'nem' }),
  useFocusEffect: jest.fn(),
}));
jest.mock('@/lib/haptics', () => ({ haptic: jest.fn() }));
jest.mock('expo-clipboard', () => ({ setStringAsync: jest.fn(async () => true) }));

// Audit what VoiceOver can reach, sheets included.
configure({ defaultIncludeHiddenElements: false });

type Node = { type: string; props: Record<string, any>; children: (Node | string)[] };

const hidden = (p: Node['props']) =>
  p.accessibilityElementsHidden === true ||
  p['aria-hidden'] === true ||
  p.importantForAccessibility === 'no-hide-descendants';

function textOf(node: Node | string): string {
  if (typeof node === 'string') return node;
  if (hidden(node.props)) return '';
  return node.children.map(textOf).join('');
}

/** What a screen reader would announce for an element: its label, else the text inside it. */
function nameOf(node: Node): string {
  const p = node.props;
  return (p.accessibilityLabel ?? p['aria-label'] ?? textOf(node)).trim();
}

const describeNode = (node: Node) =>
  `<${node.type}${node.props.testID ? ` testID="${node.props.testID}"` : ''}> "${textOf(node).slice(0, 40)}"`;

/**
 * The screen-reader rules from code-standards §7 that can be checked without a device: every
 * pressable has a role and a name, and every text field and switch has a label. Focus order,
 * live regions and how names sound are checked with VoiceOver on the phone.
 */
function screenReaderProblems(root: Node): string[] {
  const problems: string[] = [];
  const visit = (node: Node | string) => {
    if (typeof node === 'string' || hidden(node.props)) return;
    const p = node.props;
    const pressable = typeof p.onClick === 'function' || typeof p.onResponderRelease === 'function';
    if (pressable && p.accessible !== false) {
      if (!p.accessibilityRole && !p.role) problems.push(`no role: ${describeNode(node)}`);
      if (!nameOf(node)) problems.push(`no name: ${describeNode(node)}`);
    }
    if ((node.type === 'TextInput' || node.type === 'RCTSwitch') && !nameOf(node)) {
      problems.push(`no label: ${describeNode(node)}`);
    }
    node.children.forEach(visit);
  };
  visit(root);
  return problems;
}

const loading = (node: Node | string): boolean =>
  typeof node !== 'string' &&
  (node.props.accessibilityState?.busy === true || node.children.some(loading));

const SCREENS: [name: string, Screen: ComponentType, settle: RegExp][] = [
  ['Welcome', WelcomeScreen, /./],
  ['Login', LoginScreen, /./],
  ['Home', HomeScreen, /See all/],
  ['Send hub', SendHubScreen, /To another bank/],
  ['Recipient (Nem)', RecipientScreen, /./],
  ['Convert', ConvertScreen, /./],
  ['Cards', CardsScreen, /./],
  ['Bills', BillsHubScreen, /./],
  ['Grow', GrowScreen, /./],
  ['Ajo', AjoListScreen, /./],
  ['Security', SecurityScreen, /./],
  ['KYC', KycScreen, /./],
  ['Me', MeScreen, /./],
  ['Settings', SettingsScreen, /./],
];

it.each(SCREENS)('%s: every control has a role and a spoken name', async (_, Screen, settle) => {
  const repos = createMockRepositories({
    store: createMemoryStore(),
    simulation: { latency: 'off' },
  });
  await render(
    <SafeAreaProvider
      initialMetrics={{
        frame: { x: 0, y: 0, width: 390, height: 844 },
        insets: { top: 47, left: 0, right: 0, bottom: 34 },
      }}
    >
      <RepositoryProvider repositories={repos}>
        <QueryProvider
          client={
            new QueryClient({ defaultOptions: { queries: { gcTime: Infinity, retry: false } } })
          }
        >
          <ThemeProvider initialPreference="dark">
            <ToastProvider>
              <ModalSheetHost>
                <Screen />
              </ModalSheetHost>
            </ToastProvider>
          </ThemeProvider>
        </QueryProvider>
      </RepositoryProvider>
    </SafeAreaProvider>,
  );
  await screen.findAllByText(settle);
  const carousel = screen.queryByTestId('balance-carousel');
  if (carousel) {
    await fireEvent(carousel, 'layout', { nativeEvent: { layout: { width: 390, height: 200 } } });
  }
  // Audit loaded content, not skeletons.
  const root = screen.container as unknown as Node;
  await waitFor(() => expect(loading(root)).toBe(false));
  expect(screenReaderProblems(root)).toEqual([]);
});

it('flags controls a screen reader cannot name', async () => {
  await render(
    <View>
      <Pressable onPress={() => undefined}>
        <View />
      </Pressable>
      <Pressable accessibilityRole="button" onPress={() => undefined}>
        <Text accessibilityElementsHidden>hidden from VoiceOver</Text>
      </Pressable>
      <TextInput />
      <Pressable accessibilityRole="button" accessibilityLabel="Send" onPress={() => undefined} />
    </View>,
  );
  expect(screenReaderProblems(screen.container as unknown as Node)).toEqual([
    expect.stringMatching(/^no role/),
    expect.stringMatching(/^no name/),
    expect.stringMatching(/^no name/),
    expect.stringMatching(/^no label: <TextInput>/),
  ]);
});
