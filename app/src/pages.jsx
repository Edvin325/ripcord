import { useEffect, useState } from 'preact/hooks';
import { newOwnerKey, bytesToHex } from '@tools/lib/btc-core.mjs';
import { btc, dollars, go, hoursFromBlocks, MICRO, near, num, percent, SATS, short, usd, useApp } from './lib.js';
import { remember } from './keys.js';

// ---- Shared pieces ----

export function Stat({ label, value, note }) {
  return (
    <div class="stat">
      <span class="stat-label">{label}</span>
      <b class="stat-value">{value}</b>
      {note && <span class="stat-note">{note}</span>}
    </div>
  );
}

export function Step({ n, title, children, active = true }) {
  return (
    <section class={`step ${active ? '' : 'dim'}`}>
      <span class="step-n">{n}</span>
      <div>
        <h3>{title}</h3>
        {children}
      </div>
    </section>
  );
}

// ---- Home ----

const EMERGENCIES = [
  ['This website disappears', 'Nothing changes. Every action is a plain contract call, and the tools are in the public repo.'],
  ['Our relayer stops', 'Anyone can submit a deposit proof or broadcast a signed Bitcoin transaction.'],
  ['1Click stops', 'Repay and settle directly on NEAR. Intents is the fast road, not the only road.'],
  ['The price feed goes stale', 'There is no price feed. Lenders name their own price per bitcoin.'],
  ['Bitcoin falls 50%', 'Nothing happens before the due date. The contract has no idea what the price is.'],
  ['NEAR and its signers stop', 'After your escape block, your ticket pays out on Bitcoin. No other chain is involved.'],
];

export function Home() {
  const { snap } = useApp();
  const { stats, endowment } = snap;
  return (
    <>
      <section class="hero">
        <p class="eyebrow">Native Bitcoin credit on NEAR</p>
        <h1>Borrow against Bitcoin that never leaves Bitcoin.</h1>
        <p class="lede">
          No bridge. No oracle. No liquidation. And if NEAR itself ever stops, Bitcoin hands your coins back.
        </p>
        <div class="row">
          <a class="button" href="#/borrow">
            Borrow against Bitcoin
          </a>
          <a class="button ghost" href="#/switch">
            Try to switch it off
          </a>
        </div>
      </section>

      <section class="stats">
        <Stat label="Bitcoin locked" value={btc(stats.sats_locked, 4)} note="On Bitcoin, under script" />
        <Stat label="Lent" value={usd(stats.principal_lent, 0)} note={`${stats.loans_opened} loans`} />
        <Stat label="Vaults" value={num(stats.vaults_opened)} note="Each with its own key" />
        <Stat label="NEAR for validators" value={near(endowment.total_received)} note="From vault fees" />
      </section>

      <section class="split">
        <div>
          <p class="eyebrow">How it works</p>
          <h2>Every loan is a coin with two locks.</h2>
          <p>
            Your Bitcoin sits in an address built for this loan alone. The address is a small Bitcoin program with two
            ways to spend.
          </p>
          <ol class="plain">
            <li>
              <b>A NEAR contract</b> can move the coins by fixed rules: back to you after repayment, or to the auction
              winner if you default. Chain Signatures signs it. A light client on NEAR proves your deposit is real.
            </li>
            <li>
              <b>You, alone,</b> can move the coins after a set block. Bitcoin enforces this. No company, chain or
              signer can stop it.
            </li>
          </ol>
          <p>
            The dollars can reach you on any chain through NEAR Intents, and you can repay the same way. The Bitcoin
            never moves.
          </p>
        </div>
        <Locks />
      </section>

      <section>
        <p class="eyebrow">Safety card</p>
        <h2>In case of emergency</h2>
        <table class="card-table">
          <tbody>
            {EMERGENCIES.map(([when, then], i) => (
              <tr key={when}>
                <td class="num">{i + 1}</td>
                <th scope="row">{when}</th>
                <td>{then}</td>
              </tr>
            ))}
          </tbody>
        </table>
        <div class="row">
          <a class="button" href="#/switch">
            Test each one yourself
          </a>
        </div>
      </section>
    </>
  );
}

export function Locks({ vault }) {
  const escape = vault ? `block ${num(vault.escape_height)}` : 'your escape block';
  return (
    <figure class="locks" aria-label="The two ways to spend a vault">
      <div class="lock">
        <span class="lock-tag">Lock 1</span>
        <h4>The contract</h4>
        <p>Spends by fixed rules, through NEAR’s signer network. Open from day one.</p>
        <code>OP_IF &lt;contract key&gt; CHECKSIG</code>
      </div>
      <div class="lock escape">
        <span class="lock-tag">Lock 2, the ripcord</span>
        <h4>You, alone</h4>
        <p>Opens after {escape}. Enforced by Bitcoin. Nobody can stop it.</p>
        <code>OP_ELSE &lt;height&gt; CLTV DROP &lt;your key&gt; CHECKSIG</code>
      </div>
    </figure>
  );
}

// ---- Borrow ----

export function offerRows(offers) {
  return offers
    .filter((o) => o.active && BigInt(o.available) > 0n)
    .sort((a, b) => Number(BigInt(b.micro_usdc_per_btc) - BigInt(a.micro_usdc_per_btc)));
}

function OfferTable({ offers, price, selected, onSelect }) {
  if (!offers.length) return <p class="muted">No open offers yet.</p>;
  return (
    <table class="data">
      <thead>
        <tr>
          <th scope="col">Lends per BTC</th>
          <th scope="col">Against today’s price</th>
          <th scope="col">Fixed APR</th>
          <th scope="col">Term</th>
          <th scope="col">Available</th>
          <th scope="col" aria-label="Choose" />
        </tr>
      </thead>
      <tbody>
        {offers.map((o) => {
          const per = Number(o.micro_usdc_per_btc) / MICRO;
          return (
            <tr key={o.id} class={selected === o.id ? 'picked' : ''}>
              <td class="mono">{dollars(per)}</td>
              <td>{price ? `${Math.round((per / price) * 100)}%` : 'n/a'}</td>
              <td>{percent(o.apr_bps)}</td>
              <td>
                {num(o.term_blocks)} blocks
                <span class="muted"> ({hoursFromBlocks(o.term_blocks)})</span>
              </td>
              <td class="mono">{usd(o.available, 0)}</td>
              <td>
                {onSelect && (
                  <button class="small" onClick={() => onSelect(o.id)}>
                    {selected === o.id ? 'Chosen' : 'Choose'}
                  </button>
                )}
              </td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}

export function Borrow() {
  const { backend, snap, act, busy } = useApp();
  const offers = offerRows(snap.offers);
  const [offerId, setOfferId] = useState(offers[0]?.id);
  const [amountBtc, setAmountBtc] = useState('0.01');
  const offer = offers.find((o) => o.id === offerId) ?? offers[0];
  const { params } = snap.config;

  const sats = Math.round(Number(amountBtc) * SATS) || 0;
  const maxLoan = offer ? (BigInt(sats) * BigInt(offer.micro_usdc_per_btc)) / 100_000_000n : 0n;
  const margin = 12;
  const lifetime = offer
    ? offer.term_blocks + params.grace_blocks + params.auction_blocks + params.safety_blocks + margin
    : 0;
  const mine = snap.vaults.filter((v) => v.owner === snap.account);

  const open = async () => {
    const key = newOwnerKey();
    const r = await act(
      () =>
        backend.openVault({
          ownerPubkey: bytesToHex(key.publicKey),
          escapeHeight: snap.lightClientTip + lifetime,
          expectedSats: sats,
        }),
      'Vault opened. Your Bitcoin address is ready.',
    );
    const id = r?.events?.find((e) => e.event === 'vault_opened')?.data[0].vault_id;
    if (id !== undefined) {
      remember(backend.kind, id, { secret: bytesToHex(key.secret), offerId: offer?.id, plannedSats: sats });
      go(`vault/${id}`);
    }
  };

  return (
    <>
      <p class="eyebrow">Borrow</p>
      <h1>Borrow against your Bitcoin</h1>
      <p class="lede">Pick an offer, then lock your coins in a vault of your own. Rates are fixed for the term.</p>

      <h2>Open offers</h2>
      <OfferTable offers={offers} price={snap.btcPrice} selected={offer?.id} onSelect={setOfferId} />

      <h2>Your vault</h2>
      <div class="form">
        <label>
          Bitcoin to lock
          <input
            inputMode="decimal"
            value={amountBtc}
            onInput={(e) => setAmountBtc(e.currentTarget.value)}
            aria-describedby="borrow-help"
          />
        </label>
        <div id="borrow-help" class="quote">
          <Stat label="You can borrow up to" value={usd(maxLoan)} />
          <Stat label="Your exit opens in" value={`${num(lifetime)} blocks`} note={hoursFromBlocks(lifetime)} />
          <Stat label="Vault fee" value={near(snap.config.vault_fee)} note="Staked with NEAR validators" />
        </div>
        <button disabled={busy || !offer || sats < params.min_collateral_sats || !snap.account} onClick={open}>
          Open vault
        </button>
        {!snap.account && <p class="muted">Connect a wallet to open a vault.</p>}
      </div>

      {mine.length > 0 && (
        <>
          <h2>Your vaults</h2>
          <VaultList vaults={mine} />
        </>
      )}
    </>
  );
}

const STATUS = {
  deriving: 'Setting up',
  awaiting_deposit: 'Waiting for your deposit',
  funded: 'Funded, no loan',
  borrowed: 'Loan open',
  auction: 'In auction',
  settling: 'Settling',
};

export const statusLabel = (s) => STATUS[s] ?? s;

export function VaultList({ vaults }) {
  return (
    <table class="data">
      <thead>
        <tr>
          <th scope="col">Vault</th>
          <th scope="col">Status</th>
          <th scope="col">Bitcoin</th>
          <th scope="col">Debt</th>
          <th scope="col">Exit opens</th>
          <th scope="col" aria-label="Open" />
        </tr>
      </thead>
      <tbody>
        {vaults.map((v) => (
          <tr key={v.id}>
            <td class="mono">#{v.id}</td>
            <td>{statusLabel(v.status)}</td>
            <td class="mono">{v.deposit ? btc(v.deposit.sats, 4) : 'None yet'}</td>
            <td class="mono">{v.loan ? usd(v.loan.debt) : 'None'}</td>
            <td class="mono">{num(v.escape_height)}</td>
            <td>
              <a href={`#/vault/${v.id}`}>View</a>
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

// ---- Lend ----

export function Lend() {
  const { backend, snap, act, busy } = useApp();
  const [dollarsIn, setDollars] = useState('1000');
  const [perBtc, setPerBtc] = useState('35000');
  const [apr, setApr] = useState('8');
  const [term, setTerm] = useState('40');
  const [address, setAddress] = useState(backend.btcAddressOfRole());
  useEffect(() => setAddress(backend.btcAddressOfRole()), [snap.account]);

  const mine = snap.offers.filter((o) => o.lender === snap.account);
  const withdrawable = BigInt(snap.withdrawable);

  const make = () =>
    act(() => {
      let btcScript;
      try {
        btcScript = backend.scriptOf(address.trim());
      } catch (e) {
        return { ok: false, error: e.message };
      }
      return backend.makeOffer({
        amount: BigInt(Math.round(Number(dollarsIn) * MICRO)),
        microUsdcPerBtc: BigInt(Math.round(Number(perBtc) * MICRO)),
        aprBps: Math.round(Number(apr) * 100),
        termBlocks: Number(term),
        btcScript,
      });
    }, 'Your offer is live.');

  const ltv = snap.btcPrice ? Math.round((Number(perBtc) / snap.btcPrice) * 100) : null;

  return (
    <>
      <p class="eyebrow">Lend</p>
      <h1>Lend dollars against native Bitcoin</h1>
      <p class="lede">
        You name the price per bitcoin, the rate and the term. There is no oracle and no margin call. If a borrower
        defaults, an auction pays you first. If nobody bids, you receive the Bitcoin.
      </p>

      <div class="callout">
        <b>Your risk.</b> If Bitcoin falls below your price and the borrower walks away, you can end up holding Bitcoin
        worth less than the loan. Set your price with that in mind.
      </div>

      <h2>Make an offer</h2>
      <div class="form grid">
        <label>
          Dollars to lend
          <input inputMode="decimal" value={dollarsIn} onInput={(e) => setDollars(e.currentTarget.value)} />
        </label>
        <label>
          Dollars per BTC{ltv !== null && <span class="muted"> ({ltv}% of today’s price)</span>}
          <input inputMode="decimal" value={perBtc} onInput={(e) => setPerBtc(e.currentTarget.value)} />
        </label>
        <label>
          Fixed APR, %
          <input inputMode="decimal" value={apr} onInput={(e) => setApr(e.currentTarget.value)} />
        </label>
        <label>
          Term, in Bitcoin blocks
          <input inputMode="numeric" value={term} onInput={(e) => setTerm(e.currentTarget.value)} />
        </label>
        <label class="wide">
          Your Bitcoin address, for collateral if nobody bids
          <input class="mono" value={address} onInput={(e) => setAddress(e.currentTarget.value)} />
        </label>
        <button disabled={busy || !snap.account} onClick={make}>
          Publish offer
        </button>
      </div>

      <h2>Your balance</h2>
      <div class="row center">
        <Stat label="Ready to withdraw" value={usd(withdrawable)} />
        <button
          disabled={busy || withdrawable === 0n}
          onClick={() => act(() => backend.withdraw(), 'Withdrawn to your account.')}
        >
          Withdraw
        </button>
      </div>

      {mine.length > 0 && (
        <>
          <h2>Your offers</h2>
          <table class="data">
            <thead>
              <tr>
                <th scope="col">Offer</th>
                <th scope="col">Per BTC</th>
                <th scope="col">APR</th>
                <th scope="col">Left</th>
                <th scope="col" aria-label="Cancel" />
              </tr>
            </thead>
            <tbody>
              {mine.map((o) => (
                <tr key={o.id}>
                  <td class="mono">#{o.id}</td>
                  <td class="mono">{usd(o.micro_usdc_per_btc, 0)}</td>
                  <td>{percent(o.apr_bps)}</td>
                  <td class="mono">{usd(o.available, 0)}</td>
                  <td>
                    {o.active ? (
                      <button
                        class="ghost small"
                        disabled={busy}
                        onClick={() => act(() => backend.cancelOffer(o.id), 'Offer closed.')}
                      >
                        Close offer
                      </button>
                    ) : (
                      <span class="muted">Closed</span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </>
      )}
    </>
  );
}

// ---- Auctions ----

function AuctionRow({ vault }) {
  const { backend, snap, act, busy } = useApp();
  const [price, setPrice] = useState(null);
  const [address, setAddress] = useState(backend.btcAddressOfRole());
  useEffect(() => {
    Promise.resolve(backend.auctionPrice(vault.id)).then(setPrice);
  }, [snap, vault.id]);
  useEffect(() => setAddress(backend.btcAddressOfRole()), [snap.account]);

  const value = snap.btcPrice ? (Number(vault.deposit.sats) / SATS) * snap.btcPrice : null;

  const bid = () =>
    act(() => {
      let script;
      try {
        script = backend.scriptOf(address.trim());
      } catch (e) {
        return { ok: false, error: e.message };
      }
      return backend.bid(vault.id, (BigInt(price) * 101n) / 100n, script);
    }, 'You won. The Bitcoin is yours to sign out from the vault page.');

  return (
    <article class="auction">
      <div class="quote">
        <Stat label={`Vault #${vault.id}`} value={btc(vault.deposit.sats, 4)} note={value ? `Worth about ${dollars(value)}` : ''} />
        <Stat label="Current price" value={price ? usd(price) : 'Ended'} note={`Falling to ${usd(vault.loan.debt)}`} />
      </div>
      {price ? (
        <div class="form">
          <label>
            Your Bitcoin address
            <input class="mono" value={address} onInput={(e) => setAddress(e.currentTarget.value)} />
          </label>
          <button disabled={busy || !snap.account} onClick={bid}>
            Buy at this price
          </button>
        </div>
      ) : (
        <button
          disabled={busy}
          onClick={() => act(() => backend.claim(vault.id), 'No bids, so the coins go to the lender.')}
        >
          Send the coins to the lender
        </button>
      )}
    </article>
  );
}

export function Auctions() {
  const { backend, snap, act, busy } = useApp();
  const running = snap.vaults.filter((v) => v.status === 'auction');
  const overdue = snap.vaults.filter(
    (v) => v.status === 'borrowed' && snap.lightClientTip > v.loan.grace_end_height,
  );
  return (
    <>
      <p class="eyebrow">Auctions</p>
      <h1>Defaulted Bitcoin, sold by falling price</h1>
      <p class="lede">
        An auction opens only after a loan’s due date and grace period, never because of a price move. The price falls
        until someone buys. The lender is paid first, and everything above the debt goes back to the borrower.
      </p>

      <h2>Running now</h2>
      {running.length ? (
        running.map((v) => <AuctionRow key={v.id} vault={v} />)
      ) : (
        <p class="muted">No auctions are running.</p>
      )}

      {overdue.length > 0 && (
        <>
          <h2>Overdue loans</h2>
          <p>Anyone can start these auctions, and the endowment pays the keeper a small bounty in NEAR.</p>
          <table class="data">
            <tbody>
              {overdue.map((v) => (
                <tr key={v.id}>
                  <td class="mono">Vault #{v.id}</td>
                  <td class="mono">{usd(v.loan.debt)}</td>
                  <td>
                    <button
                      class="small"
                      disabled={busy}
                      onClick={() => act(() => backend.startAuction(v.id), 'The auction is running.')}
                    >
                      Start auction
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </>
      )}
    </>
  );
}

// ---- What NEAR gets ----

export function Near() {
  const { backend, snap, act, busy } = useApp();
  const e = snap.endowment;
  return (
    <>
      <p class="eyebrow">What NEAR gets</p>
      <h1>Every Bitcoin loan makes NEAR stronger.</h1>
      <p class="lede">
        Ripcord has no team, no token and no treasury key. A keyless endowment stakes its income with NEAR validators,
        and staking rewards pay the keepers who run it. It funds itself, and the principal stays staked for as long as
        the chain runs.
      </p>

      <section class="stats">
        <Stat label="Staked with validators" value={near(e.principal_staked)} note="Never unstaked" />
        <Stat label="Received in vault fees" value={near(e.total_received)} />
        <Stat label="Bought with interest" value={near(e.near_from_sales)} note={`From ${usd(e.usdc_sold)}`} />
        <Stat label="Keeper bounties paid" value={num(e.keeper_payments)} />
      </section>

      <h2>Four things NEAR gets</h2>
      <ol class="cards">
        <li>
          <h3>Staked NEAR that never leaves</h3>
          <p>
            Each vault pays {near(snap.config.vault_fee)}, and a share of all interest is sold for NEAR in an auction
            with no price feed. All of it is staked. Only rewards can ever come out.
          </p>
        </li>
        <li>
          <h3>Volume through Intents</h3>
          <p>
            Loan payouts and repayments can cross chains through NEAR Intents, and that flow pays into the fee switch
            that buys back NEAR.
          </p>
        </li>
        <li>
          <h3>Native Bitcoin in NEAR’s hands</h3>
          <p>
            Coins stay on Bitcoin but follow rules set by a NEAR contract. That is a new kind of value secured by NEAR,
            with nothing wrapped or bridged.
          </p>
        </li>
        <li>
          <h3>An open kit for builders</h3>
          <p>
            <code>near-btc-script</code> is a small open-source library for holding native Bitcoin under script rules
            from a NEAR contract. Any team can use it.
          </p>
        </li>
      </ol>

      <h2>Keep it moving</h2>
      <p>
        Anyone can run these. They can only sell the endowment’s dollars for NEAR and move NEAR into its one validator
        pool.
      </p>
      <div class="row">
        <button class="ghost" disabled={busy || !snap.account} onClick={() => act(() => backend.collectInterest(), 'Interest collected from Ripcord.')}>
          Collect interest
        </button>
        <button class="ghost" disabled={busy || !snap.account} onClick={() => act(() => backend.startSale(), 'The sale is running. Its rate falls until someone buys.')}>
          Start a sale
        </button>
        <button disabled={busy || !snap.account} onClick={() => act(() => backend.stakeEndowment(), 'Staked with the validator.')}>
          Stake what has arrived
        </button>
      </div>

      {e.sale && snap.saleRate && (
        <SaleBox sale={e.sale} rate={BigInt(snap.saleRate)} />
      )}

      <p class="muted small-note">Validator pool {short(e.pool, 20, 8)}</p>
    </>
  );
}

/** Sells the endowment's dollars for NEAR. The rate falls until someone takes it. */
function SaleBox({ sale, rate }) {
  const { backend, snap, act, busy } = useApp();
  const left = BigInt(sale.usdc_left);
  const nearPerDollar = Number((rate * BigInt(MICRO)) / 10n ** 21n) / 1000;
  return (
    <section class="ticket">
      <p class="eyebrow">Running sale</p>
      <h2>{usd(left)} for sale</h2>
      <p>
        Now {nearPerDollar.toLocaleString('en-US', { maximumFractionDigits: 3 })} NEAR per dollar, and falling. No price
        feed sets this: it drops until a buyer finds it worth taking.
      </p>
      <button
        disabled={busy || !snap.account}
        onClick={() => act(() => backend.buyUsdc(left * rate), 'Bought. That NEAR is now on its way to a validator.')}
      >
        Buy all of it
      </button>
    </section>
  );
}
