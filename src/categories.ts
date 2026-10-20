// ─── Category types and metadata ─────────────────────────────────────────────

export type Category =
  | 'Food'
  | 'Groceries'
  | 'Transport'
  | 'Uber'
  | 'Shopping'
  | 'Bills'
  | 'Entertainment'
  | 'Health'
  | 'Investment'
  | 'Education'
  | 'UPI'
  | 'Cash'
  | 'Income'
  | 'Cashback'
  | 'Family'
  | 'Friend Transfer'
  | 'Loan/Dues'
  | 'Other';

/** Ordered list of all Category values (used for filter chips, dropdowns, etc.). */
export const CATEGORIES: Category[] = [
  'Food',
  'Groceries',
  'Transport',
  'Uber',
  'Shopping',
  'Bills',
  'Entertainment',
  'Health',
  'Investment',
  'Education',
  'UPI',
  'Cash',
  'Income',
  'Cashback',
  'Family',
  'Friend Transfer',
  'Loan/Dues',
  'Other',
];

export interface CategoryMeta {
  /** Hex colour that reads legibly on a true-black AMOLED background. */
  color: string;
  /** Ionicons icon name. */
  icon: string;
}

/**
 * Visual metadata for every category — used by UI chips, chart legends, and
 * list-item icons. All colours are high-saturation / mid-brightness so they
 * pop on a #000000 background without being harsh.
 */
export const CATEGORY_META: Record<Category, CategoryMeta> = {
  Food:          { color: '#FF6B35', icon: 'fast-food' },
  Groceries:     { color: '#4CAF50', icon: 'cart' },
  Transport:     { color: '#29B6F6', icon: 'car' },
  Uber:          { color: '#E0E0E0', icon: 'car' },
  Shopping:      { color: '#CE93D8', icon: 'bag' },
  Bills:         { color: '#FFB300', icon: 'receipt' },
  Entertainment: { color: '#F06292', icon: 'film' },
  Health:        { color: '#26C6DA', icon: 'medkit' },
  Investment:    { color: '#FFD740', icon: 'stats' },
  Education:     { color: '#CDDC39', icon: 'school' },
  UPI:           { color: '#7E57C2', icon: 'swap-horizontal' },
  Cash:          { color: '#A5D6A7', icon: 'cash' },
  Income:        { color: '#66BB6A', icon: 'trending-up' },
  Cashback:      { color: '#AED581', icon: 'gift' },
  Family:        { color: '#FF8A80', icon: 'home' },
  'Friend Transfer': { color: '#26A69A', icon: 'person' },
  'Loan/Dues':   { color: '#8D6E63', icon: 'wallet' },
  Other:         { color: '#78909C', icon: 'ellipsis-horizontal' },
};

// ─── Category groups ──────────────────────────────────────────────────────────
//
// Purely a display-organization layer — no DB column, derived from Category.
// Used to group category pickers/filters and to roll up the Insights donut.

export type CategoryGroup =
  | 'Essentials'
  | 'Transport'
  | 'Lifestyle'
  | 'Education'
  | 'Transfers'
  | 'Investments'
  | 'Income'
  | 'Other';

/** Ordered list of all groups (used for section headers, drill-down lists). */
export const GROUPS: CategoryGroup[] = [
  'Essentials',
  'Transport',
  'Lifestyle',
  'Education',
  'Transfers',
  'Investments',
  'Income',
  'Other',
];

/** Which group each category belongs to. Record<Category, ...> forces this
 * to be updated whenever a new Category is added. */
export const GROUP_OF: Record<Category, CategoryGroup> = {
  Food: 'Essentials',
  Groceries: 'Essentials',
  Bills: 'Essentials',
  Health: 'Essentials',
  Transport: 'Transport',
  Uber: 'Transport',
  Shopping: 'Lifestyle',
  Entertainment: 'Lifestyle',
  Education: 'Education',
  Investment: 'Investments',
  UPI: 'Transfers',
  Cash: 'Transfers',
  'Friend Transfer': 'Transfers',
  'Loan/Dues': 'Transfers',
  Income: 'Income',
  Cashback: 'Income',
  Family: 'Income',
  Other: 'Other',
};

/** Returns the group for a category string, defaulting unknown values to 'Other'. */
export function groupOf(category: string): CategoryGroup {
  return (GROUP_OF as Record<string, CategoryGroup | undefined>)[category] ?? 'Other';
}

export interface GroupMeta {
  /** Hex colour used for the group-level donut slice / legend dot. */
  color: string;
}

/** Visual metadata for each group — used by the Insights group donut. */
export const GROUP_META: Record<CategoryGroup, GroupMeta> = {
  Essentials: { color: '#4CAF50' },
  Transport: { color: '#29B6F6' },
  Lifestyle: { color: '#CE93D8' },
  Education: { color: '#CDDC39' },
  Transfers: { color: '#7E57C2' },
  Investments: { color: '#FFD740' },
  Income: { color: '#66BB6A' },
  Other: { color: '#78909C' },
};

/** CATEGORIES partitioned by group, in GROUPS order; each group's categories
 * keep CATEGORIES order. Groups with no categories are omitted. */
export const GROUPED_CATEGORIES: Array<{ group: CategoryGroup; categories: Category[] }> =
  GROUPS.map(group => ({
    group,
    categories: CATEGORIES.filter(cat => GROUP_OF[cat] === group),
  })).filter(g => g.categories.length > 0);

// ─── Keyword map ──────────────────────────────────────────────────────────────

/**
 * Two tiers per category, because matching everything against the raw SMS body
 * was the single biggest source of wrong categories:
 *
 *   `brands`   — distinctive enough to trust ANYWHERE, including the raw body.
 *                Nothing here should plausibly appear in bank boilerplate.
 *   `keywords` — only matched against the merchant/counterparty. These are
 *                generic words ("bill", "loan", "rent", "gas", "@") that occur
 *                constantly in bank footers. Matching them against the body
 *                meant "spent at Barbeque Nation, your credit card bill is due"
 *                filed as Bills, and any message containing an email address
 *                filed as UPI.
 *
 * Order still matters (first match wins) within each tier.
 */
const KEYWORD_MAP: Array<{
  brands: string[];
  keywords: string[];
  category: Category;
}> = [
  {
    // 'uber eats' sits in Food and Food precedes Uber, so a food-delivery
    // order is never counted as a ride — that used to silently corrupt the
    // ride stats and the fare-split averages.
    brands: [
      'uber eats', 'ubereats', 'swiggy', 'zomato', 'dominos', 'pizza hut',
      'mcdonald', 'mc donalds', 'mcdonalds', 'kfc', 'starbucks', 'faasos',
      'behrouz', 'eatsure', 'taco bell', 'popeyes', 'jubilant foodworks',
      'eternal limited', 'district dining', 'dineout', 'jumbo king',
      'urban meals',
    ],
    keywords: [
      'restaurant', 'cafe', 'food', 'pizza', 'burger',
      'biryani', 'diner', 'kitchen', 'eatery', 'dhaba', 'canteen', 'bakery',
      'sweets', 'juice', 'momo', 'shawarma', 'falahaar',
    ],
    category: 'Food',
  },
  {
    brands: [
      'bigbasket', 'blinkit', 'zepto', 'dmart', 'grofers', 'instamart',
      'jiomart', 'blink commerce', 'rapsap',
    ],
    keywords: [
      'grocery', 'supermarket', 'vegetables', 'fruits', 'general store',
      'kirana', 'mart',
    ],
    category: 'Groceries',
  },
  {
    // 'uber one' is a subscription, not a ride — checked before bare 'uber'.
    brands: ['uber one'],
    keywords: [],
    category: 'Bills',
  },
  {
    // Merchant-only: a body mention of "uber" (cashback offers, statement
    // summaries, Uber Eats footers) must not manufacture a phantom ride.
    brands: [],
    keywords: ['uber'],
    category: 'Uber',
  },
  {
    brands: [
      'irctc', 'rapido', 'redbus', 'fastag', 'olacabs', 'roppen transportation',
      'indian railways', 'cityflo',
    ],
    keywords: [
      'ola', 'uts', 'fuel', 'petrol', 'diesel', 'metro', 'bus',
      'taxi', 'cab', 'railway', 'flight', 'airline',
      'parking', 'toll',
    ],
    category: 'Transport',
  },
  {
    brands: [
      'amazon', 'flipkart', 'myntra', 'meesho', 'nykaa', 'ajio', 'snapdeal',
      'shopclues', 'tatacliq', 'reliance digital', 'croma', 'vijay sales',
    ],
    keywords: [],
    category: 'Shopping',
  },
  {
    brands: [
      'netflix', 'spotify', 'hotstar', 'prime video', 'bookmyshow', 'pvr',
      'inox', 'youtube', 'disney', 'zee5', 'sonyliv', 'steam',
      'playstation', 'xbox',
      'district movies',
    ],
    keywords: ['gaming'],
    category: 'Entertainment',
  },
  {
    // Checked before Bills/UPI so SIP/NACH mandate debits and demat-account
    // SMS land here instead of Bills ("emi") or UPI ("@").
    brands: [
      'zerodha', 'groww', 'upstox', 'smallcase', 'indmoney', 'mutual fund',
      'iccl', 'mf utilities',
    ],
    keywords: ['sip', 'nach', 'kite', 'demat', 'nse', 'bse', 'etf', 'folio', 'mf'],
    category: 'Investment',
  },
  {
    // Checked before Bills ("fee"/"bill" would otherwise misfire on tuition
    // fee / library fine notices).
    brands: ['udemy', 'coursera', 'unacademy', 'byjus'],
    keywords: [
      'college', 'university', 'exam', 'fees', 'course',
      'tuition', 'coaching', 'books', 'stationery', 'library', 'admission',
    ],
    category: 'Education',
  },
  {
    brands: ['billdesk', 'tata power', 'adani electricity', 'jio', 'airtel', 'vodafone', 'reliancejio', 'myjio'],
    keywords: [
      'electricity', 'recharge', 'bill', 'dth', 'broadband',
      'insurance', 'emi', 'loan', 'postpaid', 'prepaid', 'utility', 'gas',
      'water', 'maintenance', 'rent', 'subscription',
    ],
    category: 'Bills',
  },
  {
    brands: ['apollo', 'pharmeasy', '1mg', 'netmeds', 'practo'],
    keywords: [
      'pharmacy', 'chemist', 'hospital', 'clinic',
      'medical', 'doctor', 'dental', 'health', 'medicine', 'lab', 'pathology',
      'diagnostic', 'fitness', 'gym',
    ],
    category: 'Health',
  },
  {
    // Merchant-only. '@' in particular used to match any support email in a
    // bank footer and force an unrelated card purchase into UPI.
    brands: [],
    keywords: ['upi', 'vpa', '@'],
    category: 'UPI',
  },
  {
    brands: [],
    keywords: ['atm', 'cash withdrawal', 'cash deposit', 'withdrawn'],
    category: 'Cash',
  },
];

/**
 * Escapes regex metacharacters in a literal keyword so it can be dropped into
 * a larger pattern (e.g. "1mg" or "w/d" if they ever gain special chars).
 */
function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * One compiled matcher per KEYWORD_MAP entry, built once at module load.
 * Keywords are matched on word boundaries (`(?<![a-z0-9])kw(?![a-z0-9])`) so
 * e.g. "uber" no longer matches inside "suburban" and "emi" no longer matches
 * inside "premium" — a bare substring search (the previous behaviour) was
 * the root cause of unrelated messages being tagged Uber. "@" can't take
 * word boundaries (it's not a word character on either side), so it's
 * special-cased to a plain substring check.
 */
function compileMatcher(keywords: string[]): (haystack: string) => boolean {
  const hasAt = keywords.includes('@');
  const wordKeywords = keywords.filter(k => k !== '@');
  const boundaryRe =
    wordKeywords.length > 0
      ? new RegExp(
          `(?<![a-z0-9])(?:${wordKeywords.map(escapeRegExp).join('|')})(?:s|com)?(?![a-z0-9])`,
          'i',
        )
      : null;
  return (haystack: string) =>
    (boundaryRe !== null && boundaryRe.test(haystack)) ||
    (hasAt && haystack.includes('@'));
}

/**
 * `testName` matches brands + generic keywords (used against merchant and
 * counterparty only); `testBody` matches brands alone (safe against the raw
 * message text). See the KEYWORD_MAP docblock for why the two tiers exist.
 */
const COMPILED_KEYWORD_MAP: Array<{
  category: Category;
  testName: (haystack: string) => boolean;
  testBody: (haystack: string) => boolean;
}> = KEYWORD_MAP.map(({ brands, keywords, category }) => ({
  category,
  testName: compileMatcher([...brands, ...keywords]),
  testBody: brands.length > 0 ? compileMatcher(brands) : () => false,
}));

/**
 * The first sentence of a message, lowercased. Splits on a period/newline
 * followed by whitespace, so decimal amounts ("Rs.600.00") stay intact.
 */
function leadingClause(body: string): string {
  return body.split(/(?:\.|\n)\s/)[0].toLowerCase();
}

/** Credits that are genuinely the user's own income, not money moving between people. */
const INCOME_SIGNAL_RE =
  /\b(salary|payroll|interest|dividend|cashback|matured|maturity|pension|stipend|bonus)\b/i;

/** A person-to-person UPI handle (as opposed to a merchant/business VPA). */
export const MERCHANT_VPA_RE =
  /\b(payments?|pay|billdesk|razorpay|payu|merchant|store|retail|enterprises?|pvt|ltd)\b/i;

// ─── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Produces the canonical merchant-rules lookup key: lowercase, trimmed, spaces
 * collapsed. Prefers counterparty (e.g. UPI VPA) over merchant name because
 * VPAs are more stable identifiers. Returns null when both inputs are empty.
 */
export function normalizeMerchantKey(
  merchant: string | null,
  counterparty: string | null,
): string | null {
  const raw = (counterparty || merchant || '').trim();
  if (!raw) {
    return null;
  }
  return raw.toLowerCase().replace(/\s+/g, ' ');
}

/** Bank helpline / UPI-block numbers that appear in message footers. */
const KNOWN_HELPLINES = new Set(['7308080808', '8048329999']);

/**
 * True for merchant-rule keys that are too generic to safely learn a rule
 * from — a bare run of 1-5 digits. These come from account-fragment
 * counterparties (e.g. "1234") which are shared across many unrelated SMS
 * from the same bank, so a rule keyed on one silently mislabels everything
 * else from that bank. 10-digit phone numbers and VPAs (which contain "@")
 * are unaffected since they don't match this pattern.
 */
export function isGenericMerchantKey(key: string): boolean {
  if (/^\d{1,5}$/.test(key)) {
    return true;
  }
  // Bank helpline numbers that leak into messages (toll-free 1800/1860,
  // trunk-prefixed 0xxx, and the UPI-block short code). Shared by every message
  // from that bank, same as the support addresses below.
  if (/^(?:1800|1860|0)\d{6,}$/.test(key) || KNOWN_HELPLINES.has(key)) {
    return true;
  }
  // Bank support/no-reply addresses. These are shared by every message from
  // that bank, so a rule keyed on one silently recategorizes the user's whole
  // history with them. The parser no longer emits these as counterparties, but
  // installs that ran the older build may already have one stored.
  if (/^(?:care|support|noreply|no-reply|donotreply|alerts?|info|service)[@.\-]/i.test(key)) {
    return true;
  }
  return false;
}

// ─── Main categorize function ─────────────────────────────────────────────────

/**
 * Assign a Category to a transaction. Pure — no DB access, no side effects.
 *
 * Resolution order:
 *  1. learnedRules[normalizeMerchantKey(merchant, counterparty)] — user-taught rules win.
 *  2. Keyword map against `"${merchant} ${counterparty} ${body}"` haystack.
 *  3. 'Other' fallback.
 *
 * @param merchant    Cleaned merchant name from the parser (may be null).
 * @param body        Raw SMS / notification body for broad keyword matching.
 * @param counterparty UPI VPA / phone / account fragment (may be null).
 * @param learnedRules Map from merchant_rules table (key → category string).
 * @param isExpense   When explicitly false (income), skips the spend-keyword
 *                    map and defaults to 'Income' — a learned rule can still
 *                    override this (e.g. the user recategorizes a specific
 *                    refund source by hand).
 */
export function categorize(
  merchant: string | null,
  body: string,
  counterparty: string | null,
  learnedRules?: Record<string, string>,
  isExpense?: boolean,
): Category {
  // 1. Learned rules take highest priority.
  if (learnedRules) {
    const key = normalizeMerchantKey(merchant, counterparty);
    // Skip generic numeric keys (e.g. a bank account fragment) even if one
    // is already sitting in the DB — such a rule matches far too broadly to
    // trust, regardless of how it got there.
    if (key && !isGenericMerchantKey(key) && Object.prototype.hasOwnProperty.call(learnedRules, key)) {
      const learned = learnedRules[key] as string;
      // Validate it is still a valid Category before trusting it.
      if ((CATEGORIES as string[]).includes(learned)) {
        return learned as Category;
      }
    }
  }

  const name = `${merchant ?? ''} ${counterparty ?? ''}`.toLowerCase();

  // 1b. Credits. Previously EVERY credit collapsed to 'Income' before the
  // keyword map ran, so salary, refunds, cashback and a friend's fare payback
  // were one undifferentiated bucket — and the Uber screen's
  // `category !== 'Uber'` filter consequently excluded nothing.
  if (isExpense === false) {
    return categorizeCredit(name, body);
  }

  // 2a. Merchant/counterparty tier — brands AND generic keywords.
  for (const { category, testName } of COMPILED_KEYWORD_MAP) {
    if (testName(name)) {
      return category;
    }
  }

  // 2b. Leading-clause tier — brands AND generic keywords, but only against
  // the first sentence. This is where the transaction itself is described
  // ("Rs.5000 debited for college tuition fees"); the footers that carry the
  // misleading generic words ("Your credit card bill is due", "Dispute?
  // care@hdfcbank.com", "Avl Bal ...") always come later.
  const lead = leadingClause(body);
  for (const { category, testName } of COMPILED_KEYWORD_MAP) {
    if (testName(lead)) {
      return category;
    }
  }

  // 2c. Full-body tier — distinctive brand names only. Generic words are
  // deliberately NOT matched here; they used to outrank the real merchant.
  const bodyHaystack = body.toLowerCase();
  for (const { category, testBody } of COMPILED_KEYWORD_MAP) {
    if (testBody(bodyHaystack)) {
      return category;
    }
  }

  // 3. Default. 'Other' surfaces in the Review queue, where the user's pick
  // also teaches a merchant rule — better than a confident wrong guess.
  return 'Other';
}

/**
 * Category for an incoming payment. Distinguishes real income from money simply
 * moving between people, which is what makes fare-split netting possible.
 */
function categorizeCredit(name: string, body: string): Category {
  const haystack = `${name} ${body}`.toLowerCase();

  // Explicit income signals win — a salary credit is not a friend transfer.
  if (INCOME_SIGNAL_RE.test(haystack)) {
    return 'Income';
  }

  // A credit from a broker / fund house is a payout of the user's own money.
  for (const { category, testName } of COMPILED_KEYWORD_MAP) {
    if (category === 'Investment' && testName(name)) {
      return 'Investment';
    }
  }

  // A refund is money coming back from a merchant; keep it in that merchant's
  // category so it nets against the original spend.
  if (/\b(refund|reversal|reversed)\b/i.test(haystack)) {
    for (const { category, testName } of COMPILED_KEYWORD_MAP) {
      if (testName(name)) {
        return category;
      }
    }
    return 'Income';
  }

  // A credit from a personal UPI handle is almost always someone paying you
  // back, not income. Business/merchant VPAs are excluded.
  if (name.includes('@') && !MERCHANT_VPA_RE.test(name)) {
    return 'Friend Transfer';
  }

  return 'Income';
}
