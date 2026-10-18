import { Tabs } from 'expo-router';
import {
  ArrowLeftRight,
  CircleUser,
  CreditCard,
  House,
  Sprout,
  type LucideIcon,
} from 'lucide-react-native';

import { useTheme } from '@/theme';

const TABS: readonly { name: string; title: string; icon: LucideIcon }[] = [
  { name: 'home', title: 'Home', icon: House },
  { name: 'pay', title: 'Pay', icon: ArrowLeftRight },
  { name: 'cards', title: 'Cards', icon: CreditCard },
  { name: 'grow', title: 'Grow', icon: Sprout },
  { name: 'me', title: 'Me', icon: CircleUser },
];

/** The five tabs (PRD §8). The custom Volt Noir tab bar replaces the default in T4.3. */
export default function TabsLayout() {
  const { colors } = useTheme();
  return (
    <Tabs
      screenOptions={{
        headerShown: false,
        tabBarActiveTintColor: colors.primaryText,
        tabBarInactiveTintColor: colors.textMuted,
        tabBarStyle: { backgroundColor: colors.surface, borderTopColor: colors.border },
        sceneStyle: { backgroundColor: colors.background },
      }}
    >
      {TABS.map(({ name, title, icon: Glyph }) => (
        <Tabs.Screen
          key={name}
          name={name}
          options={{
            title,
            tabBarIcon: ({ color, size }) => <Glyph color={color} size={size} />,
          }}
        />
      ))}
    </Tabs>
  );
}
