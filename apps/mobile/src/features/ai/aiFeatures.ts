import {
  Bot,
  ChartLine,
  Gauge,
  MessageSquareWarning,
  ScanText,
  ShieldAlert,
  Tags,
  type LucideIcon,
} from 'lucide-react-native';

import i18n from '@/lib/i18n';
import type { AiFeature } from '@/stores';

// What every AI feature in Nem does, what it reads, and how it is built
// (AI-8). The model cards are honest about the demo: until the models in
// `ml/` ship with the backend (Phase 2), the demo bank runs the same rules a
// customer gets with the AI switched off, and no metrics are claimed.
// The words live in ai.features.<slug> and are read in the current language.

export type ModelCard = {
  approach: string;
  /** Training data, each with its source and licence. */
  data: readonly string[];
  /** What the model has to beat before it ships. */
  baseline: string;
  limitations: readonly string[];
};

export type AiFeatureInfo = {
  readonly slug: Slug;
  readonly name: string;
  readonly icon: LucideIcon;
  /** The settings switch; null for fraud scoring, which protects every payment. */
  readonly toggle: AiFeature | null;
  readonly summary: string;
  readonly uses: readonly string[];
  readonly neverUses: readonly string[];
  readonly runsOn: string;
  readonly fallback: string;
  readonly card: ModelCard;
};

type Slug =
  | 'assistant'
  | 'fraud'
  | 'scam-checker'
  | 'smart-categories'
  | 'forecast'
  | 'credit'
  | 'id-prefill';

type ListKey = `ai.features.${Slug}.${'uses' | 'neverUses' | 'card.data' | 'card.limitations'}`;

const list = (key: ListKey): readonly string[] => i18n.t(key, { returnObjects: true });

function feature(slug: Slug, icon: LucideIcon, toggle: AiFeature | null): AiFeatureInfo {
  const key = `ai.features.${slug}` as const;
  return {
    slug,
    icon,
    toggle,
    get name() {
      return i18n.t(`${key}.name`);
    },
    get summary() {
      return i18n.t(`${key}.summary`);
    },
    get uses() {
      return list(`${key}.uses`);
    },
    get neverUses() {
      return list(`${key}.neverUses`);
    },
    get runsOn() {
      return i18n.t(`${key}.runsOn`);
    },
    get fallback() {
      return i18n.t(`${key}.fallback`);
    },
    get card() {
      return {
        approach: i18n.t(`${key}.card.approach`),
        data: list(`${key}.card.data`),
        baseline: i18n.t(`${key}.card.baseline`),
        limitations: list(`${key}.card.limitations`),
      };
    },
  };
}

export const AI_FEATURES: AiFeatureInfo[] = [
  feature('assistant', Bot, 'assistant'),
  feature('fraud', ShieldAlert, null),
  feature('scam-checker', MessageSquareWarning, 'scamChecker'),
  feature('smart-categories', Tags, 'smartCategories'),
  feature('forecast', ChartLine, 'forecast'),
  feature('credit', Gauge, 'creditScoring'),
  feature('id-prefill', ScanText, 'idPrefill'),
];

export const aiFeatureBySlug = (slug: string) => AI_FEATURES.find((f) => f.slug === slug);

/** The promises that hold for every feature above. */
export const aiPrinciples = (): readonly string[] =>
  i18n.t('ai.principles', { returnObjects: true });
