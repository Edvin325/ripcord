import { useEffect, useState } from 'preact/hooks';
import { payoutQuote, repayQuote, USDC_ROUTES } from '@tools/lib/oneclick.mjs';
import { useApp } from './lib.js';

// Quotes need NEAR accounts that exist. This one is used only for pricing.
const PRICING_ACCOUNT = 'wrap.near';

/**
 * A live price from NEAR Intents, shown directly from the 1Click API. No server of ours sits
 * in between. `kind` is 'payout' or 'repay', and `micro` is the amount in micro-USDC.
 */
function useQuote(kind, route, micro) {
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
        const r =
          kind === 'payout'
            ? await payoutQuote(route, micro, undefined, PRICING_ACCOUNT)
            : await repayQuote(route, micro, PRICING_ACCOUNT, 0);
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
  if (!route) return null; // an older quote can still be in state when the route is cleared
  if (state.status === 'loading') return <p class="muted">Asking NEAR Intents for a live price…</p>;
  if (state.status === 'failed') {
    return <p class="muted">No live quote right now. Repaying and settling directly on NEAR always works.</p>;
  }
  if (state.status !== 'ready') return null;
  const q = state.quote;
  const text =
    kind === 'payout'
      ? `You would receive ${Number(q.amountOutFormatted).toFixed(2)} USDC on ${route.label}`
      : `You would send up to ${Number(q.amountInFormatted).toFixed(2)} USDC from ${route.label}`;
  return (
    <p class="quote-line">
      <b>{text}</b> in about {q.timeEstimate} seconds.
      {kind === 'repay' && ' That includes a slippage buffer, and anything unused is refunded.'} Live quote from NEAR
      Intents.
    </p>
  );
}

function RouteSelect({ label, value, onChange }) {
  return (
    <label>
      {label}
      <select value={value} onChange={(e) => onChange(e.currentTarget.value)}>
        <option value="near">NEAR account, directly</option>
        {USDC_ROUTES.map((r) => (
          <option key={r.id} value={r.id}>
            {r.label}, through NEAR Intents
          </option>
        ))}
      </select>
    </label>
  );
}

/** Intents has no testnet, and this build has no mainnet deployment, so it says so. */
function Limits({ route }) {
  const { backend } = useApp();
  if (!route || backend.label === 'Mainnet') return null;
  return (
    <p class="muted small-note">
      NEAR Intents has no testnet, so this is a real price, and the dollars stay on NEAR here. Delivery to {route.label}{' '}
      needs a mainnet deployment.
    </p>
  );
}

export function PayoutPicker({ micro }) {
  const [id, setId] = useState('near');
  const route = USDC_ROUTES.find((r) => r.id === id);
  const state = useQuote('payout', route, micro);
  return (
    <div class="intents">
      <RouteSelect label="Deliver the dollars to" value={id} onChange={setId} />
      <QuoteLine kind="payout" state={state} route={route} />
      <Limits route={route} />
    </div>
  );
}

export function RepayPicker({ micro }) {
  const [id, setId] = useState('near');
  const route = USDC_ROUTES.find((r) => r.id === id);
  const state = useQuote('repay', route, micro);
  return (
    <div class="intents">
      <RouteSelect label="Repay from" value={id} onChange={setId} />
      <QuoteLine kind="repay" state={state} route={route} />
      <Limits route={route} />
    </div>
  );
}
