/* app.js — Vue 3 Composition API application (global scope, mounted to #app) */

const { createApp, ref, computed, watch, onMounted } = Vue;

const STORAGE_KEY_CATS    = 'dailyarxiv.categories';
const STORAGE_KEY_READING = 'dailyarxiv.readingList';

createApp({
  setup() {
    /* ── Routing ──────────────────────────────────────────────── */
    const view = ref('selector'); // 'selector' | 'list' | 'idlist'

    function parseHash() {
      const raw   = window.location.hash.replace(/^#/, '');
      const sep   = raw.indexOf('?');
      const path  = sep === -1 ? raw : raw.slice(0, sep);
      const qs    = sep === -1 ? '' : raw.slice(sep + 1);
      const params = new URLSearchParams(qs);

      if (path === '/list')    return { view: 'list',     query: params.get('query') || '', date: params.get('date') || '' };
      if (path === '/id_list') return { view: 'idlist',   ids:   params.get('ids')   || '' };
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
    const today = new Date();
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
      // Don't navigate beyond current month
      const now = new Date();
      if (calYear.value === now.getFullYear() && calMonth.value === now.getMonth()) return;
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
    const articles         = ref([]);
    const loading          = ref(false);
    const error            = ref(null);
    const expandedAbstracts = ref(new Set());
    const activeQuery      = ref('');   // the query string used for the current list
    const activeDate       = ref(null); // Date object

    async function fetchArticleList(query, date) {
      loading.value  = true;
      error.value    = null;
      articles.value = [];
      activeQuery.value = query;
      activeDate.value  = date;

      // Sync calendar to the fetched date
      currentDate.value = date;
      calYear.value  = date.getFullYear();
      calMonth.value = date.getMonth();

      try {
        const url     = buildSearchUrl(query, date);
        const fetched = await fetchAndParseArticles(url);
        // For cross-list detection, expand the query back into individual IDs
        const queriedIds = new Set(
          query.split(' OR ').map(s => s.replace('cat:', '').trim())
        );
        articles.value = markCrossLists(fetched, queriedIds);
      } catch (e) {
        error.value = e.message || 'Failed to fetch articles from arXiv.';
      } finally {
        loading.value = false;
      }
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

    /* ── Helpers for template ─────────────────────────────────── */
    function articleAuthors(article) {
      return truncateAuthors(article.authors);
    }

    const mainArticles = computed(() =>
      articles.value.filter(a => !a.isCrosslist)
    );
    const crosslistArticles = computed(() =>
      articles.value.filter(a => a.isCrosslist)
    );
    const listCatLabels = computed(() => {
      if (!activeQuery.value) return [];
      return activeQuery.value.split(' OR ').map(s => s.replace('cat:', ''));
    });

    /* ── Hash routing ─────────────────────────────────────────── */
    async function handleRoute() {
      const route = parseHash();
      view.value = route.view;

      if (route.view === 'list' && route.query && route.date) {
        activeQuery.value = route.query;
        await fetchArticleList(route.query, dateFromIso(route.date));
      } else if (route.view === 'idlist' && route.ids) {
        await fetchIdList(route.ids.split(',').filter(Boolean));
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
      mainArticles, crosslistArticles, listCatLabels,
      listDateLabel, listDateFull, atLatest,
      activeQuery, activeDate,
      expandedAbstracts,
      toggleAbstract, isExpanded,
      articleAuthors,
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
      // Toast & share
      toast, shareArticle,
      // Utils (used in template)
      isoDate, formatDisplayDate,
    };
  },
}).mount('#app');
