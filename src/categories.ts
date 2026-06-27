export type Category = 'Food' | 'Transport' | 'Shopping' | 'Bills' | 'UPI' | 'Other';

const KEYWORD_MAP: Array<{ keywords: string[]; category: Category }> = [
  {
    keywords: ['swiggy', 'zomato', 'restaurant', 'cafe', 'food', 'pizza', 'burger', 'biryani', 'diner', 'kitchen', 'eatery'],
    category: 'Food',
  },
  {
    keywords: ['uber', 'ola', 'irctc', 'fuel', 'petrol', 'diesel', 'metro', 'bus', 'rapido', 'taxi', 'cab', 'railway', 'flight', 'airline'],
    category: 'Transport',
  },
  {
    keywords: ['amazon', 'flipkart', 'myntra', 'meesho', 'nykaa', 'ajio', 'snapdeal', 'shopclues', 'tatacliq'],
    category: 'Shopping',
  },
  {
    keywords: ['electricity', 'recharge', 'bill', 'dth', 'broadband', 'insurance', 'emi', 'loan', 'postpaid', 'prepaid', 'utility', 'gas', 'water'],
    category: 'Bills',
  },
  {
    keywords: ['upi', 'vpa', '@'],
    category: 'UPI',
  },
];

export function categorize(merchant: string | null, body: string): Category {
  const haystack = `${merchant ?? ''} ${body}`.toLowerCase();

  for (const { keywords, category } of KEYWORD_MAP) {
    for (const kw of keywords) {
      if (haystack.includes(kw)) {
        return category;
      }
    }
  }

  return 'Other';
}
