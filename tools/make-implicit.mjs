#!/usr/bin/env node
// Makes a NEAR implicit account key for testnet. The account appears on chain as soon as
// anyone sends it NEAR, so it needs no faucet and no name. The key goes in the standard
// .near-credentials folder, never in this repository.

import { mkdirSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { KeyPair } from 'near-api-js';

const key = KeyPair.fromRandom('ed25519');
const publicKey = key.getPublicKey();
const id = Buffer.from(publicKey.data).toString('hex');
const dir = join(homedir(), '.near-credentials', 'testnet');
mkdirSync(dir, { recursive: true });
writeFileSync(
  join(dir, `${id}.json`),
  JSON.stringify({ account_id: id, public_key: publicKey.toString(), private_key: key.toString() }),
);
console.log(id);
