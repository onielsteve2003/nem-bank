import type { ColorTokens } from '@nem/shared';
import type { Schema } from '@nem/contracts';
import {
  CalendarDays,
  ChartPie,
  Lightbulb,
  PartyPopper,
  PiggyBank,
  Scale,
  Sparkles,
  Wallet,
  type LucideIcon,
} from 'lucide-react-native';

import { CATEGORIES } from '@/features/transactions/categories';

import { monthYearLabel } from './insights';

type Slide = Schema<'StorySlide'>;
type Story = Schema<'MoneyStory'>;

/** Each kind of slide gets its own icon and accent, so the story has a rhythm. */
export const SLIDE_LOOK: Record<Slide['kind'], { icon: LucideIcon; accent: keyof ColorTokens }> = {
  intro: { icon: Sparkles, accent: 'primary' },
  total_spent: { icon: Wallet, accent: 'info' },
  top_category: { icon: ChartPie, accent: 'warning' },
  biggest_day: { icon: CalendarDays, accent: 'danger' },
  saved: { icon: PiggyBank, accent: 'success' },
  compared: { icon: Scale, accent: 'info' },
  tip: { icon: Lightbulb, accent: 'warning' },
  outro: { icon: PartyPopper, accent: 'primary' },
};

/** The icon for a slide: its category's own icon when it is about one. */
export const slideIcon = (slide: Slide): LucideIcon =>
  slide.category
    ? (CATEGORIES[slide.category] ?? CATEGORIES.other).icon
    : SLIDE_LOOK[slide.kind].icon;

export type ShareSummary = { month: string; lines: string[] };

/**
 * What the story says when shared: no amounts and no balances, only the shape
 * of the month (PRD INS-5: privacy-safe). The share card and the web text
 * share both use it.
 */
export function shareSummary(story: Story): ShareSummary {
  const top = story.slides.find((s) => s.kind === 'top_category');
  const compared = story.slides.find((s) => s.kind === 'compared');
  const saved = story.slides.find((s) => s.kind === 'saved');
  const spent = story.slides.find((s) => s.kind === 'total_spent')?.amount;
  const lines: string[] = [];
  if (top?.category) {
    const label = (CATEGORIES[top.category] ?? CATEGORIES.other).label;
    const whole = spent ? BigInt(spent.amount_minor) : 0n;
    // A share of the month says the shape without the amount; rounded down.
    const pct = whole > 0n && top.amount ? (BigInt(top.amount.amount_minor) * 100n) / whole : null;
    lines.push(pct !== null ? `Most went on ${label} (${pct}%)` : `Most went on ${label}`);
  }
  if (compared) lines.push(compared.title);
  if (saved?.amount && BigInt(saved.amount.amount_minor) > 0n) lines.push('Put money aside');
  return { month: monthYearLabel(story.month), lines };
}

export const shareText = (summary: ShareSummary) =>
  [`My ${summary.month} with Nem`, ...summary.lines.map((l) => `• ${l}`)].join('\n');
