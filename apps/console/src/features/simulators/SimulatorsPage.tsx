import { BankPartnerSimulator } from './BankPartnerSimulator';
import { MerchantSimulator } from './MerchantSimulator';

/** Admin tools that stand in for the outside world in the sandbox (ADM-11). */
export function SimulatorsPage() {
  return (
    <>
      <div className="stack tight">
        <h1>Simulators</h1>
        <p className="muted">
          Stand-ins for the card scheme and the interbank rail, so every path can be shown without
          real money. Every action here is recorded in the audit log.
        </p>
      </div>
      <MerchantSimulator />
      <BankPartnerSimulator />
    </>
  );
}
