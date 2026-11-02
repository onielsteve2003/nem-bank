import { Globe, ShieldCheck, Users, Zap, type LucideIcon } from 'lucide-react-native';

export interface WelcomeSlide {
  /** Title and body come from auth.welcome.slides.<key> in the locale files. */
  key: 'speed' | 'fx' | 'ajo' | 'security';
  icon: LucideIcon;
}

/** The first thing a visitor reads: what Nem Bank does, one idea per slide (AUTH-11). */
export const WELCOME_SLIDES: readonly WelcomeSlide[] = [
  { key: 'speed', icon: Zap },
  { key: 'fx', icon: Globe },
  { key: 'ajo', icon: Users },
  { key: 'security', icon: ShieldCheck },
];
