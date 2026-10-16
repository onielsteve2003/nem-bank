// Pure geometry and wording for the charts, kept out of the components so it can be unit tested.
// Values here are plotting magnitudes (pixels need floats). Labels never come from them:
// each chart formats its numbers through `formatValue`, so money text stays exact.

export type Datum = { label: string; value: number };
export type Point = { x: number; y: number };
export type Bar = { x: number; y: number; width: number; height: number };

export type ValueFormatter = (value: number, index: number) => string;

export function linePoints(data: readonly Datum[], width: number, height: number, pad: number) {
  const values = data.map((d) => d.value);
  const min = Math.min(...values);
  const span = Math.max(...values) - min;
  const innerW = width - pad * 2;
  const innerH = height - pad * 2;
  return data.map<Point>((d, i) => ({
    x: data.length === 1 ? width / 2 : pad + (i * innerW) / (data.length - 1),
    // A flat series sits in the middle rather than on the floor.
    y: span === 0 ? height / 2 : pad + (1 - (d.value - min) / span) * innerH,
  }));
}

export const linePath = (points: readonly Point[]): string =>
  points.map((p, i) => `${i === 0 ? 'M' : 'L'}${p.x.toFixed(2)} ${p.y.toFixed(2)}`).join(' ');

/** The line closed down to the bottom edge, for the gradient fill under it. */
export function areaPath(points: readonly Point[], height: number): string {
  const first = points[0];
  const last = points.at(-1);
  if (!first || !last) return '';
  return `${linePath(points)} L${last.x.toFixed(2)} ${height} L${first.x.toFixed(2)} ${height} Z`;
}

export function pathLength(points: readonly Point[]): number {
  let total = 0;
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1]!;
    const b = points[i]!;
    total += Math.hypot(b.x - a.x, b.y - a.y);
  }
  return total;
}

/** Bars grow up from a zero baseline; negative values are drawn as zero. */
export function barLayout(data: readonly Datum[], width: number, height: number, gap: number) {
  const max = Math.max(0, ...data.map((d) => d.value));
  const barW = data.length === 0 ? 0 : (width - gap * (data.length - 1)) / data.length;
  return data.map<Bar>((d, i) => {
    const h = max === 0 ? 0 : (Math.max(0, d.value) / max) * height;
    return { x: i * (barW + gap), y: height - h, width: barW, height: h };
  });
}

/** Each slice's start and size as fractions of the whole. Non-positive values get no slice. */
export function donutSlices(data: readonly Datum[]) {
  const total = data.reduce((s, d) => s + Math.max(0, d.value), 0);
  let start = 0;
  return data.map((d) => {
    const fraction = total === 0 ? 0 : Math.max(0, d.value) / total;
    const slice = { start, fraction };
    start += fraction;
    return slice;
  });
}

/**
 * Whole percentages that always add up to exactly 100 (largest remainder), so a
 * legend never reads 33% + 33% + 33%.
 */
export function wholePercents(fractions: readonly number[]): number[] {
  if (fractions.every((f) => f <= 0)) return fractions.map(() => 0);
  const raw = fractions.map((f) => Math.max(0, f) * 100);
  const floors = raw.map(Math.floor);
  let left = 100 - floors.reduce((a, b) => a + b, 0);
  const byRemainder = raw
    .map((r, i) => ({ i, rem: r - Math.floor(r) }))
    .sort((a, b) => b.rem - a.rem);
  for (const { i } of byRemainder) {
    if (left <= 0) break;
    floors[i]! += 1;
    left -= 1;
  }
  return floors;
}

/** An SVG arc path along a circle, angles in fractions of a turn starting at 12 o'clock. */
export function arcPath(cx: number, cy: number, r: number, from: number, to: number): string {
  'worklet';
  const sweep = Math.min(Math.max(to - from, 0), 0.9999);
  const a0 = (from - 0.25) * Math.PI * 2;
  const a1 = (from + sweep - 0.25) * Math.PI * 2;
  const x0 = cx + r * Math.cos(a0);
  const y0 = cy + r * Math.sin(a0);
  const x1 = cx + r * Math.cos(a1);
  const y1 = cy + r * Math.sin(a1);
  return `M${x0} ${y0} A${r} ${r} 0 ${sweep > 0.5 ? 1 : 0} 1 ${x1} ${y1}`;
}

function extremes(data: readonly Datum[]) {
  let lo = 0;
  let hi = 0;
  data.forEach((d, i) => {
    if (d.value < data[lo]!.value) lo = i;
    if (d.value > data[hi]!.value) hi = i;
  });
  return { lo, hi };
}

const NO_DATA = 'No data yet.';

export function lineSummary(title: string, data: readonly Datum[], format: ValueFormatter) {
  if (data.length === 0) return `${title}. ${NO_DATA}`;
  const { lo, hi } = extremes(data);
  const last = data.length - 1;
  const fmt = (i: number) => `${format(data[i]!.value, i)} on ${data[i]!.label}`;
  const trend =
    data[last]!.value > data[0]!.value
      ? 'up'
      : data[last]!.value < data[0]!.value
        ? 'down'
        : 'flat';
  return (
    `${title}. ${data.length} points from ${data[0]!.label} to ${data[last]!.label}, ${trend} overall. ` +
    `Low ${fmt(lo)}, high ${fmt(hi)}, latest ${format(data[last]!.value, last)}.`
  );
}

export function barSummary(title: string, data: readonly Datum[], format: ValueFormatter) {
  if (data.length === 0) return `${title}. ${NO_DATA}`;
  const { hi } = extremes(data);
  const all = data.map((d, i) => `${d.label} ${format(d.value, i)}`).join(', ');
  return `${title}. Highest ${data[hi]!.label}. ${all}.`;
}

export function donutSummary(title: string, data: readonly Datum[], format: ValueFormatter) {
  const percents = wholePercents(donutSlices(data).map((s) => s.fraction));
  if (percents.every((p) => p === 0)) return `${title}. ${NO_DATA}`;
  const parts = data.map((d, i) => `${d.label} ${percents[i]}%, ${format(d.value, i)}`);
  return `${title}. ${parts.join('; ')}.`;
}
