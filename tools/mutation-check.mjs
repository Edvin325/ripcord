#!/usr/bin/env node
// Do the tests really guard the fixes? This undoes each fix in turn, rebuilds the real
// contract, runs the suite, and checks that the test written for that fix goes red. A
// mutation that survives means a test that proves nothing. The source is put back after
// each one, and the final rebuild must match a build of the untouched code byte for byte.
//
// Needs Rust and cargo-near, and takes a while because each mutation is a full build.
//
//   node mutation-check.mjs

import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');
const LENDING = 'contracts/ripcord/src/lib.rs';
const ENDOWMENT = 'contracts/endowment/src/lib.rs';
const TOKEN = 'contracts/test-usdc/src/lib.rs';
const CORE = 'crates/ripcord-core/src/lib.rs';

const MUTATIONS = [
  {
    fix: 'the borrower names the auction opening price',
    contract: 'ripcord',
    file: LENDING,
    find: '            auction_open_per_btc.0,\n            tip,',
    replace: '            0,\n            tip,',
    caughtBy: /borrower names where the auction opens/,
  },
  {
    fix: 'a loan leaves a window to start its auction',
    contract: 'ripcord',
    file: CORE,
    find: '        .checked_add(params.start_window_blocks)?\n',
    replace: '',
    caughtBy: /exact limit still leaves time/,
  },
  {
    fix: 'a frozen light client is refused',
    contract: 'ripcord',
    file: LENDING,
    find: '            rules::tip_is_fresh(',
    replace: '            true || rules::tip_is_fresh(',
    caughtBy: /frozen light client/,
  },
  {
    fix: 'abandoning a vault removes it before refunding',
    contract: 'ripcord',
    file: LENDING,
    find: '        self.vaults.remove(&vault_id.0);\n        emit("vault_abandoned"',
    replace: '        emit("vault_abandoned"',
    caughtBy: /arriving after the owner abandoned/,
  },
  {
    fix: 'a cancelled offer is deleted',
    contract: 'ripcord',
    file: LENDING,
    find: '        self.offers.remove(&offer_id.0);\n        self.credit(&offer.lender, offer.available);',
    replace: '        self.credit(&offer.lender, offer.available);',
    caughtBy: /closed offers and settled balances/,
  },
  {
    fix: 'an emptied offer is deleted',
    contract: 'ripcord',
    file: LENDING,
    find: '        if offer.available == 0 {\n            self.offers.remove(&offer_id);',
    replace: '        if false {\n            self.offers.remove(&offer_id);',
    caughtBy: /cannot lend more than it holds/,
  },
  {
    fix: 'a settled balance is deleted',
    contract: 'ripcord',
    file: LENDING,
    find: '        if balance == amount {\n            self.balances.remove(&account);',
    replace: '        if false {\n            self.balances.remove(&account);',
    caughtBy: /closed offers and settled balances/,
  },
  {
    fix: 'only the lending contract can initialise itself',
    contract: 'ripcord',
    file: LENDING,
    find: '    #[init]\n    #[private]\n    pub fn new(config: ConfigInput)',
    replace: '    #[init]\n    pub fn new(config: ConfigInput)',
    caughtBy: /only the contract itself can initialise/,
  },
  {
    fix: 'asking for a signature needs a full-access key',
    contract: 'ripcord',
    file: LENDING,
    find: '    pub fn request_signature(&mut self, vault_id: U64, fee_sats: U64) -> Promise {\n        near_sdk::assert_one_yocto();\n',
    replace: '    pub fn request_signature(&mut self, vault_id: U64, fee_sats: U64) -> Promise {\n',
    caughtBy: /asking for a signature needs a full-access key/,
  },
  {
    fix: 'a buyer\'s NEAR is not staked while their USDC is in flight',
    contract: 'endowment',
    file: ENDOWMENT,
    find: '            .saturating_sub(NearToken::from_yoctonear(self.pending_refunds))\n',
    replace: '',
    caughtBy: /NEAR that may yet go back/,
  },
  {
    fix: 'a second sale start cannot reset a running sale',
    contract: 'endowment',
    file: ENDOWMENT,
    find: '        self.require_sale_slot_free();\n        require!(balance.0 >= MIN_SALE_MICRO_USDC',
    replace: '        require!(balance.0 >= MIN_SALE_MICRO_USDC',
    caughtBy: /two sale starts/,
  },
  {
    fix: 'harvests stay far enough apart',
    contract: 'endowment',
    file: ENDOWMENT,
    find: '        require!(\n            env::epoch_height() >= self.last_harvest_epoch + HARVEST_EVERY_EPOCHS,\n            "harvested too recently"\n        );\n',
    replace: '',
    caughtBy: /cannot keep rewards locked/,
  },
  {
    fix: 'USDC from a failed transfer goes back on sale',
    contract: 'endowment',
    file: ENDOWMENT,
    find: '            sale.usdc_left = U128(sale.usdc_left.0 + usdc.0);\n',
    replace: '',
    caughtBy: /goes back on sale too/,
  },
  {
    fix: 'a sale needs at least a dollar',
    contract: 'endowment',
    file: ENDOWMENT,
    find: '        require!(balance.0 >= MIN_SALE_MICRO_USDC, "not enough USDC to sell");\n',
    replace: '',
    caughtBy: /at least a dollar/,
  },
  {
    fix: 'only the endowment can initialise itself',
    contract: 'endowment',
    file: ENDOWMENT,
    find: '    #[init]\n    #[private]\n    pub fn new(\n        ripcord: AccountId,',
    replace: '    #[init]\n    pub fn new(\n        ripcord: AccountId,',
    caughtBy: /only the contract itself can initialise/,
  },
  {
    fix: 'only the test token can initialise itself',
    contract: 'test-usdc',
    file: TOKEN,
    find: '    #[init]\n    #[private]\n    pub fn new()',
    replace: '    #[init]\n    pub fn new()',
    caughtBy: /only the contract itself can initialise/,
  },
];

const WASM = { ripcord: 'ripcord', endowment: 'ripcord_endowment', 'test-usdc': 'ripcord_test_usdc' };

function build(contract) {
  const r = spawnSync('cargo near build non-reproducible-wasm --no-abi', {
    cwd: join(root, 'contracts', contract),
    shell: true,
    encoding: 'utf8',
    env: { ...process.env, CARGO_BUILD_JOBS: '1', CARGO_INCREMENTAL: '0' },
    maxBuffer: 64 * 1024 * 1024,
  });
  if (r.status !== 0) throw new Error(`build of ${contract} failed:\n${(r.stdout + r.stderr).slice(-1500)}`);
}

/** The names of the tests that failed. */
function failingTests() {
  const r = spawnSync(process.execPath, ['--test', '--test-reporter=tap'], { cwd: here, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  return r.stdout
    .split('\n')
    .map((line) => line.match(/^not ok \d+ - (.+)$/)?.[1])
    .filter(Boolean);
}

const sha = (bytes) => createHash('sha256').update(bytes).digest('hex');
const built = (name) => join(root, 'target', 'near', name, `${name}.wasm`);
const results = [];

// The reference is a build of the untouched code on this machine. Compiled wasm carries local
// paths, so a build elsewhere never matches the copies committed in contracts/wasm.
const baseline = {};
for (const [contract, name] of Object.entries(WASM)) {
  build(contract);
  baseline[name] = readFileSync(built(name));
}

for (const m of MUTATIONS) {
  const path = join(root, m.file);
  const original = readFileSync(path, 'utf8');
  if (original.split(m.find).length !== 2) throw new Error(`expected exactly one match for: ${m.fix}`);
  const started = Date.now();
  try {
    writeFileSync(path, original.replace(m.find, m.replace));
    build(m.contract);
    const failed = failingTests();
    const caught = failed.some((name) => m.caughtBy.test(name));
    results.push({ fix: m.fix, caught, failed });
    console.log(`${caught ? 'caught  ' : 'SURVIVED'}  ${m.fix}  (${failed.length} red, ${Math.round((Date.now() - started) / 1000)}s)`);
  } finally {
    writeFileSync(path, original);
    // Later mutations must run against the real build of this contract, not this broken one.
    const name = WASM[m.contract];
    writeFileSync(built(name), baseline[name]);
  }
}

// Back to the real contracts, and prove it: each must match the first build exactly.
const mismatched = [];
for (const [contract, name] of Object.entries(WASM)) {
  build(contract);
  if (sha(readFileSync(built(name))) !== sha(baseline[name])) mismatched.push(name);
}

const clean = failingTests();
mkdirSync(join(root, 'evidence'), { recursive: true });
writeFileSync(
  join(root, 'evidence', 'mutation-check.json'),
  `${JSON.stringify({ mutations: results, restored_build_matches_the_start: mismatched.length === 0, failing_after_restore: clean }, null, 2)}\n`,
);

const survived = results.filter((r) => !r.caught);
console.log(`\n${results.length - survived.length} of ${results.length} fixes are guarded by a test that goes red without them.`);
console.log(`After restoring: ${clean.length} failing, wasm ${mismatched.length ? `DIFFERS for ${mismatched.join(', ')}` : 'matches the first build'}.`);
if (survived.length || clean.length || mismatched.length) process.exitCode = 1;
