import { useRef, useState } from 'preact/hooks';
import {
  addressToScript,
  buildSpend,
  bytesToHex,
  hexToBytes,
  newOwnerKey,
  signOwnerPath,
} from '@tools/lib/btc-core.mjs';
import { btc, num, short, useApp } from './lib.js';
import { Handle } from './app.jsx';

const SWITCHES = [
  ['website', 'This website', 'Every action is a plain contract call. The tools are in the public repo.'],
  ['relayer', 'Our relayer', 'Anyone can submit a proof or broadcast a signed transaction.'],
  ['oneclick', '1Click and Intents', 'Repaying and settling work directly on NEAR.'],
  ['oracle', 'The price feed', 'There is not one, so there is nothing to fail.'],
  ['mpc', 'NEAR’s signer network', 'The contract cannot sign. Your ticket does not need it to.'],
  ['near', 'NEAR itself', 'No proofs, no contract, no signers. Bitcoin is still running.'],
];

const pause = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * The whole argument in one run: a real loan on the real contract, then everything is
 * switched off, then Bitcoin refuses the ticket early and accepts it on time.
 */
async function blackout(backend, log, setOff) {
  backend.reset(); // replaces the world, so read `backend.w` only after this
  const w = backend.w;
  setOff({});
  const say = async (text, kind = 'info', ms = 500) => {
    log((l) => [...l, { text, kind }]);
    await pause(ms);
  };

  await say('A borrower opens a vault with a key only they hold.');
  const key = newOwnerKey();
  const snap = await backend.snapshot();
  const escape = snap.tip + 90;
  const opened = await backend.openVault({
    ownerPubkey: bytesToHex(key.publicKey),
    escapeHeight: escape,
    expectedSats: 1_000_000,
  });
  const id = opened.events.find((e) => e.event === 'vault_opened').data[0].vault_id;
  const vaultOf = () => w.near.view(w.a.ripcord, 'get_vault', { vault_id: String(id) });

  await backend.sendDeposit(vaultOf(), 1_000_000);
  await say(`0.01 BTC locked on Bitcoin at ${short(vaultOf().address, 12, 6)}.`);

  await backend.proveDeposit(vaultOf());
  await say('The light client on NEAR accepts the proof. The contract has signed nothing.');

  const offer = (await backend.snapshot()).offers[0];
  const principal = 300n * 1_000_000n;
  await backend.borrow({
    vaultId: String(id),
    offerId: offer.id,
    principal,
    auctionOpenPerBtc: 228_000n * 1_000_000n,
    payoutTo: snap.account,
  });
  await say(`$300 borrowed against it. Debt is fixed until block ${num(vaultOf().loan.due_height)}.`);

  const home = backend.btcAddressOfRole();
  const v = vaultOf();
  const tx = buildSpend({
    txid: v.deposit.txid,
    vout: v.deposit.vout,
    value: Number(v.deposit.sats),
    destination: addressToScript('tb', home),
    feeSats: 400,
    lockTime: v.escape_height,
  });
  const script = hexToBytes(v.witness_script);
  const ticket = bytesToHex(signOwnerPath(tx, script, Number(v.deposit.sats), key.secret));
  await say(`The borrower signs an escape ticket, valid after block ${num(escape)}, and keeps the file.`, 'info', 800);

  backend.setPrice(38_000);
  await say('Bitcoin falls 50%. The vault does not change: the contract never sees a price.', 'warn', 900);

  for (const [name, label] of SWITCHES) {
    backend.setKilled(name, true);
    setOff((o) => ({ ...o, [name]: true }));
    await say(`${label}: off.`, 'off', 420);
  }

  await say('Everything is off. The borrower tries the ticket anyway.', 'info', 700);
  const early = await backend.broadcast(ticket);
  await say(`Bitcoin refuses it: ${early.error}`, 'bad', 1100);

  await say(`Bitcoin keeps making blocks, as it always does. Waiting for block ${num(escape)}.`, 'info', 500);
  while (w.bitcoin.height <= escape) {
    w.bitcoin.mine(Math.min(20, escape + 1 - w.bitcoin.height));
    await say(`Block ${num(w.bitcoin.height)}`, 'tick', 180);
  }

  const late = await backend.broadcast(ticket);
  if (!late.ok) {
    await say(`Bitcoin refused it: ${late.error}`, 'bad');
    return false;
  }
  await say(`Bitcoin accepts the ticket. Transaction ${short(late.txid)}.`, 'good', 700);
  const balance = await backend.btcBalanceOf(home);
  await say(`${btc(balance)} is back in the borrower’s own address. No other chain took part.`, 'good');
  return true;
}

export function SwitchOff() {
  const { backend, refresh, setNotice } = useApp();
  const [lines, setLines] = useState([]);
  const [off, setOff] = useState({});
  const [state, setState] = useState('idle');
  const logRef = useRef(null);

  const log = (update) => {
    setLines(update);
    requestAnimationFrame(() => {
      const el = logRef.current;
      if (el) el.scrollTop = el.scrollHeight;
    });
  };

  if (backend.kind !== 'sim') {
    return (
      <>
        <p class="eyebrow">Try to switch it off</p>
        <h1>This test runs in the simulator</h1>
        <p>Switch the network to Simulator at the top of the page. It runs the same compiled contracts.</p>
      </>
    );
  }

  const run = async () => {
    setState('running');
    setLines([]);
    setNotice(null);
    try {
      const done = await blackout(backend, log, setOff);
      setState(done ? 'done' : 'failed');
    } catch (e) {
      log((l) => [...l, { text: `The run stopped: ${e.message}`, kind: 'bad' }]);
      setState('failed');
    }
    refresh();
  };

  const toggle = (name) => {
    const value = !backend.killed[name];
    backend.setKilled(name, value);
    setOff((o) => ({ ...o, [name]: value }));
    refresh();
  };

  return (
    <>
      <p class="eyebrow">Try to switch it off</p>
      <h1>Pull everything. See what is left.</h1>
      <p class="lede">
        This runs a real loan on the compiled contract, then turns off every part of the system, including NEAR.
        Bitcoin is simulated here with its real rules for this script.
      </p>

      <section class="room">
        <div class="switches">
          {SWITCHES.map(([name, label, note]) => (
            <label key={name} class={`switch ${off[name] ? 'off' : ''}`}>
              <input
                type="checkbox"
                checked={!off[name]}
                disabled={state === 'running'}
                onChange={() => toggle(name)}
              />
              <span class="switch-box" aria-hidden="true" />
              <span>
                <b>{label}</b>
                <small>{note}</small>
              </span>
            </label>
          ))}
        </div>

        <div class="handle-wrap">
          <button class="handle" disabled={state === 'running'} onClick={run}>
            <Handle size={64} />
            <span>{state === 'running' ? 'Running' : state === 'done' ? 'Pull again' : 'Pull the ripcord'}</span>
          </button>
          <p class="muted">Takes about 15 seconds.</p>
        </div>
      </section>

      {lines.length > 0 && (
        <ol class="log" ref={logRef} aria-live="polite">
          {lines.map((l, i) => (
            <li key={i} class={l.kind}>
              {l.text}
            </li>
          ))}
        </ol>
      )}

      {state === 'done' && (
        <p class="verdict">
          Everything was off, and the coins came home. That is the whole product: a loan whose worst case is enforced
          by Bitcoin.
        </p>
      )}

      <h2>What this does not protect against</h2>
      <p>
        The ripcord protects you if NEAR’s signers go <b>offline</b>. If a majority of them turned <b>malicious</b>,
        they could spend the first lock before your escape block. That is the same trust as every Chain Signatures
        product. Ripcord adds a way out of a shutdown, not a defence against a colluding majority.
      </p>
    </>
  );
}
