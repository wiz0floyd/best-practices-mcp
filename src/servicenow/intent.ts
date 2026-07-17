/**
 * A natural-language request like "stream connect best practices" isn't asking for the literal
 * string "best practices" — it's asking to filter to the Best Practices content type while
 * searching for "stream connect". This maps known facet-intent phrases (observed as real
 * contentTypeLabel values from search.ts's registry — see servicenow_list_content_types) to their
 * label, strips the phrase from the free-text query, and hands back both so the caller applies
 * the label as a contentType filter instead of leaving it as noise in the search term.
 *
 * Deliberately a static map, not a learned one — an earlier attempt to detect "dilutive" words by
 * A/B-probing query variants and comparing top scores was scrapped: comparing raw top-1 scores
 * across differently-worded queries isn't a valid relevance signal (a short, generic residual
 * query routinely spikes score against an unrelated but strongly title-matching document, while
 * specific terms get penalized for narrowing the result set). See the "ServiceNow Genius Search
 * Score Comparison Across Queries Is Not a Relevance Signal" Team-Brain gotcha.
 */
// Sorted longest-pattern-first below so that, if a query happens to contain more than one cue
// phrase, the first-match-wins loop in extractContentTypeIntent naturally prefers the more
// specific/longer one instead of whichever was listed first — no separate ranking pass needed.
const INTENT_PHRASES: Array<{ phrase: RegExp; label: string }> = [
  { phrase: /\bbest practices?\b/i, label: "Best Practices" },
  { phrase: /\bdeveloper portal\b/i, label: "Developer Portal" },
  { phrase: /\b(?:now )?community\b/i, label: "Now Community" },
  { phrase: /\b(?:servicenow )?university\b/i, label: "ServiceNow University" },
  { phrase: /\bproduct documentation\b/i, label: "Product Documentation" },
].sort((a, b) => b.phrase.source.length - a.phrase.source.length);

export interface ContentTypeIntent {
  query: string;
  contentType: string | null;
}

export function extractContentTypeIntent(query: string): ContentTypeIntent {
  for (const { phrase, label } of INTENT_PHRASES) {
    if (phrase.test(query)) {
      const stripped = query.replace(phrase, " ").replace(/\s+/g, " ").trim();
      return { query: stripped.length > 0 ? stripped : query, contentType: label };
    }
  }
  return { query, contentType: null };
}
