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
  'Friend Transfer': { color: '#26A69A', icon: 'person' },
  'Loan/Dues':   { color: '#8D6E63', icon: 'wallet' },
  Other:         { color: '#78909C', icon: 'ellipsis-horizontal' },
};

// ─── Keyword map ──────────────────────────────────────────────────────────────

const KEYWORD_MAP: Array<{ keywords: string[]; category: Category }> = [
  {
    keywords: [
      'swiggy', 'zomato', 'restaurant', 'cafe', 'food', 'pizza', 'burger',
      'biryani', 'diner', 'kitchen', 'eatery', 'dhaba', 'canteen', 'bakery',
    ],
    category: 'Food',
  },
  {
    keywords: [
      'bigbasket', 'blinkit', 'zepto', 'dmart', 'grofers', 'instamart',
      'jiomart', 'grocery', 'supermarket', 'vegetables', 'fruits',
    ],
    category: 'Groceries',
  },
  {
    // Checked before Transport (first match wins) so Uber rides get their
    // own category; Ola/Rapido/fuel/etc. stay Transport.
    keywords: ['uber'],
    category: 'Uber',
  },
  {
    keywords: [
      'ola', 'irctc', 'fuel', 'petrol', 'diesel', 'metro', 'bus',
      'rapido', 'taxi', 'cab', 'railway', 'flight', 'airline', 'redbus',
      'parking', 'toll', 'fastag',
    ],
    category: 'Transport',
  },
  {
    keywords: [
      'amazon', 'flipkart', 'myntra', 'meesho', 'nykaa', 'ajio', 'snapdeal',
      'shopclues', 'tatacliq', 'reliance digital', 'croma', 'vijay sales',
    ],
    category: 'Shopping',
  },
  {
    keywords: [
      'netflix', 'spotify', 'hotstar', 'prime video', 'bookmyshow', 'pvr',
      'inox', 'youtube', 'disney', 'zee5', 'sonyliv', 'gaming', 'steam',
      'playstation', 'xbox',
    ],
    category: 'Entertainment',
  },
  {
    // Checked before Bills/UPI (first match wins) so SIP/NACH mandate debits
    // and demat-account SMS land here instead of Bills ("emi") or UPI ("@").
    keywords: [
      'mutual fund', 'iccl', 'sip', 'nach', 'zerodha', 'groww', 'upstox',
      'kite', 'smallcase', 'demat', 'nse', 'bse', 'etf', 'folio', 'indmoney',
      'mf',
    ],
    category: 'Investment',
  },
  {
    // Checked before Bills ("fee"/"bill" would otherwise misfire on tuition
    // fee / library fine notices).
    keywords: [
      'college', 'university', 'exam', 'fees', 'course', 'udemy', 'coursera',
      'tuition', 'coaching', 'books', 'stationery', 'library',
    ],
    category: 'Education',
  },
  {
    keywords: [
      'electricity', 'recharge', 'bill', 'billdesk', 'dth', 'broadband',
      'insurance', 'emi', 'loan', 'postpaid', 'prepaid', 'utility', 'gas',
      'water', 'maintenance', 'rent', 'subscription',
    ],
    category: 'Bills',
  },
  {
    keywords: [
      'pharmacy', 'apollo', 'pharmeasy', '1mg', 'hospital', 'clinic',
      'medical', 'doctor', 'dental', 'health', 'medicine', 'lab', 'pathology',
      'diagnostic', 'netmeds',
    ],
    category: 'Health',
  },
  {
    keywords: ['upi', 'vpa', '@'],
    category: 'UPI',
  },
  {
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
const COMPILED_KEYWORD_MAP: Array<{ category: Category; test: (haystack: string) => boolean }> =
  KEYWORD_MAP.map(({ keywords, category }) => {
    const hasAt = keywords.includes('@');
    const wordKeywords = keywords.filter(k => k !== '@');
    const boundaryRe =
      wordKeywords.length > 0
        ? new RegExp(
            `(?<![a-z0-9])(?:${wordKeywords.map(escapeRegExp).join('|')})(?![a-z0-9])`,
            'i',
          )
        : null;
    return {
      category,
      test: (haystack: string) =>
        (boundaryRe !== null && boundaryRe.test(haystack)) ||
        (hasAt && haystack.includes('@')),
    };
  });

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

/**
 * True for merchant-rule keys that are too generic to safely learn a rule
 * from — a bare run of 1-5 digits. These come from account-fragment
 * counterparties (e.g. "1234") which are shared across many unrelated SMS
 * from the same bank, so a rule keyed on one silently mislabels everything
 * else from that bank. 10-digit phone numbers and VPAs (which contain "@")
 * are unaffected since they don't match this pattern.
 */
export function isGenericMerchantKey(key: string): boolean {
  return /^\d{1,5}$/.test(key);
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

  // 1b. Income defaults to the Income category rather than matching spend
  // keywords in the body (a refund from Swiggy shouldn't land in Food).
  if (isExpense === false) {
    return 'Income';
  }

  // 2. Keyword match across merchant + counterparty + raw body.
  const haystack =
    `${merchant ?? ''} ${counterparty ?? ''} ${body}`.toLowerCase();

  for (const { category, test } of COMPILED_KEYWORD_MAP) {
    if (test(haystack)) {
      return category;
    }
  }

  // 3. Default.
  return 'Other';
}
