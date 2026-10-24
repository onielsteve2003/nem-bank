import type { Repositories } from '../../repositories';
import { processCardSettlements } from '../cardAuthorizations';
import type { MockBank } from '../runtime';
import { accountsRepo, processStatements, statementsRepo, transactionsRepo } from './accounts';
import { ajoRepo, processAjo } from './ajo';
import { assistantRepo } from './assistant';
import { authRepo, devicesRepo, usersRepo } from './auth';
import { billsRepo, processBillSchedules } from './bills';
import { cardsRepo } from './cards';
import {
  disputesRepo,
  notificationsRepo,
  processDisputes,
  processSupport,
  supportRepo,
} from './care';
import { creditRepo, processLoans } from './credit';
import { familyRepo, processFamily } from './family';
import { fxRepo, processFxAlerts } from './fx';
import { insightsRepo } from './insights';
import { kycRepo, processKyc } from './kyc';
import { demoRepo, privacyRepo, realtimeRepo } from './misc';
import { moneyRequestsRepo, paymentLinksRepo, processRequests } from './requests';
import { processLocks, savingsRepo } from './savings';
import { processLimitIncreases, securityRepo } from './security';
import {
  beneficiariesRepo,
  payeesRepo,
  processDueTransfers,
  processSchedules,
  transfersRepo,
} from './transfers';

/** Work that comes due with time, in the order a real bank's jobs would run it. */
const TASKS = [
  processDueTransfers,
  processCardSettlements,
  processSchedules,
  processBillSchedules,
  processRequests,
  processStatements,
  processFxAlerts,
  processLocks,
  processAjo,
  processLoans,
  processKyc,
  processDisputes,
  processSupport,
  processLimitIncreases,
  processFamily,
];

/** Every customer repository, implemented on one running mock bank. */
export function buildMockDomains(bank: MockBank): Repositories {
  for (const task of TASKS) bank.onTick(task);
  const repos: Repositories = {
    auth: authRepo(bank),
    users: usersRepo(bank),
    devices: devicesRepo(bank),
    accounts: accountsRepo(bank),
    transactions: transactionsRepo(bank),
    statements: statementsRepo(bank),
    payees: payeesRepo(bank),
    transfers: transfersRepo(bank),
    beneficiaries: beneficiariesRepo(bank),
    moneyRequests: moneyRequestsRepo(bank),
    paymentLinks: paymentLinksRepo(bank),
    fx: fxRepo(bank),
    cards: cardsRepo(bank),
    bills: billsRepo(bank),
    savings: savingsRepo(bank),
    ajo: ajoRepo(bank),
    credit: creditRepo(bank),
    insights: insightsRepo(bank),
    security: securityRepo(bank),
    kyc: kycRepo(bank),
    disputes: disputesRepo(bank),
    support: supportRepo(bank),
    notifications: notificationsRepo(bank),
    family: familyRepo(bank),
    assistant: assistantRepo(bank, () => repos),
    privacy: privacyRepo(bank),
    realtime: realtimeRepo(bank),
    demo: demoRepo(bank),
  };
  return repos;
}
