/* arxiv-api.js — arXiv API fetch + XML parsing (global scope, no module system) */

const ARXIV_API = 'https://export.arxiv.org/api/query';
const MAX_RESULTS = 800;

// export.arxiv.org does not serve Access-Control-Allow-Origin headers, so direct
// browser fetch is blocked by CORS policy on any cross-origin page (e.g. GitHub Pages).
// We try a list of free CORS proxies in order, remembering the last one that worked.
// '' (empty) = direct fetch — succeeds in local dev, fails silently on GitHub Pages.
const PROXY_LIST = [
  'https://corsproxy.io/?url=',
  'https://api.allorigins.win/raw?url=',
  '', // direct — works locally without any proxy
];

// Persist the index of the last working proxy across page loads.
const PROXY_STORAGE_KEY = 'dailyarxiv.proxyIdx';
let _proxyIdx = (() => {
  try {
    const v = parseInt(localStorage.getItem(PROXY_STORAGE_KEY) || '0', 10);
    return isNaN(v) || v >= PROXY_LIST.length ? 0 : v;
  } catch (_) { return 0; }
})();

/**
 * Build the arXiv API search URL for a category query string and a date.
 * @param {string} query  e.g. "cat:hep-ex OR cat:hep-ph"
 * @param {Date}   date   the date whose listings to fetch
 *
 * Uses URLSearchParams so that brackets, colons, and parens are properly
 * percent-encoded — raw `[` / `]` in query strings cause fetch() to throw
 * a TypeError in some browser environments.
 */
function buildSearchUrl(query, date) {
  // arXiv papers announced on day D have lastUpdatedDate = D-1 (submitted the prior day).
  // Query with the previous arXiv day so the results match the displayed date.
  const queryDate = previousArxivDay(date);
  const d = formatQueryDate(queryDate);
  // Spaces in the query become + (form-encoded) which arXiv treats as AND/OR separators
  const searchQuery = `(${query}) AND lastUpdatedDate:[${d}0000 TO ${d}2359]`;
  const params = new URLSearchParams({
    search_query: searchQuery,
    max_results:  String(MAX_RESULTS),
    sortBy:       'submittedDate',
    sortOrder:    'descending',
  });
  return `${ARXIV_API}?${params.toString()}`;
}

/**
 * Build the arXiv API URL for a list of IDs (reading list / shared link).
 * @param {string[]} ids  clean arXiv IDs like ["2401.12345", "2401.67890"]
 */
function buildIdListUrl(ids) {
  const params = new URLSearchParams({
    id_list:     ids.join(','),
    max_results: String(MAX_RESULTS),
  });
  return `${ARXIV_API}?${params.toString()}`;
}

/**
 * Build a query string from the selected category IDs.
 * Optimization: if all subcategories of a parent are selected, use the parent ID.
 * @param {Set<string>} selectedSet
 */
function buildQueryFromSelected(selectedSet) {
  if (selectedSet.size === 0) return '';

  const result = new Set();

  for (const group of ARXIV_DATABASE) {
    for (const area of group.subcategories) {
      if (!area.subcategories || area.subcategories.length === 0) {
        // Leaf area — include if selected
        if (selectedSet.has(area.id)) result.add(area.id);
      } else {
        // Parent area — check if all children selected
        const leafIds = area.subcategories.map(s => s.id);
        const allSelected = leafIds.every(id => selectedSet.has(id));
        if (allSelected) {
          result.add(area.id); // collapse to parent
        } else {
          leafIds.filter(id => selectedSet.has(id)).forEach(id => result.add(id));
        }
      }
    }
  }

  return [...result].map(id => `cat:${id}`).join(' OR ');
}

/**
 * Fetch articles from the arXiv API and parse the Atom XML response.
 * Routes through CORS_PROXY when set (required for GitHub Pages deployments).
 * Tries each proxy in PROXY_LIST starting from the last known-good one.
 * On success, remembers that proxy for next time. On failure, moves to the next.
 * @param {string} url  the direct arXiv API URL
 * @param {AbortSignal} [signal]
 * @returns {Promise<Object[]>}
 */
async function fetchAndParseArticles(url, signal) {
  let lastErr = null;

  for (let i = 0; i < PROXY_LIST.length; i++) {
    const idx = (_proxyIdx + i) % PROXY_LIST.length;
    const proxy = PROXY_LIST[idx];
    const fetchUrl = proxy ? proxy + encodeURIComponent(url) : url;

    try {
      const res = await fetch(fetchUrl, signal ? { signal } : undefined);
      if (!res.ok) {
        const label = proxy ? new URL(proxy).hostname : 'arxiv.org (direct)';
        lastErr = new Error(
          res.status === 429
            ? `${label} is rate-limiting requests (HTTP 429). Trying next option…`
            : `HTTP ${res.status} from ${label}`
        );
        continue; // try next proxy
      }
      const text = await res.text();
      const articles = parseAtomXML(text);
      // Remember this proxy as working
      if (idx !== _proxyIdx) {
        _proxyIdx = idx;
        try { localStorage.setItem(PROXY_STORAGE_KEY, String(idx)); } catch (_) {}
      }
      return articles;
    } catch (e) {
      if (e.name === 'AbortError') throw e;
      lastErr = e;
      // Network/CORS error — try next proxy
    }
  }

  throw lastErr || new Error('All CORS proxies failed. Try again later.');
}

/**
 * Parse an arXiv Atom XML response into article objects.
 * @param {string} xmlText
 * @returns {Object[]}
 */
function parseAtomXML(xmlText) {
  const parser = new DOMParser();
  const doc = parser.parseFromString(xmlText, 'application/xml');

  const parseError = doc.querySelector('parsererror');
  if (parseError) throw new Error('arXiv returned malformed XML');

  const entries = doc.querySelectorAll('entry');
  const articles = [];

  for (const entry of entries) {
    // Raw ID like "http://arxiv.org/abs/2401.12345v1"
    const rawId = entry.querySelector('id')?.textContent?.trim() || '';
    const idMatch = rawId.match(/abs\/([^v\s]+)/);
    const id = idMatch ? idMatch[1] : rawId;

    const title = (entry.querySelector('title')?.textContent || '').trim().replace(/\s+/g, ' ');
    const abstract = (entry.querySelector('summary')?.textContent || '').trim().replace(/\s+/g, ' ');

    const authors = [...entry.querySelectorAll('author name')]
      .map(n => n.textContent.trim())
      .filter(Boolean);

    // All category terms
    const categories = [...entry.querySelectorAll('category')]
      .map(c => c.getAttribute('term'))
      .filter(Boolean);

    // Primary category — arXiv uses a namespaced element
    let primaryCategory = categories[0] || '';
    const allEls = entry.getElementsByTagName('*');
    for (const el of allEls) {
      if (el.localName === 'primary_category') {
        primaryCategory = el.getAttribute('term') || primaryCategory;
        break;
      }
    }

    // Links — parse abs, pdf, and html refs from the Atom feed.
    let absUrl = '', pdfUrl = '', htmlUrl = '';
    for (const link of entry.querySelectorAll('link')) {
      const rel   = link.getAttribute('rel');
      const title = link.getAttribute('title');
      const href  = (link.getAttribute('href') || '').replace('http://', 'https://');
      if (rel === 'alternate') absUrl = href;
      if (title === 'pdf')     pdfUrl = href;
      if (title === 'html')    htmlUrl = href;
    }
    // Fallback URLs — always present so buttons are always shown
    if (!absUrl)  absUrl  = `https://arxiv.org/abs/${id}`;
    if (!pdfUrl)  pdfUrl  = `https://arxiv.org/pdf/${id}`;
    if (!htmlUrl) htmlUrl = `https://arxiv.org/html/${id}`;

    articles.push({
      id,
      title,
      abstract,
      authors,
      authorsDisplay: truncateAuthors(authors), // precomputed — avoids double call in template
      categories,
      primaryCategory,
      absUrl,
      pdfUrl,
      htmlUrl,
      published: entry.querySelector('published')?.textContent?.trim() || '',
      updated:   entry.querySelector('updated')?.textContent?.trim() || '',
      isCrosslist: false,
    });
  }

  return articles;
}

/**
 * Mark articles as cross-listed when their primary category is not in the
 * user's selected set (they appear only because of a secondary category).
 * Handles both leaf IDs (astro-ph.CO) and parent IDs (astro-ph).
 */
function markCrossLists(articles, selectedSet) {
  return articles.map(article => {
    const primary  = article.primaryCategory;
    const parentId = primary.includes('.') ? primary.split('.')[0] : null;
    const isInSelected =
      selectedSet.has(primary) ||
      (parentId && selectedSet.has(parentId));
    return { ...article, isCrosslist: !isInSelected };
  });
}

/**
 * Return a truncated author string, e.g. "Smith J., Jones A., Lee K. +4 more"
 * Full list is also returned for expanded view.
 */
function truncateAuthors(authors, max = 3) {
  if (authors.length <= max) {
    return { short: authors.join(', '), full: authors.join(', '), truncated: false };
  }
  const shown  = authors.slice(0, max).join(', ');
  const extra  = authors.length - max;
  return {
    short: `${shown} +${extra} more`,
    full: authors.join(', '),
    truncated: true,
  };
}

/**
 * Try native share (mobile), fall back to clipboard copy.
 * Returns a promise that resolves when done (may throw on hard failure).
 */
async function shareUrl(url, title) {
  if (navigator.share) {
    try {
      await navigator.share({ title, url });
      return 'shared';
    } catch (e) {
      if (e.name === 'AbortError') return 'aborted';
      // Fall through to clipboard
    }
  }
  await navigator.clipboard.writeText(url);
  return 'copied';
}

/**
 * Build a mailto: link for the given list of articles.
 */
function composeMail(articles, dateLabel) {
  const subject = `arXiv papers — ${dateLabel}`;
  const body = articles.map(a => `${a.title}\n${a.absUrl}`).join('\n\n');
  return `mailto:?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`;
}
