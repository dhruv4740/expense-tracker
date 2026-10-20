// ─── IPO tracker (pure) ──────────────────────────────────────────────────────
//
// IPO traffic is informational: UPI-IPO mandate block/revoke/unblock, KFin /
// Link Intime / MUFG "unblock … non-allotment", BSE/NSE application and
// allotment notices, HDFC Sec confirmations, CDSL share credits. None of it is
// a transaction (the parser's negative guards drop it). The ONE message that
// moves money is the bank's final debit on allotment; that row is categorised
// Investment (isIpoDebit) and counted, nothing else is.
//
// Events are matched to an issuer by a short name key, since each sender spells
// the company differently (ZETWERK / ZETWERK MANUFACTURING BUSINESSES LIMITED).

export type IpoEventKind = 'applied' | 'blocked' | 'revoked' | 'unblocked' | 'not_allotted' | 'allotted';

export interface IpoEvent {
  ts: number;
  kind: IpoEventKind;
  /** Issuer name as the sender wrote it (display only). */
  name: string;
  /** Rupees, when the message carries one. */
  amount?: number;
  /** Application number, when present (joins events across senders). */
  appNo?: string;
}

const NOISE_WORDS = /\b(limited|ltd|pvt|private|the|sme|general|retail|eq|rs|inr)\b/gi;

/** Short comparable key: "HD FIRE PROTECT LIMITED" and "HD FIRE PROTEC-EQ5/-" → "hdfire". */
export function ipoKey(name: string): string {
  return name
    .replace(NOISE_WORDS, ' ')
    .toLowerCase()
    .replace(/[^a-z]/g, '')
    .slice(0, 6);
}

/** Keys match when equal, or one is a prefix of the other (a short ticker vs the full name). */
export function keysMatch(a: string, b: string): boolean {
  const n = Math.min(a.length, b.length);
  return n >= 4 && a.slice(0, n) === b.slice(0, n);
}

function num(s: string): number {
  return parseFloat(s.replace(/,/g, ''));
}

function cleanName(s: string): string {
  return s
    .replace(/^\s*(?:SME\s*-\s*)/i, '')
    .replace(/\s*-\s*(?:GENERAL|RETAIL)\s*$/i, '')
    .replace(/[\s.:,-]+$/g, '')
    .trim();
}

const RULES: Array<{ re: RegExp; build: (m: RegExpMatchArray) => Omit<IpoEvent, 'ts'> | null }> = [
  // slice / bank: mandate created = money blocked
  {
    re: /UPI-IPO mandate successfully created towards (.+?) from your .*?for Rs\.?\s*([\d,]+(?:\.\d+)?)/i,
    build: m => ({ kind: 'blocked', name: cleanName(m[1]), amount: num(m[2]) }),
  },
  // mandate revoked = unblocked
  {
    re: /UPI-IPO mandate for Rs\.?\s*([\d,]+(?:\.\d+)?) to (.+?) has been revoked/i,
    build: m => ({ kind: 'revoked', name: cleanName(m[2]), amount: num(m[1]) }),
  },
  // KFin / Link Intime / MUFG: "…unblock|unblk Rs. N for SRIT IPO appl no. X due to non-allotment"
  {
    re: /unbl(?:oc)?k\s+Rs\.?\s*([\d,]+(?:\.\d+)?)\s+for\s+(.+?)\s+IPO\s+appl?\s*no\.?\s*(\S+)/i,
    build: m => ({ kind: 'unblocked', name: cleanName(m[2]), amount: num(m[1]), appNo: m[3].replace(/[.,]+$/, '') }),
  },
  // BSE: "No allotment to Application No.X FOR NAME."
  {
    re: /No allotment to Application No\.?\s*(\S+)\s+FOR\s+(.+?)\.\s+FOR DETAILS/i,
    build: m => ({ kind: 'not_allotted', name: cleanName(m[2]), appNo: m[1] }),
  },
  // BSE allotment: "SUCCESSFUL ALLOTMENT OF 35 SHARES AT RS.417.00 TO APPLICATION NO.X FOR IGIIL."
  {
    re: /SUCCESSFUL ALLOTMENT OF\s+(\d+)\s+SHARES AT RS\.?\s*([\d,]+(?:\.\d+)?)\s+TO APPLICATION NO\.?\s*(\S+)\s+FOR\s+(.+?)\.\s+FOR DETAILS/i,
    build: m => ({ kind: 'allotted', name: cleanName(m[4]), amount: Math.round(num(m[1]) * num(m[2]) * 100) / 100, appNo: m[3] }),
  },
  // NSE allotment: "IPO Hero Motors Limited: 178 shares allotted at Rs 84.00 for App no X"
  {
    re: /IPO\s+(.+?)\s*:\s*(\d+)\s+shares allotted at Rs\.?\s*([\d,]+(?:\.\d+)?)\s+for App no\s+(\S+?)\.?\s/i,
    build: m => ({ kind: 'allotted', name: cleanName(m[1]), amount: Math.round(num(m[2]) * num(m[3]) * 100) / 100, appNo: m[4] }),
  },
  // HDFC Sec allotment: "You have been allotted 26 shares of X at 574 - per share. Application number N"
  {
    re: /allotted\s+(\d+)\s+shares of\s+(.+?)\s+at\s+([\d,]+(?:\.\d+)?)\s*-?\s*per share(?:\.\s*Application number\s*(\S+))?/i,
    build: m => ({ kind: 'allotted', name: cleanName(m[2]), amount: Math.round(num(m[1]) * num(m[3]) * 100) / 100, appNo: m[4] }),
  },
  // CDSL: "Credit in a/c *0522 through IPO/FPO for 178-HERO MOTORS-EQ RS 10 on 22SEP"
  {
    re: /CDSL:\s*Credit in a\/c\s*\S+\s*through IPO\/FPO for\s+\d+-(.+?)(?:-EQ\S*)?(?:\s+RS\s*\d+)?\s+on\s+\d/i,
    build: m => ({ kind: 'allotted', name: cleanName(m[1]) }),
  },
  // NSE application received: "IPO SS Retail Limited : App no X UPI ID Y for Rs 14840.00 received."
  {
    re: /IPO\s+(.+?)\s*:\s*App no\s+(\S+)\s+(?:UPI ID \S+\s+)?for Rs\.?\s*([\d,]+(?:\.\d+)?)\s+received/i,
    build: m => ({ kind: 'applied', name: cleanName(m[1]), amount: num(m[3]), appNo: m[2] }),
  },
  // HDFC Sec application placed
  {
    re: /Your IPO application no\s*-\s*(\S+)\s+for\s+(.+?)\s+has been placed successfully/i,
    build: m => ({ kind: 'applied', name: cleanName(m[2]), appNo: m[1] }),
  },
  {
    re: /Your IPO application for\s+(.+?)\s+\(No\.?\s*(\S+?)\)\s+has been successfully placed/i,
    build: m => ({ kind: 'applied', name: cleanName(m[1]), appNo: m[2] }),
  },
  {
    re: /Your IPO order for\s+(.+?)\s+with PAN/i,
    build: m => ({ kind: 'applied', name: cleanName(m[1]) }),
  },
  // BSE: "APPLICATION NO.X OF NAME. HAS BEEN SUBMITTED ON BSE"
  {
    re: /APPLICATION NO\.?\s*(\S+)\s+OF\s+(.+?)\.?\s+HAS BEEN SUBMITTED ON BSE/i,
    build: m => ({ kind: 'applied', name: cleanName(m[2]), appNo: m[1] }),
  },
];

/** An IPO status message → event; null for anything else (incl. mandate requests). */
export function parseIpoEvent(body: string, ts: number): IpoEvent | null {
  if (!body) {
    return null;
  }
  for (const r of RULES) {
    const m = body.match(r.re);
    if (m) {
      const e = r.build(m);
      return e && e.name ? { ts, ...e } : null;
    }
  }
  return null;
}

export type IpoStatus = 'applied' | 'blocked' | 'allotted' | 'debited' | 'refunded';

export interface IpoSummaryItem {
  key: string;
  name: string;
  status: IpoStatus;
  /** Last blocked/applied amount. */
  blocked: number;
  /** The bank's final debit, once seen. */
  debited: number;
  lastTs: number;
  /** Time of the latest allotment notice (0 until one is seen). */
  allottedTs: number;
}

export interface IpoDebitRow {
  ts: number;
  amount: number;
  merchant?: string | null;
}

/**
 * Fold events (and bank debits already categorised Investment) into one line
 * per issuer. Later events win, except that a seen debit is final: late
 * "allotted"/"unblocked" notices do not undo it. A new block after a refund
 * (re-application) starts over.
 */
export function buildIpos(events: IpoEvent[], debits: IpoDebitRow[] = []): IpoSummaryItem[] {
  const alias = new Map<string, string>(); // appNo → key
  const sorted = [...events].sort((a, b) => a.ts - b.ts);
  const items = new Map<string, IpoSummaryItem>();
  const applyTs = new Map<string, number>();
  for (const e of sorted) {
    const own = ipoKey(e.name);
    const key =
      (e.appNo && alias.get(e.appNo)) ||
      [...items.keys()].find(k => keysMatch(k, own)) ||
      own;
    if (!key) {
      continue;
    }
    if (e.appNo && !alias.has(e.appNo)) {
      alias.set(e.appNo, key);
    }
    let it = items.get(key);
    if (!it) {
      it = { key, name: e.name, status: 'applied', blocked: 0, debited: 0, lastTs: e.ts, allottedTs: 0 };
      items.set(key, it);
    }
    if (e.name.length > it.name.length) {
      it.name = e.name;
    }
    it.lastTs = e.ts;
    switch (e.kind) {
      case 'applied':
        applyTs.set(key, e.ts);
        if (it.status === 'refunded' || it.status === 'debited') {
          it.status = 'applied';
          it.debited = 0;
          it.allottedTs = 0;
        }
        if (e.amount) {
          it.blocked = e.amount;
        }
        break;
      case 'blocked':
        applyTs.set(key, e.ts);
        it.status = 'blocked';
        it.debited = 0;
        it.allottedTs = 0;
        it.blocked = e.amount ?? it.blocked;
        break;
      case 'revoked':
      case 'unblocked':
      case 'not_allotted':
        if (it.status !== 'debited') {
          it.status = 'refunded';
        }
        break;
      case 'allotted':
        it.allottedTs = e.ts;
        if (it.status !== 'debited') {
          it.status = 'allotted';
        }
        break;
    }
  }
  for (const it of items.values()) {
    // A debit after the (last) application is final, whatever notices follow.
    const d = debits.find(
      x =>
        keysMatch(ipoKey(x.merchant ?? ''), it.key) &&
        x.ts >= (applyTs.get(it.key) ?? it.lastTs) - 86_400_000 &&
        (it.blocked <= 0 || x.amount <= it.blocked * 1.02),
    );
    if (d) {
      it.status = 'debited';
      it.debited = d.amount;
    }
  }
  return [...items.values()].sort((a, b) => b.lastTs - a.lastTs);
}

/** An issuer worth matching bank debits against (blocked, applied or allotted — not refunded). */
export interface IpoIssuer {
  key: string;
  /** Largest amount blocked/applied for this issuer (0 if unknown). */
  blocked: number;
  /** Time of the allotment notice, 0 if none seen yet. */
  allottedTs: number;
}

export function activeIssuers(events: IpoEvent[]): IpoIssuer[] {
  return buildIpos(events)
    .filter(i => i.status !== 'refunded')
    .map(i => ({ key: i.key, blocked: i.blocked, allottedTs: i.allottedTs }));
}

/** After allotment the clearing corporation's debit lands within this window. */
export const IPO_CLEARING_WINDOW_MS = 7 * 86_400_000;

const CLEARING_RE = /^(?:iccl|indian clearing corp(?:oration)?|nse clearing|nsccl|bse|nse)(?: (?:ltd|limited))?$/;

/** ICCL / NSE Clearing / BSE / NSE as the debit's payee (the bank names the exchange, not the issuer). */
export function isClearingMerchant(merchant: string | null | undefined): boolean {
  return CLEARING_RE.test((merchant ?? '').toLowerCase().replace(/[^a-z]+/g, ' ').trim());
}

/**
 * The bank's final debit for an allotted IPO: an expense whose merchant is an
 * active issuer and whose amount fits inside the blocked amount (allotment
 * debits are lots × price ≤ the block). Without a known block, name alone is
 * not enough for amounts that look unlike an IPO lot.
 *
 * Banks often name the clearing corporation instead of the issuer. That counts
 * only with a debit time (`ts`) and when an issuer has a known block, an
 * allotment notice, a 30–102% amount, and the debit is within 7 days after the
 * notice. (No listing date is parsed, so the notice time is the anchor.)
 */
export function isIpoDebit(
  merchant: string | null | undefined,
  amount: number,
  issuers: IpoIssuer[] | undefined,
  ts?: number,
): boolean {
  if (!issuers || issuers.length === 0 || !merchant) {
    return false;
  }
  if (isClearingMerchant(merchant)) {
    return (
      ts != null &&
      issuers.some(
        i =>
          i.blocked > 0 &&
          i.allottedTs > 0 &&
          amount >= i.blocked * 0.3 &&
          amount <= i.blocked * 1.02 &&
          ts >= i.allottedTs &&
          ts - i.allottedTs <= IPO_CLEARING_WINDOW_MS,
      )
    );
  }
  const key = ipoKey(merchant);
  if (key.length < 4) {
    return false;
  }
  return issuers.some(
    i => keysMatch(i.key, key) && (i.blocked > 0 ? amount <= i.blocked * 1.02 && amount >= i.blocked * 0.3 : amount >= 1000),
  );
}
