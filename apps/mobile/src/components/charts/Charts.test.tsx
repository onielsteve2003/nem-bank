import { render, screen } from '@testing-library/react-native';

import { ThemeProvider } from '@/theme';

import { BarChart } from './BarChart';
import {
  arcPath,
  barLayout,
  barSummary,
  donutSlices,
  donutSummary,
  linePoints,
  lineSummary,
  pathLength,
  wholePercents,
} from './chartMath';
import { DonutChart } from './DonutChart';
import { LineChart } from './LineChart';

const renderThemed = (ui: React.ReactElement) =>
  render(<ThemeProvider initialPreference="dark">{ui}</ThemeProvider>);

const WEEK = [
  { label: 'Mon', value: 1500 },
  { label: 'Tue', value: 1490 },
  { label: 'Wed', value: 1520 },
];
const naira = (v: number) => `₦${v}`;

describe('chart geometry', () => {
  it('spreads line points edge to edge with the max at the top', () => {
    const pts = linePoints(WEEK, 100, 50, 0);
    expect(pts.map((p) => p.x)).toEqual([0, 50, 100]);
    expect(pts[2]!.y).toBe(0);
    expect(pts[1]!.y).toBe(50);
  });

  it('centres a flat or single-point line', () => {
    expect(linePoints([{ label: 'a', value: 3 }], 100, 40, 4)).toEqual([{ x: 50, y: 20 }]);
    expect(
      pathLength(
        linePoints(
          WEEK.map((d) => ({ ...d, value: 1 })),
          100,
          40,
          0,
        ),
      ),
    ).toBe(100);
  });

  it('scales bars to the tallest and clamps negatives', () => {
    const bars = barLayout(
      [
        { label: 'a', value: 50 },
        { label: 'b', value: 100 },
        { label: 'c', value: -5 },
      ],
      100,
      80,
      5,
    );
    expect(bars.map((b) => b.height)).toEqual([40, 80, 0]);
    expect(bars[1]!.x).toBe(35);
  });

  it('slices a donut and rounds percents to exactly 100', () => {
    const thirds = donutSlices([
      { label: 'a', value: 1 },
      { label: 'b', value: 1 },
      { label: 'c', value: 1 },
    ]);
    expect(thirds[2]!.start).toBeCloseTo(2 / 3);
    expect(wholePercents(thirds.map((s) => s.fraction))).toEqual([34, 33, 33]);
    expect(wholePercents([0, 0])).toEqual([0, 0]);
  });

  it('draws arcs from 12 o’clock', () => {
    expect(arcPath(50, 50, 40, 0, 0.25)).toMatch(/^M50 10 A40 40 0 0 1 90 /);
  });
});

describe('chart summaries', () => {
  it('describes a line', () => {
    expect(lineSummary('Rate', WEEK, naira)).toBe(
      'Rate. 3 points from Mon to Wed, up overall. Low ₦1490 on Tue, high ₦1520 on Wed, latest ₦1520.',
    );
  });

  it('lists bars and names the highest', () => {
    expect(barSummary('Spend', WEEK, naira)).toBe(
      'Spend. Highest Wed. Mon ₦1500, Tue ₦1490, Wed ₦1520.',
    );
  });

  it('gives each donut slice a share', () => {
    expect(
      donutSummary(
        'By category',
        [
          { label: 'Food', value: 3 },
          { label: 'Transport', value: 1 },
        ],
        naira,
      ),
    ).toBe('By category. Food 75%, ₦3; Transport 25%, ₦1.');
  });

  it('says when there is nothing to show', () => {
    expect(lineSummary('Rate', [], naira)).toBe('Rate. No data yet.');
    expect(donutSummary('Split', [{ label: 'a', value: 0 }], naira)).toBe('Split. No data yet.');
  });
});

describe('chart components', () => {
  it('reads a line chart as one image with its summary', async () => {
    await renderThemed(<LineChart title="Rate" data={WEEK} width={300} formatValue={naira} />);
    expect(screen.getByRole('image', { name: /^Rate\. 3 points/ })).toBeOnTheScreen();
    expect(screen.getByText('Mon')).toBeOnTheScreen();
  });

  it('labels every bar', async () => {
    await renderThemed(<BarChart title="Spend" data={WEEK} width={300} />);
    expect(screen.getByRole('image', { name: /^Spend\. Highest Wed/ })).toBeOnTheScreen();
    expect(screen.getByText('Tue')).toBeOnTheScreen();
  });

  it('shows a donut legend with shares and a centre', async () => {
    await renderThemed(
      <DonutChart
        title="By category"
        data={[
          { label: 'Food', value: 3 },
          { label: 'Transport', value: 1 },
        ]}
        center={<></>}
      />,
    );
    expect(screen.getByText('75%')).toBeOnTheScreen();
    expect(screen.getByText('Transport')).toBeOnTheScreen();
  });
});
