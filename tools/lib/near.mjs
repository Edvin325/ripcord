// A thin NEAR client for the command-line tools. Reads use plain RPC. Signing uses keys
// from the standard .near-credentials folder, so no key ever lives in this repository.

import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { Account, KeyPairSigner, providers } from 'near-api-js';

const RPCS = {
  testnet: ['https://test.rpc.fastnear.com', 'https://rpc.testnet.near.org'],
  mainnet: ['https://free.rpc.fastnear.com', 'https://rpc.mainnet.near.org'],
};

export const TGAS = 10n ** 12n;
export const NEAR = 10n ** 24n;

async function rpc(network, method, params) {
  let lastError;
  for (const url of RPCS[network]) {
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 'ripcord', method, params }),
      });
      const body = await res.json();
      if (body.error) throw new Error(JSON.stringify(body.error));
      return body.result;
    } catch (e) {
      lastError = e;
    }
  }
  throw lastError;
}

export async function view(network, contractId, method, args = {}) {
  const result = await rpc(network, 'query', {
    request_type: 'call_function',
    finality: 'final',
    account_id: contractId,
    method_name: method,
    args_base64: Buffer.from(JSON.stringify(args)).toString('base64'),
  });
  if (result.error) throw new Error(result.error);
  const text = Buffer.from(result.result).toString('utf8');
  return text ? JSON.parse(text) : null;
}

/** A read-only call with raw arguments, for methods that take borsh. */
export async function viewBytes(network, contractId, method, bytes) {
  const result = await rpc(network, 'query', {
    request_type: 'call_function',
    finality: 'final',
    account_id: contractId,
    method_name: method,
    args_base64: Buffer.from(bytes).toString('base64'),
  });
  if (result.error) throw new Error(result.error);
  return JSON.parse(Buffer.from(result.result).toString('utf8'));
}

export async function viewAccount(network, accountId) {
  return rpc(network, 'query', { request_type: 'view_account', finality: 'final', account_id: accountId });
}

/** Keys on an account. An empty list means nobody can ever change or redeploy it. */
export async function accessKeys(network, accountId) {
  const r = await rpc(network, 'query', {
    request_type: 'view_access_key_list',
    finality: 'final',
    account_id: accountId,
  });
  return r.keys;
}

function credentialPath(network, accountId) {
  return join(homedir(), '.near-credentials', network, `${accountId}.json`);
}

export function accountFor(network, accountId) {
  const file = credentialPath(network, accountId);
  if (!existsSync(file)) throw new Error(`no key for ${accountId} in ${file}`);
  const { private_key: secret } = JSON.parse(readFileSync(file, 'utf8'));
  const provider = new providers.JsonRpcProvider({ url: RPCS[network][0] });
  return new Account(accountId, provider, KeyPairSigner.fromSecretKey(secret));
}

/** Collects every log and the first failure across a transaction's receipts. */
export function summarize(outcome) {
  const all = [outcome.transaction_outcome, ...(outcome.receipts_outcome ?? [])];
  const logs = all.flatMap((r) => r.outcome.logs ?? []);
  const failures = all
    .map((r) => r.outcome.status?.Failure)
    .filter(Boolean)
    .map((f) => JSON.stringify(f));
  return {
    hash: outcome.transaction?.hash ?? outcome.transaction_outcome?.id,
    logs,
    events: logs
      .filter((l) => l.startsWith('EVENT_JSON:'))
      .map((l) => JSON.parse(l.slice('EVENT_JSON:'.length))),
    failures,
    ok: failures.length === 0,
  };
}

/** Calls a contract and waits for every receipt, including callbacks. */
export async function call(network, signerId, contractId, methodName, args = {}, { tgas = 300n, deposit = 0n } = {}) {
  const account = accountFor(network, signerId);
  const outcome = await account.callFunctionRaw({
    contractId,
    methodName,
    args,
    gas: tgas * TGAS,
    deposit,
    waitUntil: 'FINAL',
  });
  return summarize(outcome);
}
