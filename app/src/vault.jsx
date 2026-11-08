import { useEffect, useState } from 'preact/hooks';
import {
  buildSpend,
  bytesToHex,
  hexToBytes,
  parseVaultScript,
  publicKeyOf,
  signOwnerPath,
  txid as txidOf,
  vaultSpendVbytes,
} from '@tools/lib/btc-core.mjs';
import { btc, download, hoursFromBlocks, MICRO, num, percent, short, usd, useApp } from './lib.js';
import { looksLikeAddress, USDC_ROUTES } from '@tools/lib/oneclick.mjs';
import { ChainPicker, RepayFromChain, Schedule, TransfersFor, WhereMoney } from './transfers.jsx';
import { VaultActivity } from './activity.jsx';
import { Locks, offerRows, Stat, statusLabel, Step } from './pages.jsx';
import { recall, remember } from './keys.js';

/** Bitcoin blocks as a strip: where you are, and what opens when. */
function Tape({ vault, tip, params }) {
  const { loan, escape_height: escape } = vault;
  const auctionEnd = loan ? loan.grace_end_height + params.start_window_blocks + params.auction_blocks : null;
  const start = Math.min(tip, loan ? loan.due_height : tip) - Math.max(6, Math.round((escape - tip) * 0.05));
  const end = Math.max(escape, tip) + Math.max(6, Math.round((escape - start) * 0.12));
  const pos = (h) => Math.min(100, Math.max(0, ((h - start) / (end - start)) * 100));
  const at = (h) => `${pos(h)}%`;

  const marks = [
    ...(loan
      ? [
          { h: loan.due_height, label: 'Loan due' },
          { h: loan.grace_end_height, label: 'Grace ends' },
        ]
      : []),
    { h: escape, label: 'Ripcord opens', strong: true },
  ];

  return (
    <figure class="tape" aria-label={`Bitcoin block ${tip}. Escape opens at block ${escape}.`}>
      <div class="tape-track">
        <div class="zone safe" style={{ left: 0, width: at(loan ? loan.grace_end_height : escape) }} />
        {loan && (
          <div
            class="zone sale"
            style={{
              left: at(loan.grace_end_height),
              width: `calc(${at(auctionEnd)} - ${at(loan.grace_end_height)})`,
            }}
          />
        )}
        <div class="zone free" style={{ left: at(escape), right: 0 }} />
        <div class="now" style={{ left: at(tip) }}>
          <span>Block {num(tip)}</span>
        </div>
      </div>
      <div class="tape-marks">
        {marks.map((m, i) => (
          <div
            key={m.label}
            class={`mark ${m.strong ? 'strong' : ''} ${i > 0 && pos(m.h) - pos(marks[i - 1].h) < 14 ? 'low' : ''}`}
            style={{ left: at(m.h) }}
          >
            <i />
            <b>{m.label}</b>
            <span class="mono">{num(m.h)}</span>
          </div>
        ))}
      </div>
    </figure>
  );
}

/** Decodes the script here, in the browser, instead of trusting anyone's description. */
function ScriptCheck({ vault }) {
  const { backend } = useApp();
  if (!vault.witness_script) return null;
  try {
    const script = hexToBytes(vault.witness_script);
    const { signerPub, ownerPub, escapeHeight } = parseVaultScript(script);
    const same = backend.vaultAddressOf(script) === vault.address;
    return (
      <details class="check">
        <summary>{same ? 'Checked in your browser: this address enforces the two locks' : 'WARNING: address does not match its script'}</summary>
        <pre class="script">
          {`OP_IF
    ${short(bytesToHex(signerPub), 10, 8)} OP_CHECKSIG          the contract, through MPC
OP_ELSE
    ${escapeHeight} OP_CHECKLOCKTIMEVERIFY OP_DROP
    ${short(bytesToHex(ownerPub), 10, 8)} OP_CHECKSIG          you, alone, after that block
OP_ENDIF`}
        </pre>
      </details>
    );
  } catch (e) {
    return <p class="bad-text">This vault’s script failed the check: {e.message}</p>;
  }
}

function Deposit({ vault }) {
  const { backend, act, busy } = useApp();
  const [sent, setSent] = useState(false);
  const note = recall(backend.kind, vault.id);
  const amount = Number(note.plannedSats ?? vault.expected_sats);
  return (
    <>
      <Step n="1" title="Save your recovery key">
        <p>
          This key is your half of the vault. It never leaves this browser. Keep a copy somewhere safe: it is what opens
          lock 2.
        </p>
        {note.secret ? (
          <button
            class="ghost"
            onClick={() =>
              download(
                `ripcord-vault-${vault.id}-recovery-key.txt`,
                `Ripcord vault ${vault.id}\nAddress ${vault.address}\nEscape block ${vault.escape_height}\nRecovery key ${note.secret}\n`,
              )
            }
          >
            Download recovery key
          </button>
        ) : (
          <p class="muted">The key for this vault is not in this browser.</p>
        )}
      </Step>
      <Step n="2" title={`Send at least ${btc(vault.expected_sats, 8)} to your vault`}>
        <code class="address">{vault.address}</code>
        <ScriptCheck vault={vault} />
        {backend.kind === 'sim' ? (
          <button
            disabled={busy || sent}
            onClick={async () => {
              await act(() => backend.sendDeposit(vault, amount), 'Sent, and confirmed by three blocks.');
              setSent(true);
            }}
          >
            Send from the simulated wallet
          </button>
        ) : (
          <p class="muted">Send from any Bitcoin wallet, then wait for confirmations.</p>
        )}
      </Step>
      <Step n="3" title="Prove the deposit" active={sent || backend.kind !== 'sim'}>
        <p>
          A Merkle proof goes to the Bitcoin light client on NEAR. Anyone can submit it, and it either holds or it does
          not.
        </p>
        <button
          disabled={busy || (backend.kind === 'sim' && !sent)}
          onClick={() => act(() => backend.proveDeposit(vault), 'Deposit proven on NEAR.')}
        >
          Submit proof
        </button>
      </Step>
    </>
  );
}

function BorrowPanel({ vault }) {
  const { backend, snap, act, busy } = useApp();
  const offers = offerRows(snap.offers);
  const note = recall(backend.kind, vault.id);
  const [offerId, setOfferId] = useState(note.offerId ?? offers[0]?.id);
  const offer = offers.find((o) => o.id === offerId) ?? offers[0];
  const max = offer
    ? (BigInt(vault.deposit.sats) * BigInt(offer.micro_usdc_per_btc)) / 100_000_000n
    : 0n;
  const limit = offer && max > BigInt(offer.available) ? BigInt(offer.available) : max;
  const [amount, setAmount] = useState('');
  const dollarsWanted = amount === '' ? Number(limit) / MICRO : Number(amount);
  // The contract knows no price, so the borrower names this. Three times today's price
  // leaves room for the coins to find their value if the loan ever defaults.
  const reference = snap.btcPrice ?? (2 * Number(offer?.micro_usdc_per_btc ?? 0)) / MICRO;
  const suggested = Math.round(reference * 3);
  const [openPrice, setOpenPrice] = useState('');
  const opening = openPrice === '' ? suggested : Number(openPrice);
  const [dest, setDest] = useState({ routeId: 'near', recipient: '' });
  const route = USDC_ROUTES.find((r) => r.id === dest.routeId);
  const blocked = route && (backend.intentsMode === 'none' || !looksLikeAddress(route, dest.recipient));

  return (
    <Step n="4" title="Borrow">
      <div class="form">
        <label>
          Offer
          <select value={offer?.id} onChange={(e) => setOfferId(e.currentTarget.value)}>
            {offers.map((o) => (
              <option key={o.id} value={o.id}>
                {usd(o.micro_usdc_per_btc, 0)} per BTC, {percent(o.apr_bps)}, {num(o.term_blocks)} blocks
              </option>
            ))}
          </select>
        </label>
        <label>
          Dollars (up to {usd(limit)})
          <input
            inputMode="decimal"
            value={amount === '' ? (Number(limit) / MICRO).toFixed(2) : amount}
            onInput={(e) => setAmount(e.currentTarget.value)}
          />
        </label>
        <label>
          If you default, the auction opens at this price per BTC
          <input
            inputMode="decimal"
            value={openPrice === '' ? String(suggested) : openPrice}
            onInput={(e) => setOpenPrice(e.currentTarget.value)}
            aria-describedby="open-price-help"
          />
        </label>
        <p id="open-price-help" class="muted">
          It falls from here to your debt, and you keep whatever it sells for above the debt. Set it above anything a
          bitcoin could be worth by then. Too low could sell your coins cheaply. Far too high leaves bidders little
          time near the real price.
        </p>
        <ChainPicker micro={BigInt(Math.floor((dollarsWanted || 0) * MICRO))} value={dest} onChange={setDest} />
        <button
          disabled={busy || !offer || blocked}
          onClick={() =>
            act(() => {
              const terms = {
                vaultId: vault.id,
                offerId: offer.id,
                principal: BigInt(Math.floor(dollarsWanted * MICRO)),
                auctionOpenPerBtc: BigInt(Math.round((opening || 0) * MICRO)),
              };
              return route ? backend.sendTo({ ...terms, route, recipient: dest.recipient }) : backend.borrow({ ...terms, payoutTo: snap.account });
            }, route ? `Borrowed. NEAR Intents is taking the dollars to ${route.label}. The Bitcoin has not moved.` : 'Dollars sent. The Bitcoin has not moved.')
          }
        >
          {route ? `Borrow and send to ${route.label}` : 'Borrow'}
        </button>
      </div>
    </Step>
  );
}

function Destination({ value, onInput }) {
  return (
    <label>
      Bitcoin address to receive the coins
      <input class="mono" value={value} onInput={(e) => onInput(e.currentTarget.value)} />
    </label>
  );
}

function EscapeTicket({ vault }) {
  const { backend, snap, busy, refresh, setNotice } = useApp();
  const note = recall(backend.kind, vault.id);
  const [to, setTo] = useState(note.ticketTo ?? backend.btcAddressOfRole());
  const [ticket, setTicket] = useState(note.ticket ?? null);
  const [fee, setFee] = useState('400');
  const [keyText, setKeyText] = useState(note.secret ?? '');

  const make = () => {
    try {
      const secret = hexToBytes(keyText.trim());
      const script = hexToBytes(vault.witness_script);
      if (bytesToHex(publicKeyOf(secret)) !== bytesToHex(parseVaultScript(script).ownerPub)) {
        throw new Error('That key does not open this vault.');
      }
      const tx = buildSpend({
        txid: vault.deposit.txid,
        vout: vault.deposit.vout,
        value: Number(vault.deposit.sats),
        destination: hexToBytes(backend.scriptOf(to.trim())),
        feeSats: fee,
        lockTime: vault.escape_height,
      });
      const raw = bytesToHex(signOwnerPath(tx, script, Number(vault.deposit.sats), secret));
      const made = { raw, txid: txidOf(tx), to: to.trim(), fee };
      setTicket(made);
      remember(backend.kind, vault.id, { ticket: made, ticketTo: to.trim() });
      setNotice({ ok: true, text: 'Ticket signed. Keep it safe. It can only pay the address you chose.' });
    } catch (e) {
      setNotice({ ok: false, text: e.message });
    }
  };

  const text = () =>
    `RIPCORD ESCAPE TICKET\n\nVault ${vault.id}\nPays ${ticket.to}\nValid after Bitcoin block ${vault.escape_height}\nTransaction ${ticket.txid}\n\nBroadcast this from any Bitcoin node or block explorer once that block has passed.\nIt needs nothing else: no account, no website and no other chain.\n\n${ticket.raw}\n`;

  const open = snap.tip >= vault.escape_height;

  return (
    <section class="ticket">
      <p class="eyebrow">Your ripcord</p>
      <h2>Escape ticket</h2>
      {ticket ? (
        <>
          <p>
            A finished Bitcoin transaction, signed by you and valid after block {num(vault.escape_height)}. Anyone can
            broadcast it. Bitcoin refuses it until then, whatever happens anywhere else.
          </p>
          <textarea class="mono" readOnly rows={4} value={ticket.raw} aria-label="Signed transaction" />
          <div class="row">
            <button class="ghost" onClick={() => download(`ripcord-escape-ticket-vault-${vault.id}.txt`, text())}>
              Download ticket
            </button>
            <button
              class="pull"
              disabled={busy}
              onClick={async () => {
                const r = await backend.broadcast(ticket.raw);
                if (r.ok) setNotice({ ok: true, text: `Bitcoin accepted it. Coins are on the way to ${short(ticket.to)}.` });
                else setNotice({ ok: false, text: `Bitcoin refused it: ${r.error}` });
                refresh();
              }}
            >
              {open ? 'Pull the ripcord' : 'Try it now'}
            </button>
          </div>
        </>
      ) : (
        <>
          <p>
            Sign your own exit now, while everything works. It is a Bitcoin transaction you keep, valid after block{' '}
            {num(vault.escape_height)}.
          </p>
          <div class="form">
            <Destination value={to} onInput={setTo} />
            <label>
              Fee, in sats
              <input inputMode="numeric" value={fee} onInput={(e) => setFee(e.currentTarget.value)} />
            </label>
            {!note.secret && (
              <label>
                Recovery key
                <input class="mono" value={keyText} onInput={(e) => setKeyText(e.currentTarget.value)} />
              </label>
            )}
            <button onClick={make}>Sign my escape ticket</button>
          </div>
        </>
      )}
    </section>
  );
}

function Settling({ vault }) {
  const { backend, snap, act, busy, refresh, setNotice } = useApp();
  const mine = vault.beneficiary === snap.account;
  const [fee, setFee] = useState('500');
  const size = vaultSpendVbytes(hexToBytes(vault.destination));
  const why = {
    Released: 'The vault owner is taking the coins back.',
    AuctionWon: 'An auction winner bought the coins.',
    NoBids: 'The auction ended with no bids, so the coins go to the lender.',
    LateClaim: 'Nobody started the auction in time, so the coins go straight to the lender.',
  }[vault.settle_reason];

  return (
    <section class="ticket">
      <p class="eyebrow">Settling</p>
      <h2>These coins have one destination now</h2>
      <p>
        {why} They go to <code>{short(backend.addressOf(vault.destination), 14, 8)}</code>, and nothing can change that.
      </p>
      {vault.signed_tx ? (
        <>
          <p>
            Signed by NEAR’s MPC network. Anyone can broadcast this. Transaction <code>{short(vault.signed_txid)}</code>
          </p>
          <button
            disabled={busy}
            onClick={async () => {
              const r = await backend.broadcast(vault.signed_tx);
              if (r.ok) setNotice({ ok: true, text: 'Bitcoin accepted the transaction.' });
              else setNotice({ ok: false, text: `Bitcoin refused it: ${r.error}` });
              refresh();
            }}
          >
            Broadcast to Bitcoin
          </button>
        </>
      ) : mine ? (
        <div class="form">
          <label>
            Bitcoin fee in sats, about {Math.round(Number(fee) / size)} sat/vB
            <input inputMode="numeric" value={fee} onInput={(e) => setFee(e.currentTarget.value)} />
          </label>
          <button disabled={busy} onClick={() => act(() => backend.requestSignature(vault.id, fee), 'Signed by the MPC network.')}>
            Ask the signers to sign
          </button>
        </div>
      ) : (
        <p class="muted">Only {vault.beneficiary} can choose the fee and request the signature.</p>
      )}
    </section>
  );
}

export function VaultPage({ id }) {
  const { backend, snap, act, busy } = useApp();
  const vault = snap.vaults.find((v) => v.id === id);
  const [destination, setDestination] = useState(backend.btcAddressOfRole());
  useEffect(() => setDestination(backend.btcAddressOfRole()), [snap.account]);

  if (!vault) {
    return (
      <>
        <h1>No such vault</h1>
        <a href="#/borrow">Back to borrowing</a>
      </>
    );
  }

  const { params } = snap.config;
  const isOwner = vault.owner === snap.account;
  const value = vault.deposit && snap.btcPrice ? (Number(vault.deposit.sats) / 100_000_000) * snap.btcPrice : null;

  return (
    <>
      <p class="eyebrow">Vault #{vault.id}</p>
      <h1>{statusLabel(vault.status)}</h1>

      <Tape vault={vault} tip={snap.tip} params={params} />

      <section class="stats">
        <Stat
          label="Bitcoin"
          value={vault.deposit ? btc(vault.deposit.sats, 6) : 'None yet'}
          note={value ? `Worth about $${Math.round(value).toLocaleString('en-US')} today` : 'Stays on Bitcoin'}
        />
        <Stat label="Debt" value={vault.loan ? usd(vault.loan.debt) : 'None'} note={vault.loan ? `Due at block ${num(vault.loan.due_height)}` : ''} />
        <Stat label="Your exit" value={`Block ${num(vault.escape_height)}`} note={hoursFromBlocks(Math.max(0, vault.escape_height - snap.tip))} />
      </section>

      <WhereMoney vault={vault} />
      <TransfersFor vault={vault} />

      <Locks vault={vault} />
      {vault.status !== 'awaiting_deposit' && <ScriptCheck vault={vault} />}

      {vault.status === 'awaiting_deposit' && (isOwner ? <Deposit vault={vault} /> : <p class="muted">Waiting for the owner’s deposit.</p>)}

      {vault.status === 'funded' && isOwner && (
        <>
          <BorrowPanel vault={vault} />
          <Step n="5" title="Or take your Bitcoin back">
            <div class="form">
              <Destination value={destination} onInput={setDestination} />
              <button
                class="ghost"
                disabled={busy}
                onClick={() =>
                  act(() => {
                    try {
                      return backend.release(vault.id, backend.scriptOf(destination.trim()));
                    } catch (e) {
                      return { ok: false, error: e.message };
                    }
                  }, 'Released. Now ask the signers to sign.')
                }
              >
                Release the coins
              </button>
            </div>
          </Step>
        </>
      )}

      {vault.status === 'borrowed' && (
        <section class="ticket">
          <p class="eyebrow">Loan</p>
          <h2>
            {usd(vault.loan.principal)} borrowed. {usd(vault.loan.debt)} repays it.
          </h2>
          <p>
            No price can touch this loan. The only date that matters is block {num(vault.loan.grace_end_height)}, when
            the grace period ends. Anyone can repay, from any account. If it goes unpaid, your Bitcoin goes to auction,
            opening at {usd(vault.loan.auction_start)} and falling to your debt. You keep whatever it sells for above
            the debt.
          </p>
          <RepayFromChain vault={vault} />
          <button disabled={busy} onClick={() => act(() => backend.repay(vault), 'Repaid. Your Bitcoin is free again.')}>
            Repay {usd(vault.loan.debt)}
          </button>
        </section>
      )}

      {vault.status === 'auction' && (
        <p class="callout">
          This loan went past its grace period, so its Bitcoin is in auction. <a href="#/auctions">See the auction</a>
        </p>
      )}

      {vault.status === 'settling' && <Settling vault={vault} />}

      {vault.status !== 'deriving' && <Schedule vault={vault} tip={snap.tip} params={params} />}

      {vault.deposit && vault.status !== 'settling' && isOwner && <EscapeTicket vault={vault} />}

      <VaultActivity vault={vault} />
    </>
  );
}
