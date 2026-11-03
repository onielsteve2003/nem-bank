import type { Schema } from '@nem/contracts';
import { CURRENCIES, formatMoney, money } from '@nem/shared';

import { MoneyText } from '@/components/MoneyText';
import { fromApiMoney } from '@/lib/money';

import { formatCount } from './format';

type Props = { volume: Schema<'AdminDashboard'>['volume'] };

/** Share of the larger amount, in whole percent, computed on bigint minor units. */
function widthPercent(value: bigint, max: bigint): number {
  return max === 0n ? 0 : Number((value * 100n) / max);
}

/**
 * Currencies never share a scale (₦1 is not $1), so each one is its own small
 * multiple: inflow against outflow within that currency only.
 */
export function VolumeByCurrency({ volume }: Props) {
  return (
    <section className="card stack" aria-labelledby="volume-title">
      <h2 id="volume-title">Volume by currency</h2>
      <div className="legend" aria-hidden="true">
        <span className="legend-item">
          <span className="swatch swatch-in" /> In
        </span>
        <span className="legend-item">
          <span className="swatch swatch-out" /> Out
        </span>
      </div>
      <div className="volume-grid">
        {volume.map((v) => {
          const inflow = fromApiMoney(v.inflow).amount;
          const outflow = fromApiMoney(v.outflow).amount;
          const max = inflow > outflow ? inflow : outflow;
          const net = money(inflow - outflow, v.currency);
          return (
            <div key={v.currency} className="volume-cell stack">
              <div className="row space-between">
                <h3>
                  {v.currency} <span className="muted">{CURRENCIES[v.currency].name}</span>
                </h3>
                <span className="muted num">{formatCount(v.count)} transfers</span>
              </div>
              {(
                [
                  ['In', 'in', v.inflow, inflow],
                  ['Out', 'out', v.outflow, outflow],
                ] as const
              ).map(([label, kind, dto, amount]) => (
                <div
                  key={kind}
                  className="flow-row"
                  tabIndex={0}
                  aria-label={`${v.currency} ${label.toLowerCase()}: ${formatMoney(fromApiMoney(dto))}`}
                >
                  <span className="flow-label">{label}</span>
                  <span className="bar-track" aria-hidden="true">
                    <span
                      className={`bar-fill fill-${kind}`}
                      style={{ width: `${widthPercent(amount, max)}%` }}
                    />
                  </span>
                  <MoneyText value={dto} trimZeroMinor className="flow-value" />
                </div>
              ))}
              <p className="muted">
                Net <span className="num">{formatMoney(net, { signPositive: true })}</span>
              </p>
            </div>
          );
        })}
      </div>
    </section>
  );
}
