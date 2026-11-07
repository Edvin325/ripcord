#!/usr/bin/env node
// Command-line access to every Ripcord action. Nothing here is privileged: each command
// is an ordinary transaction any account could send, which is why the app and the keeper
// can both disappear and the protocol keeps working.

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { call, view, NEAR } from './lib/near.mjs';
import { buildProof, esplora, EXPLORER } from './lib/esplora.mjs';
import {
  addressToScript,
  bytesToHex,
  encodeSegwit,
  hexToBytes,
  newOwnerKey,
  p2wshScriptPubkey,
  parseVaultScript,
} from './lib/btc-core.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const walletDir = join(here, '..', 'wallets');

function deployment() {
  const file = process.env.RIPCORD_DEPLOYMENT ?? join(here, 'deployment.json');
  if (!existsSync(file)) throw new Error(`no deployment file at ${file}`);
  return JSON.parse(readFileSync(file, 'utf8'));
}

const USDC = 1_000_000n;
const usd = (micro) => `$${(Number(micro) / 1e6).toFixed(2)}`;

function report(r) {
  console.log(`  tx ${r.hash}`);
  for (const e of r.events) console.log(`  ${e.event} ${JSON.stringify(e.data[0])}`);
  if (!r.ok) {
    console.error(`  FAILED: ${r.failures.join(' | ')}`);
    process.exitCode = 1;
  }
  return r;
}

const commands = {
  async status(d, [id]) {
    if (id !== undefined) {
      console.log(JSON.stringify(await view(d.network, d.ripcord, 'get_vault', { vault_id: id }), null, 2));
      return;
    }
    const tip = await view(d.network, d.btcClient, 'get_last_block_height');
    const stats = await view(d.network, d.ripcord, 'get_stats');
    const endowment = await view(d.network, d.endowment, 'get_stats');
    console.log(`Bitcoin height (light client)  ${tip}`);
    console.log(`Vaults opened                  ${stats.vaults_opened}`);
    console.log(`Bitcoin locked                 ${stats.sats_locked} sats`);
    console.log(`Loans opened / repaid          ${stats.loans_opened} / ${stats.loans_repaid}`);
    console.log(`Lent so far                    ${usd(stats.principal_lent)}`);
    console.log(`NEAR staked by the endowment   ${Number(endowment.principal_staked) / 1e24}`);
  },

  /** Independently rebuilds a vault's address and shows what its script enforces. */
  async check(d, [id]) {
    const v = await view(d.network, d.ripcord, 'get_vault', { vault_id: id });
    const script = hexToBytes(v.witness_script);
    const parsed = parseVaultScript(script);
    const config = await view(d.network, d.ripcord, 'get_config');
    const address = encodeSegwit(config.btc_hrp, 0, p2wshScriptPubkey(script).slice(2));
    console.log(`Script matches the Ripcord template.`);
    console.log(`Contract path   ${bytesToHex(parsed.signerPub)}`);
    console.log(`Owner path      ${bytesToHex(parsed.ownerPub)} after block ${parsed.escapeHeight}`);
    console.log(`Address         ${address}  ${address === v.address ? '(matches the contract)' : 'MISMATCH'}`);
    if (address !== v.address) process.exitCode = 1;
  },

  async faucet(d, [account, dollars]) {
    report(await call(d.network, account, d.usdc, 'storage_deposit', {}, { deposit: NEAR / 100n }));
    report(await call(d.network, account, d.usdc, 'faucet', { amount: (BigInt(dollars) * USDC).toString() }));
  },

  async offer(d, [lender, dollars, pricePerBtc, aprBps, termBlocks, btcAddress]) {
    const config = await view(d.network, d.ripcord, 'get_config');
    const script = bytesToHex(addressToScript(config.btc_hrp, btcAddress));
    const msg = {
      offer: {
        micro_usdc_per_btc: (BigInt(pricePerBtc) * USDC).toString(),
        apr_bps: Number(aprBps),
        term_blocks: Number(termBlocks),
        btc_script: script,
      },
    };
    report(
      await call(
        d.network,
        lender,
        d.usdc,
        'ft_transfer_call',
        { receiver_id: d.ripcord, amount: (BigInt(dollars) * USDC).toString(), msg: JSON.stringify(msg) },
        { deposit: 1n },
      ),
    );
  },

  /** Opens a vault with a fresh owner key, saved outside the repository's tracked files. */
  async open(d, [owner, blocksUntilEscape, expectedSats]) {
    const tip = await view(d.network, d.btcClient, 'get_last_block_height');
    const key = newOwnerKey();
    const escape = tip + Number(blocksUntilEscape);
    const config = await view(d.network, d.ripcord, 'get_config');
    const deposit = BigInt(config.vault_fee) + BigInt(config.vault_storage);
    const r = report(
      await call(
        d.network,
        owner,
        d.ripcord,
        'open_vault',
        { owner_pubkey: bytesToHex(key.publicKey), escape_height: escape, expected_sats: expectedSats },
        { deposit },
      ),
    );
    const opened = r.events.find((e) => e.event === 'vault_opened');
    if (!opened) return;
    const { vault_id: id, address } = opened.data[0];
    mkdirSync(walletDir, { recursive: true });
    writeFileSync(join(walletDir, `vault-${id}-owner.key`), bytesToHex(key.secret));
    console.log(`Vault ${id} is open.\n  Send at least ${expectedSats} sats to ${address}\n  Owner key saved to wallets/vault-${id}-owner.key. Escape opens after block ${escape}.`);
  },

  async prove(d, [id, txid, caller]) {
    const api = esplora(d.btcNetwork);
    const v = await view(d.network, d.ripcord, 'get_vault', { vault_id: id });
    const coin = txid ?? (await api.utxos(v.address))[0]?.txid;
    if (!coin) throw new Error(`nothing has paid ${v.address} yet`);
    const { raw_tx, proof } = await buildProof(api, coin);
    const tx = await api.tx(coin);
    const vout = tx.vout.findIndex((o) => o.scriptpubkey === v.script_pubkey);
    if (vout < 0) throw new Error('that transaction does not pay this vault');
    report(await call(d.network, caller ?? v.owner, d.ripcord, 'prove_deposit', { vault_id: id, raw_tx, vout, proof }));
  },

  async borrow(d, [id, offerId, dollars, payoutTo]) {
    const v = await view(d.network, d.ripcord, 'get_vault', { vault_id: id });
    const args = { vault_id: id, offer_id: offerId, principal: (BigInt(dollars) * USDC).toString() };
    if (payoutTo) args.payout_to = payoutTo;
    report(await call(d.network, v.owner, d.ripcord, 'borrow', args, { deposit: 1n }));
  },

  async repay(d, [id, payer]) {
    const v = await view(d.network, d.ripcord, 'get_vault', { vault_id: id });
    if (!v.loan) throw new Error('no loan on this vault');
    report(
      await call(
        d.network,
        payer ?? v.owner,
        d.usdc,
        'ft_transfer_call',
        { receiver_id: d.ripcord, amount: v.loan.debt, msg: JSON.stringify({ repay: { vault_id: id } }) },
        { deposit: 1n },
      ),
    );
  },

  async release(d, [id, btcAddress]) {
    const v = await view(d.network, d.ripcord, 'get_vault', { vault_id: id });
    const config = await view(d.network, d.ripcord, 'get_config');
    const destination = bytesToHex(addressToScript(config.btc_hrp, btcAddress));
    report(await call(d.network, v.owner, d.ripcord, 'release', { vault_id: id, destination }, { deposit: 1n }));
  },

  /** Asks the MPC network to sign, then shows the finished Bitcoin transaction. */
  async sign(d, [id, feeSats]) {
    const v = await view(d.network, d.ripcord, 'get_vault', { vault_id: id });
    report(await call(d.network, v.beneficiary, d.ripcord, 'request_signature', { vault_id: id, fee_sats: feeSats }));
    const after = await view(d.network, d.ripcord, 'get_vault', { vault_id: id });
    console.log(after.signed_tx ? `  signed ${after.signed_txid}` : '  no signature stored');
  },

  async broadcast(d, [id]) {
    const v = await view(d.network, d.ripcord, 'get_vault', { vault_id: id });
    if (!v.signed_tx) throw new Error('nothing signed yet');
    const txid = await esplora(d.btcNetwork).broadcast(v.signed_tx);
    console.log(`  on Bitcoin: ${EXPLORER[d.btcNetwork]}/tx/${txid}`);
  },

  async auction(d, [id, keeper]) {
    report(await call(d.network, keeper, d.ripcord, 'start_auction', { vault_id: id }));
  },

  async bid(d, [id, bidder, btcAddress, maxDollars]) {
    const config = await view(d.network, d.ripcord, 'get_config');
    const price = await view(d.network, d.ripcord, 'auction_price', { vault_id: id });
    if (!price) throw new Error('no running auction');
    const amount = maxDollars ? BigInt(maxDollars) * USDC : (BigInt(price) * 101n) / 100n;
    const msg = { bid: { vault_id: id, btc_script: bytesToHex(addressToScript(config.btc_hrp, btcAddress)) } };
    report(
      await call(
        d.network,
        bidder,
        d.usdc,
        'ft_transfer_call',
        { receiver_id: d.ripcord, amount: amount.toString(), msg: JSON.stringify(msg) },
        { deposit: 1n },
      ),
    );
  },

  async claim(d, [id, caller]) {
    report(await call(d.network, caller, d.ripcord, 'claim_collateral', { vault_id: id }));
  },

  /** Writes the file `escape.mjs` needs, so the ripcord works with NEAR gone. */
  async export(d, [id, file]) {
    const v = await view(d.network, d.ripcord, 'get_vault', { vault_id: id });
    const config = await view(d.network, d.ripcord, 'get_config');
    const out = file ?? join(walletDir, `vault-${id}.json`);
    writeFileSync(
      out,
      JSON.stringify(
        {
          address: v.address,
          btc_hrp: config.btc_hrp,
          escape_height: v.escape_height,
          witness_script: v.witness_script,
          deposit: { txid: v.deposit.txid, vout: v.deposit.vout, sats: Number(v.deposit.sats) },
        },
        null,
        2,
      ),
    );
    console.log(`Saved ${out}`);
  },
};

const [name, ...rest] = process.argv.slice(2);

if (!commands[name]) {
  console.log(`usage: node ripcord.mjs <command>\n\n${Object.keys(commands).join('  ')}`);
  process.exit(name ? 1 : 0);
}

await commands[name](deployment(), rest).catch((e) => {
  console.error(e.message);
  process.exitCode = 1;
});
