// 活动流水前端。不接 SSE：activity 是历史流水，按需刷新即可。
const PAGE_SIZE = 100;
const AUTOREFRESH_MS = 60_000;

const state = {
  items: [],
  loading: false,
  type: '',
  side: '',
  offset: 0,
  hasMore: false,
};

const els = {
  status: document.querySelector('#status'),
  refreshBtn: document.querySelector('#refreshBtn'),
  typeFilter: document.querySelector('#typeFilter'),
  sideFilter: document.querySelector('#sideFilter'),
  totalCount: document.querySelector('#totalCount'),
  buyVolume: document.querySelector('#buyVolume'),
  sellVolume: document.querySelector('#sellVolume'),
  activityList: document.querySelector('#activityList'),
  loadMoreBtn: document.querySelector('#loadMoreBtn'),
};

const money = new Intl.NumberFormat('en-US', {
  style: 'currency',
  currency: 'USD',
  maximumFractionDigits: 2,
});

const number = new Intl.NumberFormat('en-US', {
  maximumFractionDigits: 4,
});

function formatMoney(value) {
  return money.format(Number(value || 0));
}

function formatNumber(value) {
  return number.format(Number(value || 0));
}

function formatPrice(value) {
  const n = Number(value || 0);
  return Number.isFinite(n) ? n.toFixed(4) : '--';
}

function formatTime(seconds) {
  const ts = Number(seconds);
  if (!Number.isFinite(ts) || ts <= 0) return '--';
  return new Date(ts * 1000).toLocaleString('zh-CN', { hour12: false });
}

function shortHash(hash) {
  const text = String(hash || '');
  if (text.length <= 12) return text || '--';
  return `${text.slice(0, 6)}…${text.slice(-4)}`;
}

function setStatus(message) {
  els.status.textContent = message;
}

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, char => {
    const map = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#039;' };
    return map[char];
  });
}

function typeClass(type) {
  switch (String(type || '').toUpperCase()) {
    case 'TRADE':
      return 'tag tag-trade';
    case 'REDEEM':
      return 'tag tag-redeem';
    case 'SPLIT':
      return 'tag tag-split';
    case 'MERGE':
      return 'tag tag-merge';
    case 'REWARD':
      return 'tag tag-reward';
    case 'CONVERSION':
      return 'tag tag-conversion';
    default:
      return 'tag';
  }
}

function sideClass(side) {
  const normalized = String(side || '').toUpperCase();
  if (normalized === 'BUY') return 'side side-buy';
  if (normalized === 'SELL') return 'side side-sell';
  return 'side';
}

function renderSummary() {
  els.totalCount.textContent = String(state.items.length);
  const buyVolume = state.items
    .filter(item => String(item.side).toUpperCase() === 'BUY')
    .reduce((sum, item) => sum + Number(item.usdcSize || 0), 0);
  const sellVolume = state.items
    .filter(item => String(item.side).toUpperCase() === 'SELL')
    .reduce((sum, item) => sum + Number(item.usdcSize || 0), 0);
  els.buyVolume.textContent = formatMoney(buyVolume);
  els.sellVolume.textContent = formatMoney(sellVolume);
}

function renderList() {
  if (state.items.length === 0) {
    els.activityList.innerHTML = '<div class="empty">暂无活动</div>';
    return;
  }

  els.activityList.replaceChildren(
    ...state.items.map(item => {
      const row = document.createElement('article');
      row.className = 'activity-row';

      const time = document.createElement('div');
      time.className = 'col-time';
      time.textContent = formatTime(item.timestamp);

      const market = document.createElement('div');
      market.className = 'col-market';
      const outcomeLabel = item.outcome ? escapeHtml(item.outcome) : '—';
      market.innerHTML = `
        <div class="title">${escapeHtml(item.title)}</div>
        <div class="meta">
          <span>${outcomeLabel}</span>
        </div>
      `;

      const type = document.createElement('div');
      type.className = 'col-type';
      const side = String(item.side || '').toUpperCase();
      const sideHtml = side
        ? `<span class="${sideClass(side)}">${escapeHtml(side)}</span>`
        : '';
      type.innerHTML = `<span class="${typeClass(item.type)}">${escapeHtml(item.type || '--')}</span>${sideHtml}`;

      const detail = document.createElement('div');
      detail.className = 'col-detail';
      const sizeText = item.size !== undefined && item.size !== '' ? formatNumber(item.size) : '--';
      const priceText = item.price !== undefined && item.price !== '' ? formatPrice(item.price) : '--';
      detail.innerHTML = `
        <div><span>数量</span><b>${sizeText}</b></div>
        <div><span>价格</span><b>${priceText}</b></div>
      `;

      const amount = document.createElement('div');
      amount.className = 'col-amount';
      const usdc = Number(item.usdcSize || 0);
      const amountClass = side === 'SELL' ? 'gain' : side === 'BUY' ? 'loss' : '';
      amount.innerHTML = `<b class="${amountClass}">${formatMoney(usdc)}</b>`;

      const tx = document.createElement('div');
      tx.className = 'col-tx';
      const hash = String(item.transactionHash || '');
      if (hash) {
        tx.innerHTML = `<a class="tx-link" href="https://polygonscan.com/tx/${encodeURIComponent(hash)}" target="_blank" rel="noopener noreferrer">${shortHash(hash)}</a>`;
      } else {
        tx.innerHTML = '<span class="muted">--</span>';
      }

      row.append(time, market, type, detail, amount, tx);
      return row;
    })
  );
}

function render() {
  renderList();
  renderSummary();
  els.loadMoreBtn.hidden = !state.hasMore || state.items.length === 0;
}

function buildQuery(limit = PAGE_SIZE, offset = state.offset) {
  const params = new URLSearchParams({
    limit: String(limit),
    offset: String(offset),
  });
  if (state.type) params.set('type', state.type);
  if (state.side) params.set('side', state.side);
  return params.toString();
}

async function loadActivities({ append } = { append: false }) {
  if (state.loading) return;
  state.loading = true;
  els.refreshBtn.disabled = true;
  if (append) {
    els.loadMoreBtn.disabled = true;
    els.loadMoreBtn.textContent = '加载中…';
  } else {
    setStatus('加载中…');
  }

  try {
    const response = await fetch(`/api/activity?${buildQuery()}`, { cache: 'no-store' });
    const payload = await response.json();
    if (!response.ok) throw new Error(payload.error || 'Request failed');

    if (append) {
      const existing = new Set(state.items.map(item => item.transactionHash));
      const merged = [...state.items];
      for (const item of payload.items || []) {
        if (!existing.has(item.transactionHash)) merged.push(item);
      }
      state.items = merged;
    } else {
      state.items = payload.items || [];
    }
    state.hasMore = Boolean(payload.hasMore);
    setStatus(`已加载 ${state.items.length} 条 · 最后更新 ${new Date().toLocaleTimeString('zh-CN', { hour12: false })}`);
    render();
  } catch (error) {
    setStatus(`加载失败：${error.message}`);
  } finally {
    state.loading = false;
    els.refreshBtn.disabled = false;
    els.loadMoreBtn.disabled = false;
    els.loadMoreBtn.textContent = '加载更多';
  }
}

function onFilterChange() {
  state.type = els.typeFilter.value;
  state.side = els.sideFilter.value;
  state.offset = 0;
  state.hasMore = false;
  void loadActivities({ append: false });
}

async function onLoadMore() {
  state.offset += PAGE_SIZE;
  await loadActivities({ append: true });
}

async function onRefresh() {
  state.offset = 0;
  state.hasMore = false;
  await loadActivities({ append: false });
}

els.typeFilter.addEventListener('change', onFilterChange);
els.sideFilter.addEventListener('change', onFilterChange);
els.refreshBtn.addEventListener('click', onRefresh);
els.loadMoreBtn.addEventListener('click', onLoadMore);

// 初次加载
void loadActivities({ append: false });

// 定时刷新首页（仅当用户未在翻页时，避免打断"加载更多"流程）
setInterval(() => {
  if (state.offset === 0 && !state.loading) {
    void loadActivities({ append: false });
  }
}, AUTOREFRESH_MS);
