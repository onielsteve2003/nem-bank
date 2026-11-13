// Crash-recovery test: kill the API in the middle of external transfers, start it again,
// and prove every transfer still reaches a final state with the ledger intact.
//
// External transfers are a saga: hold the money, send to the partner, wait for its answer,
// then settle or auto-reverse. The sandbox bank answers after a 1 to 8 second delay, so
// killing the process a moment after the requests return leaves real transfers half way:
// held, sent or not sent, answer not yet processed. Nothing is stored in memory that a
// restart cannot rebuild (jobs live in Postgres, the partner dedupes by reference), so the
// restarted process must finish them all.
//
//   cd apps/api && go build -o bin/api.exe ./cmd/api        (bin/api on macOS and Linux)
//   task db:up
//   node loadtest/crash-recovery.mjs
//
// Needs Node 20+ and Docker (the compose database container runs psql for the checks).

import { spawn, spawnSync } from 'node:child_process';
import { createHash, generateKeyPairSync, randomUUID, sign } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const exe = join(here, '..', 'bin', process.platform === 'win32' ? 'api.exe' : 'api');
const PORT = Number(process.env.PORT || 8082);
const BASE = `http://127.0.0.1:${PORT}`;
const DB = process.env.DATABASE_URL || 'postgres://nem:nem@localhost:5433/nem?sslmode=disable';
const DB_CONTAINER = process.env.DB_CONTAINER || 'nem-bank-postgres-1';
const TRANSFERS = Number(process.env.TRANSFERS || 24);
const FINAL = new Set(['completed', 'failed', 'reversed', 'rejected', 'cancelled']);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const b64url = (b) => Buffer.from(b).toString('base64url');

function startApi() {
  const child = spawn(exe, [], {
    env: {
      ...process.env,
      PORT: String(PORT),
      DATABASE_URL: DB,
      RISK_MODE: 'shadow',
      CLIENT_IP_HEADER: 'X-Client-Ip',
      MIGRATE_ON_START: 'true',
    },
    stdio: ['ignore', 'ignore', 'ignore'],
  });
  return child;
}

async function waitReady() {
  for (let i = 0; i < 100; i++) {
    try {
      if ((await fetch(`${BASE}/readyz`)).ok) return;
    } catch {
      /* not up yet */
    }
    await sleep(300);
  }
  throw new Error('the API did not become ready');
}

function psql(sql) {
  const r = spawnSync('docker', ['exec', '-i', DB_CONTAINER, 'psql', '-U', 'nem', '-d', 'nem', '-At', '-F', '|', '-c', sql], {
    encoding: 'utf8',
  });
  if (r.status !== 0) throw new Error(`psql: ${r.stderr}`);
  return r.stdout.trim();
}

async function call(method, path, { token, body, key, user } = {}) {
  const text = body === undefined ? undefined : JSON.stringify(body);
  const headers = { 'Content-Type': 'application/json', 'X-Client-Ip': user?.ip ?? '10.88.0.1' };
  if (token) headers.Authorization = `Bearer ${token}`;
  if (key) {
    headers['Idempotency-Key'] = key;
    const timestamp = new Date().toISOString();
    const nonce = randomUUID();
    const payload = [method, path, timestamp, nonce, createHash('sha256').update(text ?? '').digest('hex')].join('\n');
    headers['X-Device-Id'] = user.deviceId;
    headers['X-Device-Signature'] = b64url(sign(null, Buffer.from(payload), user.privateKey));
    headers['X-Signature-Timestamp'] = timestamp;
    headers['X-Nonce'] = nonce;
  }
  const res = await fetch(`${BASE}${path}`, { method, headers, body: text });
  const json = await res.json().catch(() => ({}));
  return { status: res.status, json };
}

async function makeUser(i) {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const user = { ip: `10.88.1.${i + 1}`, privateKey };
  const res = await call('POST', '/v1/auth/demo', {
    user,
    body: {
      persona: 'tolu',
      device: { name: `crash-${i}`, platform: 'android', public_key: publicKey.export({ format: 'jwk' }).x },
    },
  });
  if (res.status !== 201) throw new Error(`demo sign-in: ${res.status} ${JSON.stringify(res.json)}`);
  user.token = res.json.access_token;
  user.deviceId = res.json.device.id;
  const accounts = await call('GET', '/v1/accounts', { token: user.token, user });
  const rows = Array.isArray(accounts.json) ? accounts.json : accounts.json.data;
  user.accountId = rows.find((a) => a.currency === 'NGN').id;
  return user;
}

function check(name, ok, detail = '') {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  (${detail})` : ''}`);
  if (!ok) process.exitCode = 1;
}

async function main() {
  let api = startApi();
  await waitReady();

  // One customer per transfer keeps every request inside the per-customer limits.
  console.log(`creating ${TRANSFERS} customers...`);
  const users = [];
  for (let i = 0; i < TRANSFERS; i++) users.push(await makeUser(i));

  console.log('sending external transfers...');
  const created = await Promise.all(
    users.map(async (user, i) => {
      const accountNumber = String(1000000000 + i * 7919).padStart(10, '0');
      const payee = await call('POST', '/v1/payees/resolve', {
        token: user.token,
        user,
        body: { kind: 'bank', bank_code: '058', account_number: accountNumber },
      });
      if (payee.status !== 200) return { error: `resolve ${payee.status} ${JSON.stringify(payee.json)}` };
      const res = await call('POST', '/v1/transfers', {
        token: user.token,
        user,
        key: randomUUID(),
        body: {
          source_account_id: user.accountId,
          destination: { kind: 'bank', bank_code: '058', account_number: accountNumber, account_name: payee.json.name },
          amount: { amount_minor: '500000', currency: 'NGN' },
          narration: 'crash test',
          save_beneficiary: false,
        },
      });
      return res.status === 201 || res.status === 200 ? { id: res.json.id, status: res.json.status } : { error: `${res.status} ${JSON.stringify(res.json)}` };
    }),
  );
  const accepted = created.filter((c) => c.id);
  for (const c of created.filter((c) => c.error)) console.log(`  not accepted: ${c.error}`);
  check('transfers accepted before the crash', accepted.length >= TRANSFERS * 0.9, `${accepted.length}/${TRANSFERS}`);
  const ids = accepted.map((c) => `'${c.id}'`).join(',');

  const inFlight = psql(`SELECT count(*) FROM transfers WHERE id IN (${ids}) AND status NOT IN ('completed','failed','reversed','rejected','cancelled')`);
  console.log(`killing the API with ${inFlight} transfers still in flight`);
  check('crash lands mid-saga (some transfers not final)', Number(inFlight) > 0, `${inFlight} in flight`);

  api.kill('SIGKILL'); // no graceful shutdown: the process just stops
  await new Promise((r) => api.once('exit', r));
  await sleep(1500);
  try {
    await fetch(`${BASE}/readyz`);
    check('API is down', false);
  } catch {
    check('API is down', true);
  }

  console.log('restarting...');
  api = startApi();
  await waitReady();

  // Sandbox answers arrive within 8 seconds; a transfer the partner never answers is
  // reversed at its deadline, which is longer, so allow the polling path time too.
  const deadline = Date.now() + 5 * 60_000;
  let open;
  do {
    await sleep(2000);
    open = Number(psql(`SELECT count(*) FROM transfers WHERE id IN (${ids}) AND status NOT IN ('completed','failed','reversed','rejected','cancelled')`));
  } while (open > 0 && Date.now() < deadline);
  check('every transfer reached a final state after the restart', open === 0, open ? `${open} still open` : '');

  const stats = psql(`SELECT status, count(*) FROM transfers WHERE id IN (${ids}) GROUP BY status ORDER BY status`).replaceAll('\n', ', ');
  console.log(`  outcomes: ${stats}`);

  const activeHolds = psql(`SELECT count(*) FROM account_holds h WHERE h.status = 'active' AND h.reference IN (${ids})`);
  check('no hold left active for a finished transfer', Number(activeHolds) === 0, `${activeHolds} active`);

  const verify = spawnSync('docker', ['exec', '-i', DB_CONTAINER, 'psql', '-U', 'nem', '-d', 'nem', '-At', '-v', 'ON_ERROR_STOP=1'], {
    input: readFileSync(join(here, 'verify.sql'), 'utf8'),
    encoding: 'utf8',
  });
  // verify.sql prints headings and tables; the invariant queries return no rows when healthy.
  const bad = verify.stdout.split('\n').filter((l) => l.includes('|') && !/^[0-9]+\|[0-9]+\|[0-9]+$/.test(l));
  check('ledger invariants hold (verify.sql)', verify.status === 0 && bad.length === 0, bad.join(' ; '));

  api.kill('SIGKILL');
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
