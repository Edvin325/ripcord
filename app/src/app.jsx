import { useCallback, useEffect, useMemo, useState } from 'preact/hooks';
import { SimBackend, ROLES } from './backend/sim.js';
import { LiveBackend } from './backend/live.js';
import deployment from './deployment.json';
import { Ctx, go, num, plainError, useApp, useRoute } from './lib.js';
import { Borrow, Auctions, Home, Lend, Near } from './pages.jsx';
import { VaultPage } from './vault.jsx';
import { SwitchOff } from './switchoff.jsx';
import { HistoryPage } from './activity.jsx';

const NAV = [
  ['borrow', 'Borrow'],
  ['lend', 'Lend'],
  ['auctions', 'Auctions'],
  ['history', 'History'],
  ['switch', 'Try to switch it off'],
  ['near', 'What NEAR gets'],
];

export function Handle({ size = 28 }) {
  return (
    <svg width={size} height={size} viewBox="0 0 32 32" aria-hidden="true">
      <path d="M16 3v10" stroke="currentColor" stroke-width="3" />
      <path d="M8 13h16l-2.5 14h-11z" fill="none" stroke="currentColor" stroke-width="3" stroke-linejoin="round" />
    </svg>
  );
}

function Header() {
  const { backend, snap, networks, setNetwork, route } = useApp();
  return (
    <header class="top">
      <a class="brand" href="#/">
        <Handle /> <span>Ripcord</span>
      </a>
      <nav aria-label="Main">
        {NAV.map(([path, label]) => (
          <a key={path} href={`#/${path}`} class={route[0] === path ? 'on' : ''}>
            {label}
          </a>
        ))}
      </nav>
      <div class="net">
        {networks.length > 1 ? (
          <select
            aria-label="Network"
            value={backend.kind}
            onChange={(e) => setNetwork(e.currentTarget.value)}
          >
            {networks.map((n) => (
              <option key={n.kind} value={n.kind}>
                {n.label}
              </option>
            ))}
          </select>
        ) : (
          <span class="pill">{backend.label}</span>
        )}
        {backend.usesWallet &&
          (snap?.account ? (
            <button class="ghost" onClick={() => backend.disconnect()}>
              {snap.account}
            </button>
          ) : (
            <button onClick={() => backend.connect()}>Connect wallet</button>
          ))}
      </div>
    </header>
  );
}

/** Time, identity and failure, all in the visitor's hands. Simulator only. */
function ControlTower() {
  const { backend, snap, act, refresh } = useApp();
  if (backend.kind !== 'sim' || !snap) return null;
  const tower = (fn) => () => {
    fn();
    refresh();
  };
  return (
    <aside class="tower" aria-label="Simulator controls">
      <div class="tower-group">
        <span class="tower-label">Bitcoin block</span>
        <b class="mono">{num(snap.tip)}</b>
        <button class="ghost small" onClick={tower(() => backend.mine(1))}>
          Mine 1
        </button>
        <button class="ghost small" onClick={tower(() => backend.mine(10))}>
          Mine 10
        </button>
      </div>
      <div class="tower-group">
        <span class="tower-label">NEAR clock</span>
        <button class="ghost small" onClick={tower(() => backend.advance(1800))}>
          +30 min
        </button>
      </div>
      <div class="tower-group">
        <span class="tower-label">You are</span>
        <select
          aria-label="Act as"
          value={snap.account}
          onChange={(e) => {
            backend.setRole(e.currentTarget.value);
            refresh();
          }}
        >
          {ROLES.map((r) => (
            <option key={r.id} value={r.id}>
              {r.label}
            </option>
          ))}
        </select>
      </div>
      <div class="tower-group">
        <span class="tower-label">Intents</span>
        <select
          aria-label="What the simulated NEAR Intents does next"
          value={backend.intents.state.outcome}
          onChange={(e) => {
            backend.setIntentsOutcome(e.currentTarget.value);
            refresh();
          }}
        >
          <option value="deliver">Delivers</option>
          <option value="refund">Refunds</option>
          <option value="fail">Fails</option>
        </select>
      </div>
      <div class="tower-group">
        <span class="tower-label">BTC price</span>
        <b class="mono">${num(snap.btcPrice)}</b>
        <button class="ghost small" onClick={tower(() => backend.setPrice(Math.round(snap.btcPrice / 2)))}>
          Crash 50%
        </button>
      </div>
      <button
        class="ghost small"
        onClick={() => act(() => (backend.reset(), { ok: true }), 'The simulation has been reset.')}
      >
        Reset
      </button>
    </aside>
  );
}

function Notice() {
  const { notice, setNotice } = useApp();
  if (!notice) return null;
  return (
    <div class={`notice ${notice.ok ? 'good' : 'bad'}`} role="status">
      <span>{notice.text}</span>
      <button class="ghost small" onClick={() => setNotice(null)}>
        Dismiss
      </button>
    </div>
  );
}

export function App() {
  const route = useRoute();
  const [sim, setSim] = useState(null);
  const [backend, setBackend] = useState(null);
  const [snap, setSnap] = useState(null);
  const [tick, setTick] = useState(0);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState(null);
  const [failure, setFailure] = useState(null);

  const refresh = useCallback(() => setTick((t) => t + 1), []);

  const live = useMemo(() => (deployment.live ? new LiveBackend(deployment.live) : null), []);

  useEffect(() => {
    SimBackend.create()
      .then((s) => {
        setSim(s);
        setBackend((b) => b ?? s);
      })
      .catch((e) => setFailure(e.message));
  }, []);

  useEffect(() => {
    if (live) live.onAccountChange = refresh;
  }, [live, refresh]);

  useEffect(() => {
    if (!backend) return undefined;
    let stale = false;
    backend
      .snapshot()
      .then((s) => !stale && setSnap(s))
      .catch((e) => !stale && setNotice({ ok: false, text: e.message }));
    return () => {
      stale = true;
    };
  }, [backend, tick]);

  // Live data moves on its own. Nothing here is a server: it is the same public reads.
  useEffect(() => {
    if (backend?.kind !== 'live') return undefined;
    const id = setInterval(refresh, 20_000);
    return () => clearInterval(id);
  }, [backend, refresh]);

  /** Runs an action, reports the outcome in plain words and refreshes every page. */
  const act = useCallback(
    async (fn, success) => {
      setBusy(true);
      setNotice(null);
      try {
        const r = await fn();
        if (r && r.ok === false) setNotice({ ok: false, text: plainError(r.error) });
        else if (success) setNotice({ ok: true, text: success });
        return r;
      } catch (e) {
        setNotice({ ok: false, text: plainError(e.message) });
        return { ok: false, error: e.message };
      } finally {
        setBusy(false);
        refresh();
      }
    },
    [refresh],
  );

  const networks = [sim, live].filter(Boolean);
  const setNetwork = (kind) => {
    setSnap(null);
    setBackend(networks.find((n) => n.kind === kind));
  };

  if (failure) {
    return (
      <main class="page">
        <h1>The simulator could not start</h1>
        <p>{failure}</p>
      </main>
    );
  }
  if (!backend || !snap) {
    return (
      <main class="page">
        <p class="eyebrow">Loading the contracts into this page</p>
      </main>
    );
  }

  const [page, arg] = route;
  const body = {
    '': <Home />,
    borrow: <Borrow />,
    lend: <Lend />,
    auctions: <Auctions />,
    history: <HistoryPage />,
    switch: <SwitchOff />,
    near: <Near />,
    vault: <VaultPage id={arg} />,
  }[page] ?? <Home />;

  return (
    <Ctx.Provider value={{ backend, snap, act, busy, refresh, notice, setNotice, networks, setNetwork, route, go }}>
      <Header />
      {backend.kind === 'sim' && (
        <p class="simbar">
          Simulator. The real compiled contracts run in this browser tab. Bitcoin, the signer network and test dollars
          are simulated. Nothing here costs anything.
        </p>
      )}
      <Notice />
      <main class="page">{body}</main>
      <footer class="foot">
        <p>
          Unaudited hackathon software. Built at NEAR HACKATHON. Testnet only, unless a page says otherwise. Not
          financial advice.
        </p>
      </footer>
      <ControlTower />
    </Ctx.Provider>
  );
}
