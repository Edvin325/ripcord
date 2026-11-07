#!/usr/bin/env node
// Deploys the three contracts to testnet and writes deployment.json for the tools and the
// app. Testnet only, on purpose: a mainnet deployment is a separate, deliberate step.
//
//   node deploy.mjs <ripcord account> <usdc account> <endowment account> <staking pool>

import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { accountFor, call, NEAR, view } from './lib/near.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const NETWORK = 'testnet';

const [ripcord, usdc, endowment, pool] = process.argv.slice(2);
if (!pool) {
  console.error('usage: node deploy.mjs <ripcord> <usdc> <endowment> <pool>');
  process.exit(2);
}

const WASM = {
  [ripcord]: 'ripcord',
  [usdc]: 'ripcord_test_usdc',
  [endowment]: 'ripcord_endowment',
};

const code = (name) => readFileSync(join(here, '..', 'contracts', 'wasm', `${name}.wasm`));

// Short loans on a chain whose blocks are irregular, so a full run fits in an hour or so.
const PARAMS = {
  min_collateral_sats: 5_000,
  grace_blocks: 2,
  auction_seconds: 900,
  auction_blocks: 4,
  safety_blocks: 4,
  auction_start_bps: 30_000,
  flywheel_share_bps: 1_000,
  max_btc_fee_bps: 1_000,
};

const must = (label, r) => {
  console.log(`${label}: ${r.ok ? 'ok' : 'FAILED'} ${r.hash}`);
  if (!r.ok) throw new Error(`${label}: ${r.failures.join(' | ')}`);
  return r;
};

async function initialised(id) {
  // A contract that has not been initialised panics on its view methods.
  const probe = id === usdc ? ['ft_metadata', {}] : ['get_stats', {}];
  return view(NETWORK, id, ...probe).then(
    () => true,
    () => false,
  );
}

for (const [id, name] of Object.entries(WASM)) {
  const outcome = await accountFor(NETWORK, id).deployContract(code(name));
  console.log(`deployed ${name} to ${id}: ${outcome.transaction.hash}`);
}

if (!(await initialised(usdc))) must('init usdc', await call(NETWORK, usdc, usdc, 'new'));

if (!(await initialised(endowment))) {
  must(
    'init endowment',
    await call(NETWORK, endowment, endowment, 'new', {
      ripcord,
      usdc,
      pool,
      keeper_bounty: (NEAR / 100n).toString(),
      keeper_float: (NEAR / 2n).toString(),
      sale_seconds: '3600',
      initial_rate: (NEAR / 4n / 1_000_000n).toString(),
    }),
  );
}

if (!(await initialised(ripcord))) {
  must(
    'init ripcord',
    await call(NETWORK, ripcord, ripcord, 'new', {
      config: {
        mpc: 'v1.signer-prod.testnet',
        btc_client: 'btc-client-v4.testnet',
        usdc,
        endowment,
        btc_hrp: 'tb',
        confirmations: 2,
        vault_fee: (NEAR / 10n).toString(),
        params: PARAMS,
      },
    }),
  );
}

const storage = NEAR / 100n;
must('register ripcord', await call(NETWORK, ripcord, usdc, 'storage_deposit', {}, { deposit: storage }));
must('register endowment', await call(NETWORK, endowment, usdc, 'storage_deposit', {}, { deposit: storage }));

const deployment = {
  network: NETWORK,
  btcNetwork: 'testnet3',
  ripcord,
  usdc,
  endowment,
  pool,
  mpc: 'v1.signer-prod.testnet',
  btcClient: 'btc-client-v4.testnet',
};
writeFileSync(join(here, 'deployment.json'), `${JSON.stringify(deployment, null, 2)}\n`);
writeFileSync(join(here, '..', 'app', 'src', 'deployment.json'), `${JSON.stringify({ live: deployment }, null, 2)}\n`);
console.log('wrote deployment.json for the tools and the app');
