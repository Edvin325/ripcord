#!/usr/bin/env node
// Checks the live deployment against this repository, with nothing but public RPC. No key
// and no wallet needed, so anyone can run it:
//
//   - the code on each account is exactly the wasm in contracts/wasm
//   - each contract account has no keys, so nobody can change or redeploy it
//   - the settings are the ones this repository says
//
//   node verify.mjs

import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { accessKeys, view, viewAccount } from './lib/near.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const d = JSON.parse(readFileSync(process.env.RIPCORD_DEPLOYMENT ?? join(here, 'deployment.json'), 'utf8'));

const BASE58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';

function base58(bytes) {
  let n = BigInt(`0x${Buffer.from(bytes).toString('hex')}`);
  let out = '';
  while (n > 0n) {
    out = BASE58[Number(n % 58n)] + out;
    n /= 58n;
  }
  for (const b of bytes) {
    if (b !== 0) break;
    out = `1${out}`;
  }
  return out;
}

const contracts = [
  ['Lending contract', d.ripcord, 'ripcord'],
  ['Endowment', d.endowment, 'ripcord_endowment'],
  ['Test USDC', d.usdc, 'ripcord_test_usdc'],
];

let failures = 0;
const check = (label, ok, detail = '') => {
  if (!ok) failures += 1;
  console.log(`${ok ? 'ok  ' : 'FAIL'}  ${label}${detail ? `: ${detail}` : ''}`);
};

for (const [label, id, wasm] of contracts) {
  const account = await viewAccount(d.network, id);
  const local = base58(createHash('sha256').update(readFileSync(join(here, '..', 'contracts', 'wasm', `${wasm}.wasm`))).digest());
  check(`${label} code matches contracts/wasm/${wasm}.wasm`, account.code_hash === local, id);
  const keys = await accessKeys(d.network, id);
  check(`${label} has no keys`, keys.length === 0, keys.length ? `${keys.length} key(s) can still change it` : 'nobody can change it');
}

const config = await view(d.network, d.ripcord, 'get_config');
check('Lending contract signs through the real MPC contract', config.mpc === d.mpc, config.mpc);
check('Lending contract reads the real light client', config.btc_client === d.btcClient, config.btc_client);
check('Lending contract pays its fees to this endowment', config.endowment === d.endowment, config.endowment);

const endowment = await view(d.network, d.endowment, 'get_stats');
check('Endowment can only stake with this pool', endowment.pool === d.pool, endowment.pool);
check('Endowment only pays keepers for this lending contract', endowment.ripcord === d.ripcord, endowment.ripcord);

console.log(failures ? `\n${failures} check(s) failed.` : '\nEverything matches.');
if (failures) process.exitCode = 1;
