// Moving dollars between NEAR and other chains through NEAR Intents, following the
// near-intents skill: live prices, a deposit address, status until a final answer, and
// plain words for every status, including refunds and failures. Also where the money sits
// right now, and the loan's schedule.

import { useEffect, useState } from 'preact/hooks';
import { describeTransfer, looksLikeAddress, payoutQuote, repayQuote, TERMINAL, USDC_ROUTES } from '@tools/lib/oneclick.mjs';
import { btc, hoursFromBlocks, num, short, usd, useApp } from './lib.js';
import { record, transfersOf, updateTransfer } from './history.js';

// Price quotes need NEAR accounts that exist. This one is used only for pricing.
const PRICING_ACCOUNT = 'wrap.near';

/** A live price from NEAR Intents, read straight from the 1Click API. Moves nothing. */
function useLiveQuote(kind, route, micro) {
  const [state, setState] = useState({ status: 'idle' });
  useEffect(() => {
    if (!route || !micro || BigInt(micro) <= 0n) {
      setState({ status: 'idle' });
      return undefined;
    }
    let stale = false;
    setState({ status: 'loading' });
    const timer = setTimeout(async () => {
      try {
        const r = kind === 'payout' ? await payoutQuote(route, micro, undefined, PRICING_ACCOUNT) : await repayQuote(route, micro, PRICING_ACCOUNT);
        if (!stale) setState({ status: 'ready', quote: r.quote });
      } catch (e) {
        if (!stale) setState({ status: 'failed', message: e.message });
      }
    }, 350);
    return () => {
      stale = true;
      clearTimeout(timer);
    };
  }, [kind, route?.id, String(micro)]);
  return state;
}

function QuoteLine({ kind, state, route }) {
  if (!route) return null;
  if (state.status === 'loading') return <p class="muted">Asking NEAR Intents for a live price…</p>;
  if (state.status === 'failed') return <p class="muted">No live quote right now. Repaying and settling directly on NEAR always works.</p>;
  if (state.status !== 'ready') return null;
  const q = state.quote;
  const text =
    kind === 'payout'
      ? `You would receive ${Number(q.amountOutFormatted).toFixed(2)} USDC on ${route.label}`
      : `You would send up to ${Number(q.amountInFormatted).toFixed(2)} USDC from ${route.label}`;
  return (
    <p class="quote-line">
      <b>{text}</b> in about {q.timeEstimate} seconds.
      {kind === 'repay' && ' That includes a slippage buffer, and anything unused is refunded.'} Live quote from NEAR Intents.
    </p>
  );
}

/** What this network can do with Intents, in one sentence. */
function ModeNote({ route, direction }) {
  const { backend } = useApp();
  if (!route) return null;
  const text = {
    simulated: 'The price is live from NEAR Intents. The transfer itself is simulated here, because Intents has no testnet.',
    none: `NEAR Intents has no testnet, so this is a real price, and the dollars stay on NEAR here. ${direction === 'out' ? `Delivery to ${route.label}` : `Bringing dollars from ${route.label}`} needs a mainnet deployment.`,
    real: null,
  }[backend.intentsMode];
  return text ? <p class="muted small-note">{text}</p> : null;
}

/** Where borrowed dollars go: this NEAR account, or another chain through NEAR Intents. */
export function ChainPicker({ micro, value, onChange }) {
  const route = USDC_ROUTES.find((r) => r.id === value.routeId);
  const state = useLiveQuote('payout', route, micro);
  const wrong = route && value.recipient && !looksLikeAddress(route, value.recipient);
  return (
    <div class="intents">
      <label>
        Deliver the dollars to
        <select value={value.routeId} onChange={(e) => onChange({ ...value, routeId: e.currentTarget.value })}>
          <option value="near">NEAR account, directly</option>
          {USDC_ROUTES.map((r) => (
            <option key={r.id} value={r.id}>
              {r.label}, through NEAR Intents
            </option>
          ))}
        </select>
      </label>
      {route && (
        <label>
          Your address on {route.label}
          <input
            class="mono"
            value={value.recipient}
            placeholder={route.kind === 'evm' ? '0x…' : 'Solana address'}
            aria-invalid={wrong ? 'true' : 'false'}
            onInput={(e) => onChange({ ...value, recipient: e.currentTarget.value.trim() })}
          />
        </label>
      )}
      {wrong && <p class="bad-text">That is not a {route.label} address.</p>}
      <QuoteLine kind="payout" state={state} route={route} />
      <ModeNote route={route} direction="out" />
    </div>
  );
}

/** Bring the repayment from another chain: a deposit address, then the loan is repaid on NEAR. */
export function RepayFromChain({ vault }) {
  const { backend, act, busy } = useApp();
  const [routeId, setRouteId] = useState('near');
  const [refundTo, setRefundTo] = useState('');
  const route = USDC_ROUTES.find((r) => r.id === routeId);
  const debt = BigInt(vault.loan.debt);
  const state = useLiveQuote('repay', route, debt);
  const fits = route && looksLikeAddress(route, refundTo);
  return (
    <div class="intents">
      <label>
        Repay from
        <select value={routeId} onChange={(e) => setRouteId(e.currentTarget.value)}>
          <option value="near">NEAR account, directly</option>
          {USDC_ROUTES.map((r) => (
            <option key={r.id} value={r.id}>
              {r.label}, through NEAR Intents
            </option>
          ))}
        </select>
      </label>
      {route && (
        <>
          <label>
            Your address on {route.label}, for a refund if anything goes wrong
            <input class="mono" value={refundTo} placeholder="0x…" onInput={(e) => setRefundTo(e.currentTarget.value.trim())} />
          </label>
          <QuoteLine kind="repay" state={state} route={route} />
          <ModeNote route={route} direction="in" />
          <button
            class="ghost"
            disabled={busy || !fits || backend.intentsMode === 'none'}
            onClick={() =>
              act(
                () => backend.receiveFrom({ vaultId: vault.id, route, microUsdc: debt, refundTo }),
                `Deposit address ready. Send the amount shown from your wallet on ${route.label}.`,
              )
            }
          >
            Get a deposit address on {route.label}
          </button>
        </>
      )}
    </div>
  );
}

const STAGE = { PENDING_DEPOSIT: 0, KNOWN_DEPOSIT_TX: 1, PROCESSING: 2 };

function Steps({ transfer, d }) {
  const out = transfer.direction === 'out';
  const at = d.terminal ? 3 : (STAGE[d.code] ?? 0);
  const labels = [
    out ? 'Sent to the NEAR Intents deposit address' : `You pay on ${transfer.chain}`,
    'NEAR Intents has seen the deposit',
    `Moving to ${out ? transfer.chain : 'NEAR'}`,
    d.terminal ? d.title : out ? `Delivered on ${transfer.chain}` : 'Arrives on NEAR',
  ];
  // A loan paid into the deposit address has already left the contract, so step one is done.
  const done = (i) => i < at || (out && i === 0) || (d.terminal && i === 3);
  return (
    <ol class="transfer-steps">
      {labels.map((label, i) => (
        <li key={label} class={`${done(i) ? 'is-done' : ''} ${i === at && !d.terminal ? 'is-now' : ''} ${i === 3 && d.terminal ? `is-${d.tone}` : ''}`}>
          {label}
        </li>
      ))}
    </ol>
  );
}

function CopyText({ text }) {
  const [copied, setCopied] = useState(false);
  return (
    <span class="copy">
      <code class="address">{text}</code>
      <button
        class="ghost small"
        onClick={() =>
          navigator.clipboard
            ?.writeText(text)
            .then(() => setCopied(true))
            .catch(() => setCopied(false))
        }
      >
        {copied ? 'Copied' : 'Copy'}
      </button>
    </span>
  );
}

/** One transfer through NEAR Intents, followed until it ends. */
export function TransferCard({ transfer }) {
  const { backend, act, busy, refresh } = useApp();
  const [last, setLast] = useState(transfer.last ?? null);
  const [problem, setProblem] = useState(null);

  useEffect(() => {
    if (last && TERMINAL.has(last.status)) return undefined;
    let stop = false;
    let timer;
    const tick = async () => {
      try {
        const next = await backend.transferStatus(transfer);
        if (stop) return;
        setLast(next);
        setProblem(null);
        updateTransfer(backend.kind, transfer.depositAddress, { last: next });
        if (TERMINAL.has(next.status)) {
          const d = describeTransfer(next, transfer);
          const details = next.swapDetails ?? {};
          record(backend.kind, {
            action: `${d.title}${transfer.simulated ? ' (simulated)' : ''}`,
            vault: transfer.vaultId,
            // What actually moved: delivered, refunded, or the deposit that is still held.
            amount: next.status === 'SUCCESS' ? (details.amountOut ?? transfer.amountOut) : next.status === 'REFUNDED' ? (details.refundedAmount ?? transfer.amountIn) : transfer.amountIn,
            links: d.links,
            simulated: transfer.simulated,
          });
          refresh();
          return;
        }
      } catch (e) {
        if (!stop) setProblem(e.message);
      }
      if (!stop) timer = setTimeout(tick, backend.kind === 'sim' ? 1200 : 5000);
    };
    timer = setTimeout(tick, 400);
    return () => {
      stop = true;
      clearTimeout(timer);
    };
  }, [transfer.depositAddress]);

  const d = describeTransfer(last, transfer);
  const out = transfer.direction === 'out';
  const waitingForUser = !out && (!last || last.status === 'PENDING_DEPOSIT');
  return (
    <section class={`transfer ${d.tone}`} aria-live="polite">
      <p class="eyebrow">NEAR Intents{transfer.simulated ? ', simulated' : ''}</p>
      <h3>
        {out ? `Sending ${usd(transfer.amountIn)} to ${transfer.chain}` : `Bringing ${usd(transfer.amountOut)} from ${transfer.chain}`}
      </h3>
      <Steps transfer={transfer} d={d} />
      <p class="where">
        <b>Where the money is now:</b> {d.where}.
      </p>
      {waitingForUser && (
        <div class="passive">
          <p>
            Send exactly <b>{usd(transfer.amountIn)} USDC on {transfer.chain}</b> to this address, before{' '}
            {new Date(transfer.deadline).toLocaleTimeString()}:
          </p>
          <CopyText text={transfer.depositAddress} />
          {backend.kind === 'sim' && (
            <button disabled={busy} onClick={() => act(async () => backend.payFromOtherChain(transfer.depositAddress), 'Paid from the simulated wallet.')}>
              Pay from the simulated {transfer.chain} wallet
            </button>
          )}
        </div>
      )}
      {d.links.length > 0 && (
        <p class="links">
          {d.links.map((l) =>
            l.url ? (
              <a key={l.label} href={l.url} target="_blank" rel="noreferrer">
                {l.label}
              </a>
            ) : (
              <span key={l.label} class="muted">
                {l.label} (simulated)
              </span>
            ),
          )}
        </p>
      )}
      {problem && <p class="bad-text">Could not read the status: {problem}. It will try again.</p>}
      <details class="check">
        <summary>Transfer details</summary>
        <p class="mono small-note">Deposit address {transfer.depositAddress}</p>
        <p class="small-note">
          {out ? `To ${transfer.recipient} on ${transfer.chain}` : `To ${transfer.recipient} on NEAR`}. Refunds go to {transfer.refundTo}
          {out ? ' on NEAR' : ` on ${transfer.chain}`}.
        </p>
      </details>
    </section>
  );
}

/** Every transfer for one vault, newest first. */
export function TransfersFor({ vault }) {
  const { backend } = useApp();
  const list = transfersOf(backend.kind).filter((t) => t.vaultId === vault.id);
  return list.map((t) => <TransferCard key={t.depositAddress} transfer={t} />);
}

/** Where each part of the money is, right now. */
export function WhereMoney({ vault }) {
  const { backend, snap, act, busy } = useApp();
  const rows = [];
  const site = backend.btcAddressUrl?.(vault.address);
  if (!vault.deposit) {
    rows.push(['Bitcoin', vault.address ? 'Not sent yet. Your vault address is waiting for it' : 'Your vault is being set up']);
  } else if (vault.status === 'settling') {
    const to = short(backend.addressOf(vault.destination), 12, 6);
    rows.push(['Bitcoin', vault.signed_tx ? `Signed to leave for ${to}. Anyone can broadcast it` : `Set to leave for ${to}, waiting for the signers`]);
  } else {
    rows.push(['Bitcoin', `${btc(vault.deposit.sats, 6)} in your vault address on Bitcoin, under its two locks`, site]);
  }
  if (vault.loan) {
    const sent = transfersOf(backend.kind).find((t) => t.vaultId === vault.id && t.direction === 'out');
    rows.push(['Borrowed dollars', sent ? describeTransfer(sent.last, sent).where : `Paid to ${short(vault.owner, 20, 8)} on NEAR`]);
    rows.push(['What you owe', `${usd(vault.loan.debt)}, due at block ${num(vault.loan.due_height)}`]);
  }
  if (vault.status === 'auction') rows.push(['In auction', 'The coins are for sale. The lender is paid first and the rest comes back to you']);
  const waiting = vault.owner === snap.account ? BigInt(snap.withdrawable ?? '0') : 0n;
  return (
    <section class="money" aria-label="Where your money is">
      <h2>Where your money is</h2>
      <dl>
        {rows.map(([what, where, url]) => (
          <div key={what}>
            <dt>{what}</dt>
            <dd>
              {where}
              {url && (
                <>
                  {' '}
                  <a href={url} target="_blank" rel="noreferrer">
                    Look it up
                  </a>
                </>
              )}
            </dd>
          </div>
        ))}
        {waiting > 0n && (
          <div>
            <dt>Waiting for you</dt>
            <dd>
              {usd(waiting)} in the Ripcord contract, yours to take.{' '}
              <button class="ghost small" disabled={busy} onClick={() => act(() => backend.withdraw(), 'Withdrawn to your NEAR account.')}>
                Withdraw
              </button>
            </dd>
          </div>
        )}
      </dl>
    </section>
  );
}

/** The blocks that matter for this vault, and how far away each is. */
export function Schedule({ vault, tip, params }) {
  const loan = vault.loan;
  const rows = [
    ...(loan
      ? [
          ['Loan due', loan.due_height, 'Repay by this block. The debt is fixed and does not grow.'],
          ['Grace ends', loan.grace_end_height, 'After this, anyone can start the auction.'],
          ['Last block to start the auction', loan.grace_end_height + params.start_window_blocks, 'After this, the coins go straight to the lender.'],
        ]
      : []),
    ['Your exit opens', vault.escape_height, 'Your escape ticket works from this block, whatever else happens.'],
  ];
  return (
    <section aria-label="Schedule">
      <h2>Schedule</h2>
      <div class="scroll">
        <table class="data">
          <thead>
            <tr>
              <th scope="col">What</th>
              <th scope="col">Bitcoin block</th>
              <th scope="col">When</th>
              <th scope="col">Means</th>
            </tr>
          </thead>
          <tbody>
            {rows.map(([what, height, means]) => (
              <tr key={what}>
                <td>{what}</td>
                <td class="mono">{num(height)}</td>
                <td>{tip >= height ? 'Passed' : `In ${hoursFromBlocks(height - tip)}`}</td>
                <td>{means}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}
