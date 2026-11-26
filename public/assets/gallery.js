/* Landing page: public galleries with search, filters and pagination. */
(function () {
  'use strict';

  const { api, escapeHtml, formatDate, toast } = window.CC;

  const state = { type: '', search: '', category: '', location: '', sort: 'newest', page: 1, limit: 12 };
  const gallery = document.getElementById('gallery');
  const pager = document.getElementById('pager');
  const resultCount = document.getElementById('resultCount');
  const categoryIcons = {
    Electronics: '▣', Books: '▤', 'ID Cards': '▧', Bags: '▱', Clothing: '◇',
    Accessories: '✧', Documents: '▦', Keys: '⚿', Other: '◈',
  };

  function card(item) {
    const img = item.images && item.images[0];
    const media = img
      ? '<img src="' + escapeHtml(img.url) + '" alt="' + escapeHtml(item.title) + '" loading="lazy" width="' + (img.width || 400) + '" height="' + (img.height || 300) + '">'
      : '<span class="placeholder" aria-hidden="true">' + (categoryIcons[item.category] || '◈') + '</span>';

    return (
      '<article class="item-card">' +
        '<a class="item-media" href="item.html?id=' + encodeURIComponent(item.id) + '" aria-label="Open ' + escapeHtml(item.title) + '">' + media + '</a>' +
        '<div class="item-body">' +
          '<div class="row" style="gap:.35rem;">' +
            '<span class="pill ' + escapeHtml(item.type) + '">' + escapeHtml(item.type) + '</span>' +
            window.CC.pill(item.status) +
          '</div>' +
          '<h3><a href="item.html?id=' + encodeURIComponent(item.id) + '" style="color:inherit;">' + escapeHtml(item.title) + '</a></h3>' +
          '<p class="item-desc">' + escapeHtml(item.description) + '</p>' +
          '<div class="item-meta">' +
            '<span>📍 ' + escapeHtml(item.location) + '</span>' +
            '<span>🗓 ' + formatDate(item.occurredOn) + '</span>' +
          '</div>' +
          '<div class="item-meta"><span>' + escapeHtml(item.category) + ' · ' + escapeHtml(item.owner.name) + '</span></div>' +
        '</div>' +
        '<div class="item-cta"><a class="btn btn-ghost btn-sm btn-full" href="item.html?id=' + encodeURIComponent(item.id) + '">View details</a></div>' +
      '</article>'
    );
  }

  function skeletons(n) {
    return Array.from({ length: n }, () => '<div class="skeleton"></div>').join('');
  }

  function renderPager(data) {
    if (!pager) return;
    if (data.pages <= 1) {
      pager.innerHTML = '';
      return;
    }
    const prev = data.page > 1;
    const next = data.page < data.pages;
    pager.innerHTML =
      '<button class="btn btn-ghost btn-sm" data-page="' + (data.page - 1) + '"' + (prev ? '' : ' disabled') + '>← Previous</button>' +
      '<span class="muted">Page ' + data.page + ' of ' + data.pages + '</span>' +
      '<button class="btn btn-ghost btn-sm" data-page="' + (data.page + 1) + '"' + (next ? '' : ' disabled') + '>Next →</button>';
    pager.querySelectorAll('[data-page]').forEach((btn) => {
      btn.addEventListener('click', () => {
        state.page = Number(btn.dataset.page);
        load();
        document.getElementById('browse').scrollIntoView({ behavior: 'smooth', block: 'start' });
      });
    });
  }

  async function load() {
    gallery.setAttribute('aria-busy', 'true');
    gallery.innerHTML = skeletons(6);
    const params = new URLSearchParams({ page: state.page, limit: state.limit, sort: state.sort });
    ['type', 'search', 'category', 'location'].forEach((key) => {
      if (state[key]) params.set(key, state[key]);
    });

    try {
      const data = await api('/api/items?' + params.toString());
      gallery.innerHTML = data.items.length
        ? data.items.map(card).join('')
        : '<div class="empty-state" style="grid-column:1/-1;"><div class="icon" aria-hidden="true">🔍</div>' +
          '<h3>No matching listings yet</h3>' +
          '<p>Try a different keyword, category or location — or be the first to report it.</p>' +
          '<a class="btn btn-primary" href="report.html">Report an item</a></div>';

      resultCount.textContent =
        data.total === 0
          ? 'No listings found'
          : data.total + ' listing' + (data.total === 1 ? '' : 's') + ' found';
      renderPager(data);
    } catch (err) {
      gallery.innerHTML =
        '<div class="empty-state" style="grid-column:1/-1;"><div class="icon" aria-hidden="true">⚠️</div>' +
        '<h3>We could not load the listings</h3><p>' + escapeHtml(err.message) + '</p>' +
        '<button class="btn btn-primary" id="retryLoad">Try again</button></div>';
      const retry = document.getElementById('retryLoad');
      if (retry) retry.addEventListener('click', load);
    } finally {
      gallery.setAttribute('aria-busy', 'false');
    }
  }

  async function loadStats() {
    try {
      const data = await api('/api/items/stats/public');
      document.getElementById('statTotal').textContent = data.stats.total;
      document.getElementById('statLost').textContent = data.stats.lost;
      document.getElementById('statFound').textContent = data.stats.found;
      document.getElementById('statReturned').textContent = data.stats.returned;
      const list = document.getElementById('locationList');
      if (list && data.locations) {
        list.innerHTML = data.locations.map((l) => '<option value="' + escapeHtml(l) + '">').join('');
      }
    } catch (err) {
      /* statistics are decorative — a failure must not break the page */
    }
  }

  function syncTabs() {
    document.querySelectorAll('[role="tab"][data-type]').forEach((tab) => {
      tab.setAttribute('aria-selected', String(tab.dataset.type === state.type));
    });
  }

  document.querySelectorAll('[role="tab"][data-type]').forEach((tab) => {
    tab.addEventListener('click', () => {
      state.type = tab.dataset.type;
      state.page = 1;
      syncTabs();
      load();
    });
  });

  const form = document.getElementById('filterForm');
  form.addEventListener('submit', (event) => {
    event.preventDefault();
    state.search = document.getElementById('search').value.trim();
    state.category = document.getElementById('category').value;
    state.location = document.getElementById('location').value.trim();
    state.sort = document.getElementById('sort').value;
    state.page = 1;
    load();
  });

  let debounce;
  document.getElementById('search').addEventListener('input', (event) => {
    clearTimeout(debounce);
    debounce = setTimeout(() => {
      state.search = event.target.value.trim();
      state.page = 1;
      load();
    }, 320);
  });

  document.getElementById('category').addEventListener('change', (event) => {
    state.category = event.target.value;
    state.page = 1;
    load();
  });

  document.getElementById('sort').addEventListener('change', (event) => {
    state.sort = event.target.value;
    state.page = 1;
    load();
  });

  document.getElementById('year').textContent = String(new Date().getFullYear());

  // Deep links: index.html#lost / #found open the matching gallery.
  if (location.hash === '#lost' || location.hash === '#found') {
    state.type = location.hash.slice(1);
    syncTabs();
  }

  loadStats();
  load();
})();
