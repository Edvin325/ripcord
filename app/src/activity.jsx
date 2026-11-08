// The history of what was done here, with explorer links for every step that has one.

import { historyOf } from './history.js';
import { usd, useApp } from './lib.js';

function Rows({ entries, showVault }) {
  return (
    <div class="scroll">
      <table class="data history">
        <thead>
          <tr>
            <th scope="col">When</th>
            <th scope="col">What happened</th>
            {showVault && <th scope="col">Vault</th>}
            <th scope="col">Amount</th>
            <th scope="col">Look it up</th>
          </tr>
        </thead>
        <tbody>
          {entries.map((e, i) => (
            <tr key={`${e.at}-${i}`}>
              <td class="mono">{new Date(e.at).toLocaleTimeString()}</td>
              <td>{e.action}</td>
              {showVault && <td class="mono">{e.vault !== undefined && e.vault !== null ? <a href={`#/vault/${e.vault}`}>#{e.vault}</a> : ''}</td>}
              <td class="mono">{e.amount ? usd(e.amount) : ''}</td>
              <td>
                {e.links.filter((l) => l.url).map((l) => (
                  <a key={l.url} href={l.url} target="_blank" rel="noreferrer" class="link-chip">
                    {l.label}
                  </a>
                ))}
                {e.links.every((l) => !l.url) && <span class="muted">{e.simulated ? 'Simulated' : ''}</span>}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function HistoryPage() {
  const { backend } = useApp();
  const entries = historyOf(backend.kind);
  return (
    <>
      <p class="eyebrow">History</p>
      <h1>What happened, step by step</h1>
      <p class="lede">
        Every loan, repayment, transfer and Bitcoin spend made from this browser.{' '}
        {backend.kind === 'sim'
          ? 'In the simulator nothing is on a real chain, so there is nothing to look up.'
          : 'Each step links to a block explorer, so you can check it there.'}
      </p>
      {entries.length ? <Rows entries={entries} showVault /> : <p class="muted">Nothing yet. Open a vault or make an offer, and each step appears here.</p>}
    </>
  );
}

/** The same history, for one vault. */
export function VaultActivity({ vault }) {
  const { backend } = useApp();
  const entries = historyOf(backend.kind).filter((e) => e.vault === vault.id);
  if (!entries.length) return null;
  return (
    <section aria-label="Activity">
      <h2>Activity</h2>
      <Rows entries={entries} />
    </section>
  );
}
