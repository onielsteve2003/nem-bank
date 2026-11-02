import { configure, fireEvent, render, screen } from '@testing-library/react-native';
import { Linking } from 'react-native';
import { SafeAreaProvider } from 'react-native-safe-area-context';

import i18n from '@/lib/i18n';
import { ThemeProvider } from '@/theme';

import app from '../../../../package.json';
import { legalDocument, type LegalSlug } from '../documents';
import licenses from '../licenses.json';
import { AboutScreen } from '../screens/AboutScreen';
import { LegalDocumentScreen } from '../screens/LegalDocumentScreen';
import { LicensesScreen } from '../screens/LicensesScreen';

const mockPush = jest.fn();
const mockParams: { doc?: string } = {};
jest.mock('expo-router', () => ({
  useRouter: () => ({ push: mockPush, replace: jest.fn(), back: jest.fn() }),
  useLocalSearchParams: () => mockParams,
}));

configure({ defaultIncludeHiddenElements: true });

const wrap = (ui: React.ReactElement) => (
  <SafeAreaProvider
    initialMetrics={{
      frame: { x: 0, y: 0, width: 390, height: 844 },
      insets: { top: 47, left: 0, right: 0, bottom: 34 },
    }}
  >
    <ThemeProvider initialPreference="dark">{ui}</ThemeProvider>
  </SafeAreaProvider>
);

beforeEach(() => jest.clearAllMocks());
afterEach(async () => {
  await i18n.changeLanguage('en');
});

describe('legal documents', () => {
  it.each<[LegalSlug, string]>([
    ['terms', 'Governing law'],
    ['privacy', 'Your rights'],
  ])('reads every section of %s in both languages', async (slug, heading) => {
    const doc = legalDocument(slug)!;
    expect(doc.sections.map((s) => s.title)).toContain(heading);
    await i18n.changeLanguage('pcm');
    for (const s of legalDocument(slug)!.sections) {
      expect(s.title).not.toBe('');
      expect(s.body).not.toBe('');
    }
  });

  it('has no document for an unknown slug', () => {
    expect(legalDocument('cookies')).toBeNull();
    expect(legalDocument('toString')).toBeNull();
  });

  it('lists every package the app ships with, so a new one cannot skip the list', () => {
    const shipped = Object.keys(app.dependencies).filter((name) => !name.startsWith('@nem/'));
    expect(licenses.map((l) => l.name)).toEqual(shipped.sort());
    for (const l of licenses) expect(l.license).not.toBe('');
  });
});

describe('AboutScreen', () => {
  it('shows the demo disclaimer and opens each document', async () => {
    await render(wrap(<AboutScreen />));
    expect(screen.getByText('This is a demo bank')).toBeTruthy();
    expect(screen.getByText(/Version \d+\.\d+\.\d+/)).toBeTruthy();

    await fireEvent.press(screen.getByText('Privacy notice'));
    expect(mockPush).toHaveBeenCalledWith({
      pathname: '/settings/legal/[doc]',
      params: { doc: 'privacy' },
    });
    await fireEvent.press(screen.getByText('Model cards'));
    expect(mockPush).toHaveBeenCalledWith('/ai');
  });
});

describe('LegalDocumentScreen', () => {
  it('shows the NDPA privacy notice with its date', async () => {
    mockParams.doc = 'privacy';
    await render(wrap(<LegalDocumentScreen />));
    expect(screen.getByText(/Nigeria Data Protection Act 2023/)).toBeTruthy();
    expect(screen.getByText('Last updated 2 Nov 2026')).toBeTruthy();
    expect(screen.getByText('7. Your rights')).toBeTruthy();
  });

  it('says so when the document does not exist', async () => {
    mockParams.doc = 'nope';
    await render(wrap(<LegalDocumentScreen />));
    expect(screen.getByText("We can't find that page")).toBeTruthy();
  });
});

describe('LicensesScreen', () => {
  it('lists each package with its licence and links to the source', async () => {
    const open = jest.spyOn(Linking, 'openURL').mockResolvedValue(undefined);
    await render(wrap(<LicensesScreen />));
    expect(screen.getByLabelText(/^zustand .+, MIT$/)).toBeTruthy();
    await fireEvent.press(screen.getByText("Nem's own code"));
    expect(open).toHaveBeenCalledWith('https://github.com/onielsteve2003/nem-bank');
  });
});
