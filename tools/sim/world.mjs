// Everything around the contracts in a simulated run: a Bitcoin chain that really checks
// the vault's rules, an MPC signer holding a real secp256k1 key, the light client, and a
// staking pool. The contracts themselves are the real compiled wasm.

import { secp256k1 } from '@noble/curves/secp256k1';
import { sha256 } from '@noble/hashes/sha256';
import { SimChain } from './vm.mjs';
import {
  bytesToHex,
  concat,
  encodeSegwit,
  hexToBytes,
  merkleProof,
  parseVaultScript,
  reverseHex,
  sha256d,
  sighashAll,
} from '../lib/btc-core.mjs';

const CURVE_N = secp256k1.CURVE.n;

function bigFromBytes(b) {
  return BigInt(`0x${bytesToHex(b)}`);
}

const BASE58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';

function base58(bytes) {
  let n = bigFromBytes(bytes);
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

/** The signer: real ECDSA, derived per contract and path the way the network does it. */
export function mockMpc(rootSecret) {
  const root = bigFromBytes(rootSecret);
  const secretFor = (predecessor, path) => {
    const tweak = bigFromBytes(sha256(`near-mpc-recovery v0.1.0 epsilon derivation:${predecessor},${path}`));
    return (root + tweak) % CURVE_N;
  };
  const secretBytes = (n) => hexToBytes(n.toString(16).padStart(64, '0'));
  const state = { offline: false, highS: false, signatures: 0 };

  const handlers = {
    derived_public_key(args) {
      const { path, predecessor } = JSON.parse(new TextDecoder().decode(args));
      const raw = secp256k1.getPublicKey(secretBytes(secretFor(predecessor, path)), false);
      return `secp256k1:${base58(raw.slice(1))}`;
    },
    sign(args, ctx) {
      if (state.offline) throw new Error('MPC network is offline');
      const { request } = JSON.parse(new TextDecoder().decode(args));
      if (ctx.deposit !== 1n) throw new Error('sign needs exactly one yoctoNEAR');
      if (request.domain_id !== 0) throw new Error('wrong domain');
      const digest = hexToBytes(request.payload_v2.Ecdsa);
      const secret = secretBytes(secretFor(ctx.predecessor, request.path));
      let sig = secp256k1.sign(digest, secret, { lowS: !state.highS });
      state.signatures += 1;
      const compressedR = `0${2 + sig.recovery}${sig.r.toString(16).padStart(64, '0')}`;
      return {
        scheme: 'Secp256k1',
        big_r: { affine_point: compressedR },
        s: { scalar: sig.s.toString(16).padStart(64, '0') },
        recovery_id: sig.recovery,
      };
    },
  };
  return { handlers, state };
}

// ---- A small Bitcoin ----

function readTx(raw) {
  let i = 4;
  const view = new DataView(raw.buffer, raw.byteOffset, raw.byteLength);
  const version = view.getUint32(0, true);
  const varint = () => {
    const f = raw[i++];
    if (f < 0xfd) return f;
    if (f === 0xfd) {
      const v = view.getUint16(i, true);
      i += 2;
      return v;
    }
    const v = view.getUint32(i, true);
    i += 4;
    return v;
  };
  const segwit = raw[i] === 0 && raw[i + 1] === 1;
  if (segwit) i += 2;
  const bodyStart = i;
  const inputs = [];
  for (let n = varint(); n > 0; n--) {
    const txid = bytesToHex(raw.slice(i, i + 32).reverse());
    const vout = view.getUint32(i + 32, true);
    i += 36;
    const scriptSigLen = varint(); // read first: `i += varint()` would lose varint's own advance
    i += scriptSigLen;
    const sequence = view.getUint32(i, true);
    i += 4;
    inputs.push({ txid, vout, sequence, witness: [] });
  }
  const outputs = [];
  for (let n = varint(); n > 0; n--) {
    const value = view.getBigUint64(i, true);
    i += 8;
    const len = varint();
    outputs.push({ value, script: raw.slice(i, i + len) });
    i += len;
  }
  const bodyEnd = i;
  if (segwit) {
    for (const input of inputs) {
      for (let n = varint(); n > 0; n--) {
        const len = varint();
        input.witness.push(raw.slice(i, i + len));
        i += len;
      }
    }
  }
  const lockTime = view.getUint32(i, true);
  i += 4;
  if (i !== raw.length) throw new Error('trailing bytes in transaction');
  const stripped = concat(raw.slice(0, 4), raw.slice(bodyStart, bodyEnd), raw.slice(i - 4, i));
  return { version, inputs, outputs, lockTime, txid: bytesToHex(sha256d(stripped).reverse()), stripped };
}

function readDer(der) {
  if (der[0] !== 0x30 || der[1] !== der.length - 3 || der[der.length - 1] !== 1) {
    throw new Error('non-canonical signature');
  }
  return secp256k1.Signature.fromDER(der.slice(0, -1));
}

/**
 * Enforces what Bitcoin enforces for this one script: the hash commitment, the branch
 * selector, the signature over the BIP-143 digest, the low-S rule nodes apply, and
 * OP_CHECKLOCKTIMEVERIFY. It is deliberately not a general interpreter.
 */
export class SimBitcoin {
  constructor({ startHeight = 5_000_000 } = {}) {
    this.height = startHeight;
    this.blocks = new Map();
    this.byHeight = new Map();
    this.txs = new Map();
    this.utxos = new Map();
    this.mempool = [];
    this.nonce = 0;
    this.mine(1);
  }

  mine(count = 1) {
    for (let i = 0; i < count; i++) {
      this.height += 1;
      const coinbase = bytesToHex(sha256(`coinbase ${this.height}`));
      const txids = [coinbase, ...this.mempool];
      this.mempool = [];
      const { root } = merkleProof(txids, 0);
      const hash = bytesToHex(sha256(`block ${this.height} ${root}`));
      const block = { hash, height: this.height, txids, root };
      this.blocks.set(hash, block);
      this.byHeight.set(this.height, block);
      for (const id of txids.slice(1)) this.txs.get(id).block = block;
    }
  }

  /** Mints a funding transaction paying `script`, as a wallet deposit would. */
  fund(scriptPubkey, sats) {
    this.nonce += 1;
    const nonce = hexToBytes(this.nonce.toString(16).padStart(8, '0'));
    const prev = sha256(concat(nonce, Uint8Array.of(0xfa)));
    const value = new Uint8Array(8);
    new DataView(value.buffer).setBigUint64(0, BigInt(sats), true);
    const raw = concat(
      Uint8Array.of(2, 0, 0, 0, 1),
      prev,
      Uint8Array.of(0, 0, 0, 0, 0, 0xff, 0xff, 0xff, 0xff, 1),
      value,
      Uint8Array.of(scriptPubkey.length),
      scriptPubkey,
      Uint8Array.of(0, 0, 0, 0),
    );
    const tx = readTx(raw);
    this.accept(tx, raw);
    return { txid: tx.txid, vout: 0, rawHex: bytesToHex(raw) };
  }

  accept(tx, raw) {
    this.txs.set(tx.txid, { ...tx, raw, block: null });
    this.mempool.push(tx.txid);
    tx.outputs.forEach((o, vout) => this.utxos.set(`${tx.txid}:${vout}`, o));
  }

  /** Validates and queues a spend. Throws the reason if Bitcoin would refuse it. */
  submit(rawHex) {
    const raw = hexToBytes(rawHex);
    const tx = readTx(raw);
    if (tx.inputs.length !== 1 || tx.outputs.length !== 1) throw new Error('vault spends have one input and one output');
    const input = tx.inputs[0];
    const key = `${input.txid}:${input.vout}`;
    const utxo = this.utxos.get(key);
    if (!utxo) throw new Error('missing or already spent input');

    const [sig, selector, script] = input.witness;
    if (!script) throw new Error('witness must have three items');
    const program = utxo.script.slice(2);
    if (bytesToHex(sha256(script)) !== bytesToHex(program)) throw new Error('witness script does not match the coin');
    const { signerPub, ownerPub, escapeHeight } = parseVaultScript(script);

    let pub;
    if (selector.length === 1 && selector[0] === 1) {
      pub = signerPub;
    } else if (selector.length === 0) {
      pub = ownerPub;
      if (tx.lockTime < escapeHeight) throw new Error('OP_CHECKLOCKTIMEVERIFY failed: lock time is below the script height');
      if (input.sequence === 0xffffffff) throw new Error('OP_CHECKLOCKTIMEVERIFY failed: input is final');
      if (tx.lockTime >= this.height + 1) throw new Error('non-final transaction: its lock time has not passed');
    } else {
      throw new Error('MINIMALIF: selector must be 1 or empty');
    }

    const parsed = readDer(sig);
    if (parsed.hasHighS()) throw new Error('high-S signature is non-standard');
    const spend = {
      version: tx.version,
      prevTxid: hexToBytes(reverseHex(input.txid)),
      vout: input.vout,
      sequence: input.sequence,
      outValue: tx.outputs[0].value,
      destination: tx.outputs[0].script,
      lockTime: tx.lockTime,
    };
    const digest = sighashAll(spend, script, utxo.value);
    if (!secp256k1.verify(parsed, digest, pub)) throw new Error('signature does not verify');
    if (tx.outputs[0].value >= utxo.value) throw new Error('no fee');

    this.utxos.delete(key);
    this.accept(tx, raw);
    return tx.txid;
  }

  /** Coins currently paying `script`. */
  balanceOf(scriptPubkey) {
    const want = bytesToHex(scriptPubkey);
    let total = 0n;
    for (const o of this.utxos.values()) if (bytesToHex(o.script) === want) total += o.value;
    return total;
  }

  /** The proof a relayer would build, in the shape `prove_deposit` takes. */
  proofFor(txid) {
    const tx = this.txs.get(txid);
    if (!tx?.block) throw new Error('transaction is not in a block');
    const index = tx.block.txids.indexOf(txid);
    const { proof } = merkleProof(tx.block.txids, index);
    const coinbase = merkleProof(tx.block.txids, 0);
    return {
      raw_tx: bytesToHex(tx.stripped),
      proof: {
        block_hash: tx.block.hash,
        tx_index: String(index),
        merkle_proof: proof,
        coinbase_txid: tx.block.txids[0],
        coinbase_merkle_proof: coinbase.proof,
      },
    };
  }
}

/** The light client, reading the simulated chain and checking proofs by walking them. */
export function mockLightClient(bitcoin) {
  const state = { paused: false, staleBy: 0 };
  const walk = (leaf, index, siblings) => {
    let hash = leaf;
    let at = Number(index);
    for (const s of siblings) {
      hash = sha256d(at % 2 ? concat(s, hash) : concat(hash, s));
      at >>= 1;
    }
    return bytesToHex(hash);
  };

  return {
    state,
    handlers: {
      get_last_block_height: () => bitcoin.height - state.staleBy,
      verify_transaction_inclusion_v2(args) {
        if (state.paused) throw new Error('light client is paused');
        const view = new DataView(args.buffer, args.byteOffset, args.byteLength);
        let i = 0;
        const h256 = () => {
          const out = args.slice(i, i + 32);
          i += 32;
          return out;
        };
        const u64 = () => {
          const v = view.getBigUint64(i, true);
          i += 8;
          return v;
        };
        const list = () => {
          const n = view.getUint32(i, true);
          i += 4;
          return Array.from({ length: n }, h256);
        };
        const txId = h256();
        const blockHash = h256();
        const index = u64();
        const proof = list();
        const coinbase = h256();
        const coinbaseProof = list();
        const confirmations = u64();
        if (i !== args.length) throw new Error('Unexpected length of input');

        const block = bitcoin.blocks.get(bytesToHex(blockHash.slice().reverse()));
        if (!block) throw new Error('block does not belong to the current main chain');
        if (proof.length !== coinbaseProof.length) throw new Error('Coinbase merkle proof and transaction merkle proof should have the same length');
        if (BigInt(bitcoin.height - block.height + 1) < confirmations) throw new Error('Not enough blocks confirmed');
        const root = reverseHex(block.root);
        if (walk(coinbase, 0n, coinbaseProof) !== root) throw new Error('Incorrect coinbase merkle proof');
        return walk(txId, index, proof) === root;
      },
    },
  };
}

export function mockPool() {
  const state = { staked: new Map(), unstaked: new Map() };
  return {
    state,
    handlers: {
      deposit_and_stake(_args, ctx) {
        state.staked.set(ctx.predecessor, (state.staked.get(ctx.predecessor) ?? 0n) + ctx.deposit);
        return null;
      },
      get_account_staked_balance(args) {
        const { account_id } = JSON.parse(new TextDecoder().decode(args));
        return (state.staked.get(account_id) ?? 0n).toString();
      },
      unstake(args, ctx) {
        const amount = BigInt(JSON.parse(new TextDecoder().decode(args)).amount);
        state.staked.set(ctx.predecessor, state.staked.get(ctx.predecessor) - amount);
        state.unstaked.set(ctx.predecessor, (state.unstaked.get(ctx.predecessor) ?? 0n) + amount);
        return null;
      },
    },
  };
}

export const NEAR = 10n ** 24n;
export const USDC = 1_000_000n;

/** yoctoNEAR per micro-USDC: 0.25 NEAR per dollar, for a NEAR price near four dollars. */
export const INITIAL_RATE = (NEAR / 4n) / USDC;

export const ACCOUNTS = {
  ripcord: 'ripcord.test',
  usdc: 'usdc.test',
  endowment: 'endowment.test',
  mpc: 'mpc.test',
  client: 'btc-client.test',
  pool: 'pool.test',
  borrower: 'borrower.test',
  lender: 'lender.test',
  bidder: 'bidder.test',
  keeper: 'keeper.test',
};

export const DEFAULT_PARAMS = {
  min_collateral_sats: 10_000,
  grace_blocks: 6,
  auction_seconds: 3_600,
  auction_blocks: 12,
  safety_blocks: 12,
  auction_start_bps: 30_000,
  flywheel_share_bps: 1_000,
  max_btc_fee_bps: 500,
};

/**
 * A fresh world with the three real contracts deployed and test money handed out.
 * `wasm` maps contract names to their compiled bytes, so this runs in Node and browsers.
 */
export function createWorld({ wasm, params = {}, vaultFee = NEAR / 10n, keeperBounty = NEAR / 100n, keeperFloat = NEAR / 2n }) {
  const near = new SimChain();
  const bitcoin = new SimBitcoin();
  const mpc = mockMpc(new Uint8Array(32).fill(0x5a));
  const client = mockLightClient(bitcoin);
  const pool = mockPool();
  const a = ACCOUNTS;

  near.mock(a.mpc, mpc.handlers);
  near.mock(a.client, client.handlers);
  near.mock(a.pool, pool.handlers);
  for (const id of [a.borrower, a.lender, a.bidder, a.keeper]) near.addAccount(id);

  // The endowment starts with just its storage, reserve and keeper float, so anything it
  // stakes in a run really did come from that run's fees and interest.
  near.addAccount(a.endowment, (NEAR * 5n) / 2n);

  near.deploy(a.usdc, wasm.usdc);
  near.deploy(a.ripcord, wasm.ripcord);
  near.deploy(a.endowment, wasm.endowment);

  const must = (r, what) => {
    if (!r.ok) throw new Error(`${what}: ${r.error}`);
    return r;
  };

  must(near.call(a.usdc, a.usdc, 'new'), 'usdc init');
  must(
    near.call(a.ripcord, a.ripcord, 'new', {
      config: {
        mpc: a.mpc,
        btc_client: a.client,
        usdc: a.usdc,
        endowment: a.endowment,
        btc_hrp: 'tb',
        confirmations: 2,
        vault_fee: vaultFee.toString(),
        params: { ...DEFAULT_PARAMS, ...params },
      },
    }),
    'ripcord init',
  );
  must(
    near.call(a.endowment, a.endowment, 'new', {
      ripcord: a.ripcord,
      usdc: a.usdc,
      pool: a.pool,
      keeper_bounty: keeperBounty.toString(),
      keeper_float: keeperFloat.toString(),
      sale_seconds: '3600',
      initial_rate: INITIAL_RATE.toString(),
    }),
    'endowment init',
  );

  const storageDeposit = NEAR / 100n;
  must(near.call(a.ripcord, a.usdc, 'storage_deposit', {}, { deposit: storageDeposit }), 'register ripcord');
  must(near.call(a.endowment, a.usdc, 'storage_deposit', {}, { deposit: storageDeposit }), 'register endowment');
  for (const id of [a.borrower, a.lender, a.bidder]) {
    must(near.call(id, a.usdc, 'storage_deposit', {}, { deposit: storageDeposit }), `register ${id}`);
    must(near.call(id, a.usdc, 'faucet', { amount: (10_000n * USDC).toString() }), `fund ${id}`);
  }

  return { near, bitcoin, mpc, client, pool, a, must };
}

/** Script that pays a test key, used as a Bitcoin destination. */
export const p2wpkhOf = (byte) => concat(Uint8Array.of(0x00, 20), new Uint8Array(20).fill(byte));

export const addressOf = (scriptPubkey) => encodeSegwit('tb', 0, scriptPubkey.slice(2));
