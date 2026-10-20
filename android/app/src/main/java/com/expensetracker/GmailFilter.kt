package com.expensetracker

/**
 * Narrow, hard-coded Gmail filter for NotificationService (not a general allowlist entry).
 *
 * Only an Amazon Pay wallet top-up confirmation ("₹2000.00 added to your Amazon Pay
 * Wallet") or the cashback credit that uses the same wording ("cashback ₹20 added to your
 * Amazon Pay Wallet"; src/parser.ts tells them apart) is ever buffered from Gmail;
 * every other email notification is dropped before it
 * reaches EventBuffer so no other email content is stored.
 *
 * Mirrors src/gmailFilter.ts (which is what jest tests) — change both together.
 */
object GmailFilter {
    const val GMAIL_PKG = "com.google.android.gm"

    private val TOPUP_RE = Regex("""\badded\b[\s\S]*?\bamazon\s*pay\s*wallet""", RegexOption.IGNORE_CASE)
    private val RUPEE_AMOUNT_RE = Regex("""(?:₹|rs\.?|inr)\s*\d""", RegexOption.IGNORE_CASE)
    private const val MAX_BODY = 600

    /**
     * Gmail puts sender in the title, subject in text and the snippet in bigText, so all
     * three are joined and matched together. Returns the text to buffer, or null to drop.
     */
    fun walletTopUpBody(title: String?, text: String?, bigText: String?): String? {
        val joined = listOf(title, text, bigText)
            .filter { !it.isNullOrBlank() }
            .map { it!!.trim() }
            .distinct()
            .joinToString(". ")
        if (joined.isEmpty()) return null
        if (!TOPUP_RE.containsMatchIn(joined) || !RUPEE_AMOUNT_RE.containsMatchIn(joined)) return null
        return if (joined.length > MAX_BODY) joined.substring(0, MAX_BODY) else joined
    }
}
