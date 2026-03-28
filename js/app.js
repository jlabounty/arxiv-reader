/* app.js — Vue 3 Composition API application (global scope, mounted to #app) */

const { createApp, ref, computed, watch, onMounted } = Vue;

const STORAGE_KEY_CATS    = 'dailyarxiv.categories';
const STORAGE_KEY_READING = 'dailyarxiv.readingList';

createApp({
  setup() {
    /* ── Routing ──────────────────────────────────────────────── */
    const view = ref('selector'); // 'selector' | 'list' | 'idlist' | 'mdview'

    function parseHash() {
      const raw   = window.location.hash.replace(/^#/, '');
      const sep   = raw.indexOf('?');
      const path  = sep === -1 ? raw : raw.slice(0, sep);
      const qs    = sep === -1 ? '' : raw.slice(sep + 1);
      const params = new URLSearchParams(qs);

      if (path === '/list')    return { view: 'list',     query: params.get('query') || '', date: params.get('date') || '' };
      if (path === '/id_list') return { view: 'idlist',   ids:   params.get('ids')   || '' };
      if (path === '/md')      return { view: 'mdview',   query: params.get('query') || '', date: params.get('date') || '' };
      return { view: 'selector' };
    }

    function pushHash(newView, params = {}) {
      if (newView === 'list') {
        const p = new URLSearchParams({ query: params.query, date: params.date });
        window.location.hash = `/list?${p.toString()}`;
      } else if (newView === 'idlist') {
        window.location.hash = `/id_list?ids=${params.ids}`;
      } else {
        window.location.hash = '/';
      }
    }

    /* ── Calendar state ───────────────────────────────────────── */
    const initialDate = latestArxivDay();

    const currentDate = ref(initialDate);
    const calYear     = ref(initialDate.getFullYear());
    const calMonth    = ref(initialDate.getMonth());

    const calDays = computed(() => buildCalendarDays(calYear.value, calMonth.value));
    const calMonthLabel = computed(() =>
      new Date(calYear.value, calMonth.value, 1)
        .toLocaleDateString('en-US', { month: 'long', year: 'numeric' })
    );

    function prevCalMonth() {
      if (calMonth.value === 0) { calMonth.value = 11; calYear.value--; }
      else calMonth.value--;
    }
    function nextCalMonth() {
      // Don't navigate beyond current month (covers year boundary too)
      const now = new Date();
      if (calYear.value > now.getFullYear() ||
          (calYear.value === now.getFullYear() && calMonth.value >= now.getMonth())) return;
      if (calMonth.value === 11) { calMonth.value = 0; calYear.value++; }
      else calMonth.value++;
    }

    function selectCalDay(cell) {
      if (!cell.isAvailable) return;
      currentDate.value = new Date(cell.date);
    }
    function isSelectedDay(cell) {
      return !cell.empty && isoDate(cell.date) === isoDate(currentDate.value);
    }

    function goToday() {
      const d = latestArxivDay();
      currentDate.value = d;
      calYear.value  = d.getFullYear();
      calMonth.value = d.getMonth();
    }

    /* ── Category selection ───────────────────────────────────── */
    const selectedCats   = ref(new Set());
    const expandedGroups = ref(new Set());
    const expandedAreas  = ref(new Set());

    function saveCategories() {
      try { localStorage.setItem(STORAGE_KEY_CATS, JSON.stringify([...selectedCats.value])); }
      catch (_) {}
    }
    function loadCategories() {
      try {
        const raw = localStorage.getItem(STORAGE_KEY_CATS);
        if (raw) selectedCats.value = new Set(JSON.parse(raw));
      } catch (_) {}
    }

    function toggleGroup(groupId) {
      const s = new Set(expandedGroups.value);
      s.has(groupId) ? s.delete(groupId) : s.add(groupId);
      expandedGroups.value = s;
    }
    function toggleAreaExpand(areaId) {
      const s = new Set(expandedAreas.value);
      s.has(areaId) ? s.delete(areaId) : s.add(areaId);
      expandedAreas.value = s;
    }

    // Is every leaf under this area selected?
    function isAreaAllSelected(area) {
      const ids = getLeafIds(area);
      return ids.length > 0 && ids.every(id => selectedCats.value.has(id));
    }
    // Is at least one (but not all) leaf selected?
    function isAreaPartial(area) {
      const ids = getLeafIds(area);
      return ids.some(id => selectedCats.value.has(id)) && !isAreaAllSelected(area);
    }

    function toggleArea(area) {
      const ids = getLeafIds(area);
      const s = new Set(selectedCats.value);
      if (isAreaAllSelected(area)) {
        ids.forEach(id => s.delete(id));
      } else {
        ids.forEach(id => s.add(id));
      }
      selectedCats.value = s;
      saveCategories();
    }
    function toggleLeaf(id) {
      const s = new Set(selectedCats.value);
      s.has(id) ? s.delete(id) : s.add(id);
      selectedCats.value = s;
      saveCategories();
    }

    // Count selected leaves in a group
    function groupSelCount(group) {
      let n = 0;
      for (const area of group.subcategories) {
        const ids = getLeafIds(area);
        n += ids.filter(id => selectedCats.value.has(id)).length;
      }
      return n;
    }

    function selectAllGroup(group) {
      const s = new Set(selectedCats.value);
      for (const area of group.subcategories) {
        getLeafIds(area).forEach(id => s.add(id));
      }
      selectedCats.value = s;
      saveCategories();
    }
    function deselectAllGroup(group) {
      const s = new Set(selectedCats.value);
      for (const area of group.subcategories) {
        getLeafIds(area).forEach(id => s.delete(id));
      }
      selectedCats.value = s;
      saveCategories();
    }
    function isGroupAllSelected(group) {
      return group.subcategories.every(a => isAreaAllSelected(a));
    }

    const hasSelections = computed(() => selectedCats.value.size > 0);

    const selectionSummary = computed(() => {
      const q = buildQueryFromSelected(selectedCats.value);
      if (!q) return '';
      const cats = q.split(' OR ').map(s => s.replace('cat:', ''));
      if (cats.length <= 3) return cats.join(', ');
      return `${cats.slice(0, 3).join(', ')} +${cats.length - 3} more`;
    });

    /* ── Article list state ───────────────────────────────────── */
    const articles          = ref([]);
    const loading           = ref(false);
    const error             = ref(null);
    const expandedAbstracts = ref(new Set());
    const activeQuery       = ref('');   // the query string used for the current list
    const activeDate        = ref(null); // Date object
    const catFilter         = ref(null); // null = all shown; Set<string> = only these cats

    // AbortController for the in-flight article list request.
    // Aborting cancels the network request so the proxy never receives it.
    let listAbort = null;

    async function fetchArticleList(query, date) {
      // Cancel any in-flight request before starting a new one
      if (listAbort) { listAbort.abort(); }
      listAbort = new AbortController();
      const signal = listAbort.signal;

      loading.value  = true;
      error.value    = null;
      articles.value = [];
      catFilter.value   = null;
      activeQuery.value = query;
      activeDate.value  = date;

      // Sync calendar to the fetched date
      currentDate.value = date;
      calYear.value  = date.getFullYear();
      calMonth.value = date.getMonth();

      const url = buildSearchUrl(query, date);
      const queriedIds = new Set(
        query.split(' OR ').map(s => s.replace('cat:', '').trim())
      );

      // One automatic retry on 429 after a 3 s backoff
      for (let attempt = 0; attempt < 2; attempt++) {
        try {
          const fetched = await fetchAndParseArticles(url, signal);
          articles.value = markCrossLists(fetched, queriedIds);
          break; // success — exit retry loop
        } catch (e) {
          if (e.name === 'AbortError') return;
          const is429 = e.message && e.message.includes('rate-limit');
          if (is429 && attempt === 0) {
            // Brief pause then try once more
            await new Promise(res => setTimeout(res, 3000));
            if (signal.aborted) return;
            continue;
          }
          error.value = e.message || 'Failed to fetch articles from arXiv.';
          break;
        }
      }

      if (!signal.aborted) loading.value = false;
    }

    /* ── ID List (reading list / shared link) ─────────────────── */
    const idListArticles = ref([]);
    const idListLoading  = ref(false);
    const idListError    = ref(null);

    async function fetchIdList(ids) {
      idListLoading.value  = true;
      idListError.value    = null;
      idListArticles.value = [];
      try {
        const url     = buildIdListUrl(ids);
        idListArticles.value = await fetchAndParseArticles(url);
      } catch (e) {
        idListError.value = e.message || 'Failed to fetch articles.';
      } finally {
        idListLoading.value = false;
      }
    }

    /* ── Abstract expand / collapse ──────────────────────────── */
    function toggleAbstract(id) {
      const s = new Set(expandedAbstracts.value);
      s.has(id) ? s.delete(id) : s.add(id);
      expandedAbstracts.value = s;
    }
    function isExpanded(id) { return expandedAbstracts.value.has(id); }

    /* ── Navigation ──────────────────────────────────────────── */
    function goToList() {
      const query = buildQueryFromSelected(selectedCats.value);
      if (!query) return;
      pushHash('list', { query, date: isoDate(currentDate.value) });
    }

    function goBack() { pushHash('selector'); }

    function prevDay() {
      const newDate = previousArxivDay(activeDate.value || currentDate.value);
      const hash = parseHash();
      pushHash('list', { query: hash.query || activeQuery.value, date: isoDate(newDate) });
    }
    function nextDay() {
      const newDate = nextArxivDay(activeDate.value || currentDate.value);
      if (isoDate(newDate) === isoDate(activeDate.value || currentDate.value)) return;
      const hash = parseHash();
      pushHash('list', { query: hash.query || activeQuery.value, date: isoDate(newDate) });
    }
    const atLatest = computed(() => {
      if (!activeDate.value) return true;
      return isoDate(activeDate.value) >= isoDate(latestArxivDay());
    });
    function goLatestDay() {
      const hash = parseHash();
      pushHash('list', { query: hash.query || activeQuery.value, date: 'latest' });
    }

    const listDateLabel = computed(() =>
      activeDate.value ? formatShortDate(activeDate.value) : ''
    );
    const listDateFull = computed(() =>
      activeDate.value ? formatDisplayDate(activeDate.value) : ''
    );

    /* ── Reading list ─────────────────────────────────────────── */
    const readingList = ref(new Set());

    function saveReadingList() {
      try { localStorage.setItem(STORAGE_KEY_READING, JSON.stringify([...readingList.value])); }
      catch (_) {}
    }
    function loadReadingList() {
      try {
        const raw = localStorage.getItem(STORAGE_KEY_READING);
        if (raw) readingList.value = new Set(JSON.parse(raw));
      } catch (_) {}
    }

    function toggleBookmark(id) {
      const s = new Set(readingList.value);
      s.has(id) ? s.delete(id) : s.add(id);
      readingList.value = s;
      saveReadingList();
    }
    function isBookmarked(id) { return readingList.value.has(id); }

    const readingCount = computed(() => readingList.value.size);

    const readingListShareUrl = computed(() => {
      if (readingList.value.size === 0) return '';
      const ids = [...readingList.value].join(',');
      return `${location.origin}${location.pathname}#/id_list?ids=${ids}`;
    });

    function goReadingList() {
      if (readingList.value.size === 0) return;
      const ids = [...readingList.value].join(',');
      pushHash('idlist', { ids });
    }

    const emailLink = computed(() => {
      const arts = (view.value === 'idlist' ? idListArticles.value : articles.value)
        .filter(a => readingList.value.has(a.id));
      if (arts.length === 0) return '';
      return composeMail(arts, listDateFull.value || 'arXiv');
    });

    /* ── Toast ─────────────────────────────────────────────────── */
    const toast = ref(null);
    let toastTimer = null;
    function showToast(msg) {
      toast.value = msg;
      clearTimeout(toastTimer);
      toastTimer = setTimeout(() => { toast.value = null; }, 2000);
    }

    /* ── Export ─────────────────────────────────────────────────── */
    function exportPage(format) {
      const arts = view.value === 'idlist' ? idListArticles.value : filteredArticles.value;
      if (arts.length === 0) return;

      const dateLabel = view.value === 'list' && activeDate.value
        ? isoDate(activeDate.value)
        : 'reading-list';

      let content, mime, ext;

      if (format === 'json') {
        content = JSON.stringify(arts.map(a => ({
          id:              a.id,
          title:           a.title,
          authors:         a.authors,
          primaryCategory: a.primaryCategory,
          categories:      a.categories,
          abstract:        a.abstract,
          absUrl:          a.absUrl,
          pdfUrl:          a.pdfUrl,
          ...(a.htmlUrl ? { htmlUrl: a.htmlUrl } : {}),
        })), null, 2);
        mime = 'application/json';
        ext  = 'json';
      } else {
        const heading = view.value === 'list'
          ? `# arXiv Papers — ${listDateFull.value}\n\nCategories: ${listCatLabels.value.join(', ')}\n\n`
          : '# arXiv Reading List\n\n';
        content = heading + arts.map(a => [
          `## ${a.title}`,
          '',
          `**Authors:** ${a.authors.join(', ')}`,
          `**Category:** ${a.primaryCategory}`,
          `**arXiv:** ${a.absUrl}`,
          '',
          a.abstract,
          '',
          '---',
        ].join('\n')).join('\n\n');
        mime = 'text/markdown';
        ext  = 'md';
      }

      const filename = `arxiv-${dateLabel}.${ext}`;

      // Prefer the native share sheet (mobile) — lets the user copy/paste directly.
      // Fall back to a blob download on desktop where share is unavailable.
      if (navigator.share) {
        navigator.share({ title: filename, text: content }).catch(() => {});
        return;
      }

      const blob = new Blob([content], { type: mime });
      const blobUrl = URL.createObjectURL(blob);
      const anchor = document.createElement('a');
      anchor.href = blobUrl;
      anchor.download = filename;
      document.body.appendChild(anchor);
      anchor.click();
      document.body.removeChild(anchor);
      URL.revokeObjectURL(blobUrl);
    }

    /* ── Share ──────────────────────────────────────────────────── */
    async function shareArticle(article) {
      try {
        const result = await shareUrl(article.absUrl, article.title);
        if (result === 'copied') showToast('Link copied!');
      } catch (_) {
        showToast('Could not copy link');
      }
    }
    async function shareReadingList() {
      if (!readingListShareUrl.value) return;
      try {
        const result = await shareUrl(readingListShareUrl.value, 'My arXiv Reading List');
        if (result === 'copied') showToast('Reading list URL copied!');
      } catch (_) {
        showToast('Could not copy URL');
      }
    }

    /* ── Markdown view ──────────────────────────────────────────── */
    const mdviewContent  = ref('');
    const mdviewLoading  = ref(false);
    const mdviewError    = ref(null);
    const mdviewQuery    = ref('');
    const mdviewDate     = ref('');

    function buildMarkdown(arts, query, dateStr) {
      const cats = query.split(' OR ').map(s => s.replace('cat:', '')).join(', ');
      const heading = `# arXiv Papers — ${dateStr}\n\nCategories: ${cats}\n\n`;
      return heading + arts.map(a => [
        `## ${a.title}`,
        '',
        `**Authors:** ${a.authors.join(', ')}`,
        `**Category:** ${a.primaryCategory}`,
        `**arXiv:** ${a.absUrl}`,
        '',
        a.abstract,
        '',
        '---',
      ].join('\n')).join('\n\n');
    }

    // The permanent URL for the current list as a markdown view
    const mdviewUrl = computed(() => {
      if (!activeQuery.value || !activeDate.value) return '';
      const p = new URLSearchParams({ query: activeQuery.value, date: isoDate(activeDate.value) });
      return `${location.origin}${location.pathname}#/md?${p.toString()}`;
    });

    async function copyMdUrl() {
      if (!mdviewUrl.value) return;
      try {
        const result = await shareUrl(mdviewUrl.value, 'arXiv markdown view');
        if (result === 'copied') showToast('Markdown URL copied!');
      } catch (_) {
        showToast('Could not copy URL');
      }
    }

    function downloadMdview() {
      if (!mdviewContent.value) return;
      const blob   = new Blob([mdviewContent.value], { type: 'text/markdown' });
      const blobUrl = URL.createObjectURL(blob);
      const anchor = document.createElement('a');
      anchor.href = blobUrl;
      anchor.download = `arxiv-${mdviewDate.value}.md`;
      document.body.appendChild(anchor);
      anchor.click();
      document.body.removeChild(anchor);
      URL.revokeObjectURL(blobUrl);
    }

    /* ── Helpers for template ─────────────────────────────────── */
    const listCatLabels = computed(() => {
      if (!activeQuery.value) return [];
      return activeQuery.value.split(' OR ').map(s => s.replace('cat:', ''));
    });

    function catMatchesFilter(primaryCategory, filterSet) {
      if (filterSet.has(primaryCategory)) return true;
      for (const cat of filterSet) {
        if (primaryCategory.startsWith(cat + '.')) return true;
      }
      return false;
    }

    const filteredArticles = computed(() => {
      if (!catFilter.value) return articles.value;
      return articles.value.filter(a => catMatchesFilter(a.primaryCategory, catFilter.value));
    });

    const mainArticles = computed(() =>
      filteredArticles.value.filter(a => !a.isCrosslist)
    );
    const crosslistArticles = computed(() =>
      filteredArticles.value.filter(a => a.isCrosslist)
    );

    function toggleCatFilter(cat) {
      const current = catFilter.value ?? new Set(listCatLabels.value);
      const next = new Set(current);
      next.has(cat) ? next.delete(cat) : next.add(cat);
      catFilter.value = next.size === listCatLabels.value.length ? null : next;
    }
    function isCatFilterActive(cat) {
      return catFilter.value === null || catFilter.value.has(cat);
    }

    /* ── Hash routing ─────────────────────────────────────────── */
    async function handleRoute() {
      const route = parseHash();
      view.value = route.view;

      if (route.view === 'list' && route.query && route.date) {
        activeQuery.value = route.query;
        const resolvedDate = route.date === 'latest' ? isoDate(latestArxivDay()) : route.date;
        await fetchArticleList(route.query, dateFromIso(resolvedDate));
      } else if (route.view === 'idlist' && route.ids) {
        await fetchIdList(route.ids.split(',').filter(Boolean));
      } else if (route.view === 'mdview' && route.query && route.date) {
        mdviewQuery.value = route.query;
        mdviewDate.value  = route.date;
        mdviewLoading.value = true;
        mdviewError.value   = null;
        mdviewContent.value = '';
        try {
          const url  = buildSearchUrl(route.query, dateFromIso(route.date));
          const arts = await fetchAndParseArticles(url);
          mdviewContent.value = buildMarkdown(arts, route.query, route.date);
          document.title = `arXiv MD — ${route.date}`;
        } catch (e) {
          mdviewError.value = e.message || 'Failed to fetch articles.';
        } finally {
          mdviewLoading.value = false;
        }
      }
    }

    window.addEventListener('hashchange', handleRoute);

    /* ── Mount ────────────────────────────────────────────────── */
    onMounted(() => {
      loadCategories();
      loadReadingList();
      handleRoute();
    });

    /* ── Skeleton count ───────────────────────────────────────── */
    const skeletons = [1, 2, 3, 4, 5];

    /* ── Expose to template ───────────────────────────────────── */
    return {
      // Data
      ARXIV_DATABASE,
      view,
      // Calendar
      calDays, calMonthLabel, currentDate,
      prevCalMonth, nextCalMonth, selectCalDay, isSelectedDay, goToday,
      // Categories
      selectedCats, expandedGroups, expandedAreas,
      toggleGroup, toggleAreaExpand,
      isAreaAllSelected, isAreaPartial,
      toggleArea, toggleLeaf,
      groupSelCount, selectAllGroup, deselectAllGroup, isGroupAllSelected,
      hasSelections, selectionSummary,
      getLeafIds,
      // Articles
      articles, loading, error, skeletons,
      mainArticles, crosslistArticles, listCatLabels, filteredArticles,
      catFilter, toggleCatFilter, isCatFilterActive,
      listDateLabel, listDateFull, atLatest, goLatestDay,
      activeQuery, activeDate,
      expandedAbstracts,
      toggleAbstract, isExpanded,
      retry: () => { if (activeQuery.value && activeDate.value) fetchArticleList(activeQuery.value, activeDate.value); },
      // Navigation
      goToList, goBack, prevDay, nextDay,
      // Reading list
      readingList, readingCount,
      toggleBookmark, isBookmarked,
      goReadingList,
      idListArticles, idListLoading, idListError,
      readingListShareUrl,
      emailLink,
      shareReadingList,
      // Export
      exportPage,
      // Markdown view
      mdviewContent, mdviewLoading, mdviewError, mdviewUrl, copyMdUrl, downloadMdview,
      // Toast & share
      toast, shareArticle,
      // Utils (used in template)
      isoDate, formatDisplayDate,
    };
  },
}).mount('#app');
