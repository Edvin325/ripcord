// A small NEAR runtime for tests. It runs the real compiled contracts in Node's
// WebAssembly engine, with the host functions they import, receipts, promise chains,
// callbacks and per-receipt rollback. Accounts can also be JavaScript mocks, which stand
// in for the MPC signer, the light client and a staking pool.
//
// It exists because near-sandbox does not run on Windows, and because this makes the whole
// loan lifecycle runnable anywhere in seconds, with no tokens and no network.
//
// It does not meter gas. Gas and the real services are covered on testnet.

import { secp256k1 } from '@noble/curves/secp256k1';
import { sha256 } from '@noble/hashes/sha256';

const U64_MAX = 0xffffffffffffffffn;
const utf8 = new TextDecoder();
const encode = (s) => new TextEncoder().encode(s);
// Storage keys are short, so a one-byte-per-char string is a safe map key in Node and browsers.
const keyOf = (bytes) => String.fromCharCode(...bytes);

class Panic extends Error {}

function u128ToBytes(v) {
  const out = new Uint8Array(16);
  let n = v;
  for (let i = 0; i < 16; i++) {
    out[i] = Number(n & 0xffn);
    n >>= 8n;
  }
  return out;
}

function bytesToU128(b) {
  let n = 0n;
  for (let i = 15; i >= 0; i--) n = (n << 8n) | BigInt(b[i]);
  return n;
}

export class SimChain {
  constructor({ startTimeMs = 1_800_000_000_000 } = {}) {
    this.timeMs = startTimeMs;
    this.accounts = new Map();
    this.receipts = new Map();
    this.nextReceipt = 1;
    this.queue = [];
    this.trace = [];
  }

  addAccount(id, balance = 100n * 10n ** 24n) {
    if (!this.accounts.has(id)) {
      this.accounts.set(id, { id, balance, storage: new Map(), module: null, mock: null, codeLen: 0 });
    }
    return this.accounts.get(id);
  }

  deploy(id, wasm) {
    const a = this.addAccount(id);
    a.module = new WebAssembly.Module(wasm);
    a.codeLen = wasm.length;
  }

  /** Registers a JavaScript contract. Handlers get `(args, ctx)` and return JSON or bytes. */
  mock(id, handlers) {
    this.addAccount(id).mock = handlers;
  }

  balance(id) {
    return this.accounts.get(id)?.balance ?? 0n;
  }

  advance(seconds) {
    this.timeMs += seconds * 1000;
  }

  /** Sends a transaction and runs every resulting receipt to the end. */
  call(signer, contract, method, args = {}, { deposit = 0n } = {}) {
    const payer = this.accounts.get(signer);
    if (!payer) throw new Error(`no account ${signer}`);
    if (payer.balance < deposit) throw new Error(`${signer} cannot afford the deposit`);
    payer.balance -= deposit;
    const id = this.enqueue({
      predecessor: signer,
      receiver: contract,
      actions: [{ kind: 'call', method, args: encodeArgs(args), deposit }],
      after: [],
    });
    this.drain();
    return this.outcomeOf(id);
  }

  /** Read-only call. Runs against a copy of the state, which is thrown away. */
  view(contract, method, args = {}) {
    const account = this.accounts.get(contract);
    if (account.mock) {
      return decodeValue(this.runMock(account, method, encodeArgs(args), { predecessor: contract, deposit: 0n }).value);
    }
    const live = account.storage;
    account.storage = new Map(live);
    try {
      const r = this.runWasm(account, method, encodeArgs(args), {
        predecessor: contract,
        deposit: 0n,
        results: [],
      });
      return decodeValue(r.value);
    } finally {
      account.storage = live;
    }
  }

  enqueue({ predecessor, receiver, actions, after }) {
    const id = this.nextReceipt++;
    this.receipts.set(id, { id, predecessor, receiver, actions, after, state: 'waiting', value: null, forward: null, logs: [], error: null });
    this.queue.push(id);
    return id;
  }

  /** Final state of a receipt, following `promise_return`. */
  settled(id) {
    let r = this.receipts.get(id);
    while (r.state === 'forwarded') r = this.receipts.get(r.forward);
    return r;
  }

  drain() {
    let guard = 0;
    while (this.queue.length) {
      if (++guard > 10_000) throw new Error('receipts never settled');
      const at = this.queue.findIndex((id) =>
        this.receipts.get(id).after.every((dep) => ['ok', 'failed'].includes(this.settled(dep).state)),
      );
      if (at < 0) throw new Error('receipts are deadlocked');
      const [id] = this.queue.splice(at, 1);
      this.execute(this.receipts.get(id));
    }
  }

  execute(receipt) {
    const account = this.accounts.get(receipt.receiver);
    const results = receipt.after.map((dep) => {
      const r = this.settled(dep);
      return { ok: r.state === 'ok', value: r.value ?? new Uint8Array(0) };
    });

    if (!account) {
      this.fail(receipt, `account ${receipt.receiver} does not exist`, null);
      return;
    }

    const snapshot = new Map(account.storage);
    const balanceBefore = account.balance;
    try {
      for (const action of receipt.actions) {
        if (action.kind === 'transfer') {
          account.balance += action.amount;
          continue;
        }
        account.balance += action.deposit;
        const ctx = { predecessor: receipt.predecessor, deposit: action.deposit, results };
        const run = account.mock
          ? this.runMock(account, action.method, action.args, ctx)
          : this.runWasm(account, action.method, action.args, ctx);
        receipt.logs.push(...run.logs);
        this.commitPromises(receipt, run);
        receipt.value = run.value;
      }
      if (receipt.state !== 'forwarded') receipt.state = 'ok';
    } catch (e) {
      if (!(e instanceof Panic)) throw e;
      account.storage = snapshot;
      account.balance = balanceBefore;
      this.fail(receipt, e.message, receipt.actions);
    }
  }

  /** A failed receipt refunds attached NEAR to whoever sent it. */
  fail(receipt, message, actions) {
    receipt.state = 'failed';
    receipt.error = message;
    let refund = 0n;
    for (const a of actions ?? receipt.actions) refund += a.deposit ?? a.amount ?? 0n;
    const payer = this.accounts.get(receipt.predecessor);
    if (payer) payer.balance += refund;
  }

  runMock(account, method, args, ctx) {
    const handler = account.mock[method];
    if (!handler) throw new Panic(`${account.id} has no method ${method}`);
    let value;
    try {
      value = handler(args, ctx);
    } catch (e) {
      throw new Panic(e.message);
    }
    return { value: encodeReturn(value), logs: [], promises: [], returned: null, owner: account };
  }

  commitPromises(receipt, run) {
    const ids = new Map();
    for (const p of run.promises) {
      if (p.and) continue;
      const after = (p.after ?? []).flatMap((dep) => expand(run.promises, dep)).map((d) => ids.get(d));
      let cost = 0n;
      for (const a of p.actions) cost += a.deposit ?? a.amount ?? 0n;
      const owner = this.accounts.get(receipt.receiver);
      owner.balance -= cost;
      ids.set(p.index, this.enqueue({ predecessor: receipt.receiver, receiver: p.receiver, actions: p.actions, after }));
    }
    if (run.returned !== null) {
      receipt.state = 'forwarded';
      receipt.forward = ids.get(run.returned);
    }
  }

  runWasm(account, method, args, ctx) {
    const self = this;
    const registers = new Map();
    const promises = [];
    const logs = [];
    let value = new Uint8Array(0);
    let returned = null;
    let memory;

    const mem = () => new Uint8Array(memory.buffer);
    const read = (ptr, len) => mem().slice(Number(ptr), Number(ptr) + Number(len));
    const readString = (ptr, len) => {
      if (len === U64_MAX) {
        const m = mem();
        let end = Number(ptr);
        while (m[end] !== 0) end++;
        return utf8.decode(m.slice(Number(ptr), end));
      }
      return utf8.decode(read(ptr, len));
    };
    const setRegister = (id, bytes) => registers.set(id, bytes);
    const writeU128 = (ptr, v) => mem().set(u128ToBytes(v), Number(ptr));
    const unused = (name) => () => {
      throw new Panic(`the simulator does not implement ${name}`);
    };

    const env = {
      read_register(id, ptr) {
        mem().set(registers.get(id), Number(ptr));
      },
      register_len: (id) => (registers.has(id) ? BigInt(registers.get(id).length) : U64_MAX),
      current_account_id: (r) => setRegister(r, encode(account.id)),
      predecessor_account_id: (r) => setRegister(r, encode(ctx.predecessor)),
      input: (r) => setRegister(r, args),
      block_timestamp: () => BigInt(self.timeMs) * 1_000_000n,
      account_balance: (ptr) => writeU128(ptr, account.balance),
      attached_deposit: (ptr) => writeU128(ptr, ctx.deposit),
      storage_usage() {
        let bytes = BigInt(account.codeLen);
        for (const [k, v] of account.storage) bytes += BigInt(k.length + v.length + 40);
        return bytes;
      },
      storage_write(kl, kp, vl, vp, r) {
        const key = keyOf(read(kp, kl));
        const old = account.storage.get(key);
        account.storage.set(key, read(vp, vl));
        if (old) {
          setRegister(r, old);
          return 1n;
        }
        return 0n;
      },
      storage_read(kl, kp, r) {
        const v = account.storage.get(keyOf(read(kp, kl)));
        if (!v) return 0n;
        setRegister(r, v);
        return 1n;
      },
      storage_remove(kl, kp, r) {
        const key = keyOf(read(kp, kl));
        const v = account.storage.get(key);
        if (!v) return 0n;
        account.storage.delete(key);
        setRegister(r, v);
        return 1n;
      },
      storage_has_key: (kl, kp) => (account.storage.has(keyOf(read(kp, kl))) ? 1n : 0n),
      log_utf8: (len, ptr) => logs.push(readString(ptr, len)),
      panic_utf8(len, ptr) {
        throw new Panic(readString(ptr, len));
      },
      value_return(len, ptr) {
        value = read(ptr, len);
      },
      sha256: (len, ptr, r) => setRegister(r, sha256(read(ptr, len))),
      ecrecover(hl, hp, sl, sp, v, flag, r) {
        const sig = read(sp, sl);
        try {
          const parsed = secp256k1.Signature.fromCompact(sig).addRecoveryBit(Number(v));
          const point = parsed.recoverPublicKey(read(hp, hl));
          setRegister(r, point.toRawBytes(false).slice(1));
          return 1n;
        } catch {
          return 0n;
        }
      },
      promise_batch_create(len, ptr) {
        const index = promises.length;
        promises.push({ index, receiver: readString(ptr, len), actions: [], after: [] });
        return BigInt(index);
      },
      promise_batch_then(idx, len, ptr) {
        const index = promises.length;
        promises.push({ index, receiver: readString(ptr, len), actions: [], after: [Number(idx)] });
        return BigInt(index);
      },
      promise_and(ptr, count) {
        const m = new DataView(memory.buffer);
        const members = [];
        for (let i = 0; i < Number(count); i++) members.push(Number(m.getBigUint64(Number(ptr) + i * 8, true)));
        const index = promises.length;
        promises.push({ index, and: members, actions: [] });
        return BigInt(index);
      },
      promise_batch_action_function_call(idx, ml, mp, al, ap, amount) {
        promises[Number(idx)].actions.push({
          kind: 'call',
          method: readString(mp, ml),
          args: read(ap, al),
          deposit: bytesToU128(read(amount, 16)),
        });
      },
      promise_batch_action_function_call_weight(idx, ml, mp, al, ap, amount) {
        env.promise_batch_action_function_call(idx, ml, mp, al, ap, amount);
      },
      promise_batch_action_transfer(idx, amount) {
        promises[Number(idx)].actions.push({ kind: 'transfer', amount: bytesToU128(read(amount, 16)) });
      },
      promise_return(idx) {
        returned = Number(idx);
      },
      promise_results_count: () => BigInt(ctx.results.length),
      promise_result(i, r) {
        const result = ctx.results[Number(i)];
        if (!result.ok) return 2n;
        setRegister(r, result.value);
        return 1n;
      },
    };

    for (const { name, module: from } of WebAssembly.Module.imports(account.module)) {
      if (from === 'env' && !env[name]) env[name] = unused(name);
    }

    const instance = new WebAssembly.Instance(account.module, { env });
    memory = instance.exports.memory;
    if (!instance.exports[method]) throw new Panic(`${account.id} has no method ${method}`);
    instance.exports[method]();
    return { value, logs, promises, returned };
  }

  outcomeOf(id) {
    const logs = [];
    const failures = [];
    for (const r of this.receipts.values()) {
      if (r.id >= id) {
        logs.push(...r.logs);
        if (r.state === 'failed') failures.push(r.error);
      }
    }
    const final = this.settled(id);
    return {
      ok: final.state === 'ok',
      error: final.state === 'failed' ? final.error : null,
      value: decodeValue(final.value),
      logs,
      events: logs
        .filter((l) => l.startsWith('EVENT_JSON:'))
        .map((l) => JSON.parse(l.slice('EVENT_JSON:'.length))),
      failures,
    };
  }
}

function expand(promises, index) {
  const p = promises[index];
  return p.and ? p.and.flatMap((m) => expand(promises, m)) : [index];
}

function encodeArgs(args) {
  return args instanceof Uint8Array ? args : encode(JSON.stringify(args));
}

function encodeReturn(v) {
  if (v === undefined || v === null) return new Uint8Array(0);
  return v instanceof Uint8Array ? v : encode(JSON.stringify(v));
}

function decodeValue(bytes) {
  if (!bytes || !bytes.length) return null;
  const text = utf8.decode(bytes);
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}
