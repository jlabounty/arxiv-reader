# daily arXiv

A modern, fully static arXiv preprint browser — deployable on GitHub Pages with zero
build tooling.

Browse recent papers by subject area and date. Save a reading list, share individual
abstracts, or send your saved papers by email.

---

## Features

- **Category browser** — full arXiv subject tree with accordion groups and per-area
  sub-category selection
- **Calendar date picker** — click any past weekday to jump to that day's listings
- **Article cards** — title, truncated author list (expandable), abstract on demand,
  category badge, and cross-listing detection
- **Per-article actions** — Abstract page, PDF download, HTML5 viewer (ar5iv), and
  one-click Share (native share sheet on mobile, clipboard fallback on desktop)
- **Reading list** — bookmark papers with ★; list persists across sessions via
  `localStorage`; shareable via URL (`#/id_list?ids=...`) and email
- **No server required** — the arXiv API already serves permissive CORS headers,
  so all requests go directly from the browser to `export.arxiv.org`
- **No build step** — Vue 3 is loaded from a CDN `<script>` tag; just open
  `index.html` via any HTTP server

---

## Running Locally

Because `fetch()` requires an HTTP origin (not a `file://` URL), serve the project
with any local server:

```bash
# Python 3
python3 -m http.server 8080

# Node (npx)
npx serve .
```

Then open `http://localhost:8080` in your browser.

---

## Deploying to GitHub Pages

1. Push this repository to GitHub.
2. Go to **Settings → Pages** and set the source to the `main` branch, root folder.
3. GitHub Pages will serve `index.html` directly — no build required.

---

## File Structure

```
index.html              Single-page app entry point + Vue template
css/
  style.css             All styles (CSS custom properties, responsive)
js/
  date-utils.js         arXiv date logic: previousArxivDay, calendar grid, formatting
  arxiv-database.js     Full arXiv category tree (all 9 groups, 150+ categories)
  arxiv-api.js          fetch() + DOMParser XML parsing; query URL builders
  app.js                Vue 3 Composition API: routing, state, event handlers
```

---

## Tech Stack

| Concern      | Solution |
|---|---|
| Framework    | Vue 3 (CDN, no build) |
| Routing      | `window.location.hash` + `hashchange` |
| HTTP         | Native `fetch()` direct to arXiv API |
| XML parsing  | Native `DOMParser` |
| Persistence  | `localStorage` |
| Fonts        | Inter via Google Fonts |
| Deployment   | GitHub Pages (pure static) |

---

## Attribution & Inspiration

This project is a modernized reimplementation inspired by
**[dailyarxiv](https://github.com/juanjosegarciaripoll/dailyarxiv)** by
[@juanjosegarciaripoll](https://github.com/juanjosegarciaripoll).

The original site is built on AngularJS 1.x with a PHP backend (`query.php`) that
acts as a CORS proxy to the arXiv API. Key ideas and domain logic ported from the
original include:

- The hierarchical arXiv category database structure (`makeArxivDatabase()`)
- The `previousArxivDay()` / `nextArxivDay()` date logic that accounts for arXiv's
  weekday-only publication schedule
- The cross-listing detection heuristic (primary category vs. selected categories)
- The reading list share URL scheme (`#/id_list?ids=...`)
- The email composition helper

The modernization eliminates the PHP proxy (the arXiv API already sends
`Access-Control-Allow-Origin: *`), replaces AngularJS with Vue 3, and adds a
redesigned UI, native `fetch()` / `DOMParser` XML handling, and `localStorage`
persistence — all without any build toolchain.

---

## arXiv API

**Endpoint:** `https://export.arxiv.org/api/query`
**Method:** GET
**Format:** Atom 1.0 XML
**Rate limit:** 1 request / 3 s (user-triggered, not an issue in practice)

Example query:
```
https://export.arxiv.org/api/query
  ?search_query=(cat:hep-ex+OR+cat:hep-ph)+AND+lastUpdatedDate:[202401150000+TO+202401152359]
  &max_results=800
  &sortBy=submittedDate&sortOrder=descending
```

---

## License

MIT
