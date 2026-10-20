// ─── Display-only merchant cleanup ────────────────────────────────────────────
//
// Old rows kept whatever the parser extracted at the time: "Amazon Pay (UPI Ref",
// "TESTA AJAY SAMPLEKAR via UPI (Ref ID (…". The DB is never rewritten; this
// only tidies what is shown. Names without those artefacts are returned as-is
// (cleanMerchant would also cut at a ". " such as "Dr. Mehta").

import { cleanMerchant } from './parser';

const ARTEFACT_RE = /\(|\bvia UPI\b|\bUPI Ref\b|\bwith txn ID\b|\s\S+@\S+$/i;

export function displayMerchant(raw: string | null | undefined): string | null {
  if (raw == null) {
    return null;
  }
  const s = raw.trim();
  if (!s || !ARTEFACT_RE.test(s)) {
    return s || null;
  }
  const cleaned = cleanMerchant(s).replace(/\s+\S+@\S+$/, '').trim();
  return cleaned || s;
}
