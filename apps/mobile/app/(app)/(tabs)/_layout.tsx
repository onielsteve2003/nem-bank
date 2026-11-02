import { Tabs } from 'expo-router';
import {
  ArrowLeftRight,
  CircleUser,
  CreditCard,
  House,
  Sprout,
  type LucideIcon,
} from 'lucide-react-native';

import { useTranslation } from 'react-i18next';

import { TabBar } from '@/features/shell/TabBar';
import { useTheme } from '@/theme';

const TABS: readonly { name: 'home' | 'pay' | 'cards' | 'grow' | 'me'; icon: LucideIcon }[] = [
  { name: 'home', icon: House },
  { name: 'pay', icon: ArrowLeftRight },
  { name: 'cards', icon: CreditCard },
  { name: 'grow', icon: Sprout },
  { name: 'me', icon: CircleUser },
];

/** The five tabs (PRD §8) on the custom Volt Noir tab bar. */
export default function TabsLayout() {
  const { colors } = useTheme();
  const { t } = useTranslation();
  return (
    <Tabs
      tabBar={(props) => <TabBar {...props} />}
      screenOptions={{ headerShown: false, sceneStyle: { backgroundColor: colors.background } }}
    >
      {TABS.map(({ name, icon: Glyph }) => (
        <Tabs.Screen
          key={name}
          name={name}
          options={{
            title: t(`tabs.${name}`),
            tabBarIcon: ({ color, size }) => <Glyph color={color} size={size} />,
          }}
        />
      ))}
    </Tabs>
  );
}
