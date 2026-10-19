import { Globe, ShieldCheck, Users, Zap, type LucideIcon } from 'lucide-react-native';

export interface WelcomeSlide {
  key: string;
  icon: LucideIcon;
  title: string;
  body: string;
}

/** The first thing a visitor reads: what Nem Bank does, one idea per slide (AUTH-11). */
export const WELCOME_SLIDES: readonly WelcomeSlide[] = [
  {
    key: 'speed',
    icon: Zap,
    title: 'Banking that moves at your speed',
    body: 'Send to any Nigerian bank or @nemtag in seconds, with the fee shown before you pay.',
  },
  {
    key: 'fx',
    icon: Globe,
    title: 'Four currencies, one app',
    body: 'Hold naira, dollars, pounds and euros. Convert at a locked rate and see the exact amount you get.',
  },
  {
    key: 'ajo',
    icon: Users,
    title: 'Save on your own or with your circle',
    body: 'Goals, locked savings and Ajo groups that pay each member out in turn.',
  },
  {
    key: 'security',
    icon: ShieldCheck,
    title: 'Security you can see',
    body: 'Face ID, a device-bound key on every payment, and a plain-English reason whenever a transfer is held.',
  },
];
