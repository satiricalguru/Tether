import { hostMatches } from '@/lib/settings';

/**
 * Where the agent may go. Phase 4 covers navigation; Phase 5 adds action
 * tiers (read / navigate / write / irreversible) and confirmations.
 *
 * Default-deny: sites where a confused or manipulated agent could do real
 * harm. The user can allow a host explicitly (with a loud warning in the
 * UI); a user block always wins.
 */

export interface DefaultRule {
  pattern: string;
  category: 'banking' | 'payments' | 'government' | 'email';
}

const BANKS = [
  'chase.com',
  'bankofamerica.com',
  'wellsfargo.com',
  'citi.com',
  'citibank.com',
  'usbank.com',
  'capitalone.com',
  'pnc.com',
  'schwab.com',
  'fidelity.com',
  'vanguard.com',
  'americanexpress.com',
  'discover.com',
  'ally.com',
  'hsbc.com',
  'barclays.co.uk',
  'lloydsbank.com',
  'natwest.com',
  'santander.com',
  'bnpparibas.com',
  'deutsche-bank.de',
  'ing.com',
  'revolut.com',
  'monzo.com',
  'n26.com',
  'hdfcbank.com',
  'icicibank.com',
  'onlinesbi.sbi',
  'axisbank.com',
  'kotak.com',
  'rbc.com',
  'td.com',
  'scotiabank.com',
  'commbank.com.au',
  'westpac.com.au',
  'anz.com',
];
const PAYMENTS = [
  'paypal.com',
  'venmo.com',
  'stripe.com',
  'squareup.com',
  'wise.com',
  'cash.app',
  'zellepay.com',
  'paytm.com',
  'phonepe.com',
  'razorpay.com',
  'coinbase.com',
  'binance.com',
  'kraken.com',
  'robinhood.com',
];
const EMAIL = [
  'mail.google.com',
  'outlook.live.com',
  'outlook.office.com',
  'outlook.office365.com',
  'mail.yahoo.com',
  'mail.proton.me',
  'mail.aol.com',
  'mail.zoho.com',
  'fastmail.com',
];

export const DEFAULT_BLOCKS: DefaultRule[] = [
  ...BANKS.map((d) => ({ pattern: `*.${d}`, category: 'banking' as const })),
  ...PAYMENTS.map((d) => ({ pattern: `*.${d}`, category: 'payments' as const })),
  ...EMAIL.map((d) => ({ pattern: d, category: 'email' as const })),
];

const GOV =
  /(^|\.)(gov|mil)(\.[a-z]{2})?$|(^|\.)gov\.[a-z]{2,3}$|(^|\.)gc\.ca$|(^|\.)gouv\.fr$|(^|\.)bund\.de$|(^|\.)nic\.in$/i;
const BANK_LABEL = /(^|\.)(online|net|e|internet|mobile)?banking\.|(^|\.)bank$/i;

export type UrlVerdict =
  | { allowed: true }
  | { allowed: false; reason: string; category?: DefaultRule['category'] | 'scheme' | 'user' };

export interface DomainPolicy {
  allowDomains: string[];
  blockDomains: string[];
}

function category(host: string): DefaultRule['category'] | undefined {
  if (GOV.test(host)) return 'government';
  if (BANK_LABEL.test(host)) return 'banking';
  return DEFAULT_BLOCKS.find((r) => hostMatches(r.pattern, host))?.category;
}

export function checkUrl(raw: string, policy: DomainPolicy): UrlVerdict {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return { allowed: false, reason: `"${raw}" is not a valid URL`, category: 'scheme' };
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    return {
      allowed: false,
      reason: `Only http(s) pages are allowed, not ${url.protocol}`,
      category: 'scheme',
    };
  }
  const host = url.hostname;
  if (
    policy.blockDomains.some(
      (p) => hostMatches(p, host) || hostMatches(`*.${p.replace(/^\*\./, '')}`, host),
    )
  ) {
    return { allowed: false, reason: `${host} is on your blocked list`, category: 'user' };
  }
  const cat = category(host);
  if (
    cat &&
    !policy.allowDomains.some(
      (p) => hostMatches(p, host) || hostMatches(`*.${p.replace(/^\*\./, '')}`, host),
    )
  ) {
    return {
      allowed: false,
      reason: `${host} looks like a ${cat === 'email' ? 'webmail' : cat} site; the agent doesn't go there unless you allow it in settings`,
      category: cat,
    };
  }
  return { allowed: true };
}

/** Bare domains from the model ("example.com/x") get https://. */
export function normalizeAgentUrl(raw: string): string {
  const s = raw.trim();
  if (/^[a-z][a-z0-9+.-]*:/i.test(s)) return s;
  return `https://${s.replace(/^\/+/, '')}`;
}
