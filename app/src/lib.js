// Formatting and small shared hooks.

import { createContext } from 'preact';
import { useContext, useEffect, useState } from 'preact/hooks';

export const Ctx = createContext(null);
export const useApp = () => useContext(Ctx);

export const SATS = 100_000_000;
export const MICRO = 1_000_000;

export function usd(micro, digits = 2) {
  const n = Number(micro) / MICRO;
  return `$${n.toLocaleString('en-US', { minimumFractionDigits: digits, maximumFractionDigits: digits })}`;
}

export function dollars(n, digits = 0) {
  return `$${Number(n).toLocaleString('en-US', { minimumFractionDigits: digits, maximumFractionDigits: digits })}`;
}

export function btc(sats, digits = 8) {
  return `${(Number(sats) / SATS).toFixed(digits)} BTC`;
}

export function num(n) {
  return Number(n).toLocaleString('en-US');
}

export function near(yocto, digits = 2) {
  const whole = Number(BigInt(yocto) / 10n ** 18n) / 1e6;
  return `${whole.toLocaleString('en-US', { maximumFractionDigits: digits })} NEAR`;
}

export const percent = (bps) => `${(bps / 100).toLocaleString('en-US', { maximumFractionDigits: 2 })}%`;

export function short(text, head = 8, tail = 6) {
  if (!text) return '';
  return text.length <= head + tail + 1 ? text : `${text.slice(0, head)}…${text.slice(-tail)}`;
}

export function hoursFromBlocks(blocks) {
  const h = (Number(blocks) * 10) / 60;
  if (h < 48) return `about ${Math.round(h * 10) / 10} hours`;
  return `about ${Math.round(h / 24)} days`;
}

/** Saves text as a file. Used for keys and tickets, which never leave this browser. */
export function download(name, text) {
  const url = URL.createObjectURL(new Blob([text], { type: 'text/plain' }));
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  a.click();
  URL.revokeObjectURL(url);
}

export function useRoute() {
  const read = () => (location.hash.replace(/^#\/?/, '') || '').split('/');
  const [route, setRoute] = useState(read());
  useEffect(() => {
    const on = () => {
      setRoute(read());
      window.scrollTo(0, 0);
    };
    window.addEventListener('hashchange', on);
    return () => window.removeEventListener('hashchange', on);
  }, []);
  return route;
}

export const go = (path) => {
  location.hash = `/${path}`;
};

/** Reads why a contract refused something, without the runtime's wrapping. */
export function plainError(error) {
  if (!error) return 'Refused.';
  const text = String(error);
  const known = {
    OverLtv: 'That is more than this offer lends against your Bitcoin.',
    TimelineTooTight: 'This loan would not finish before your vault’s escape block. Choose a shorter offer or open a longer vault.',
    InsufficientOfferFunds: 'This offer does not have that much left.',
    ZeroPrincipal: 'Enter an amount to borrow.',
    CollateralTooSmall: 'This deposit is below the minimum.',
  };
  for (const [k, v] of Object.entries(known)) if (text.includes(k)) return v;
  return text.replace(/^Smart contract panicked: /, '');
}
