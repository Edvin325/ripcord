#!/usr/bin/env node
// Removes every key from the three contract accounts. After this nobody can change, redeploy
// or delete them, including whoever deployed them, so the rules can no longer change. There
// is no undo. Run verify.mjs afterwards to confirm it from public data.
//
// Testnet only, on purpose. Locking a mainnet deployment is a human's decision.
//
//   node lock.mjs --yes

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { accessKeys, accountFor } from './lib/near.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const d = JSON.parse(readFileSync(join(here, 'deployment.json'), 'utf8'));

if (d.network !== 'testnet') {
  console.error('This script only locks testnet deployments.');
  process.exit(2);
}
if (process.argv[2] !== '--yes') {
  console.error('This cannot be undone. Run again with --yes to remove every key.');
  process.exit(2);
}

for (const id of [d.ripcord, d.endowment, d.usdc]) {
  const account = accountFor(d.network, id);
  const keys = await accessKeys(d.network, id);
  for (const { public_key: key } of keys) {
    const outcome = await account.deleteKey(key);
    console.log(`${id}: removed ${key} in ${outcome.transaction.hash}`);
  }
  console.log(`${id}: ${(await accessKeys(d.network, id)).length} keys left`);
}
