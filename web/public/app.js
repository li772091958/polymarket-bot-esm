const state = {
  positions: [],
  pendingSell: null,
};

const els = {
  status: document.querySelector('#status'),
  cashoutBtn: document.querySelector('#cashoutBtn'),
  availableBalance: document.querySelector('#availableBalance'),
  positionValue: document.querySelector('#positionValue'),
  totalAssetValue: document.querySelector('#totalAssetValue'),
  positionList: document.querySelector('#positionList'),
  modal: document.querySelector('#modal'),
  modalText: document.querySelector('#modalText'),
  cancelSellBtn: document.querySelector('#cancelSellBtn'),
  confirmSellBtn: document.querySelector('#confirmSellBtn'),
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
  return Number(value || 0).toFixed(4);
}

function formatPercent(value) {
  return `${(Number(value || 0) * 100).toFixed(2)}%`;
}

function setStatus(message) {
  els.status.textContent = message;
}

function renderSnapshot(snapshot) {
  els.availableBalance.textContent = formatMoney(snapshot.availableBalance);
  els.positionValue.textContent = formatMoney(snapshot.positionValue);
  els.totalAssetValue.textContent = formatMoney(snapshot.totalAssetValue);
  state.positions = snapshot.positions || [];
  renderPositions();

  const updatedAt = snapshot.updatedAt ? new Date(snapshot.updatedAt).toLocaleTimeString() : '--';
  setStatus(`更新时间 ${updatedAt} · WS 实时价格已连接`);
}

function renderPositions() {
  if (state.positions.length === 0) {
    els.positionList.innerHTML = '<div class="empty">暂无仓位</div>';
    return;
  }

  els.positionList.replaceChildren(
    ...state.positions.map(position => {
      const row = document.createElement('article');
      row.className = 'row';

      const main = document.createElement('div');
      main.className = 'market-cell';
      main.innerHTML = `
        <div class="title">${escapeHtml(position.title)}</div>
        <div class="meta">
          <span>${escapeHtml(position.outcome)}</span>
          <span>${formatNumber(position.size)} @ ${formatPrice(position.avgPrice)}</span>
        </div>
      `;

      const price = document.createElement('div');
      price.className = 'price';
      price.innerHTML = `
        <div><span>均价</span><b>${formatPrice(position.avgPrice)}</b></div>
        <div class="${position.priceSource === 'ws' ? 'live' : ''}"><span>现价</span><b>${formatPrice(position.livePrice)}</b></div>
      `;

      const pnlClass = Number(position.livePnl) >= 0 ? 'gain' : 'loss';
      const metrics = document.createElement('div');
      metrics.className = 'metrics';
      metrics.title = '双击市价清仓';
      metrics.innerHTML = `
        <div class="current-value">${formatMoney(position.liveCurrentValue)}</div>
        <div class="${pnlClass}">${formatMoney(position.livePnl)} ${formatPercent(position.livePnlRate)}</div>
      `;
      metrics.addEventListener('dblclick', () => openSellModal(position));

      row.append(main, price, metrics);
      return row;
    })
  );
}

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, char => {
    const map = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#039;' };
    return map[char];
  });
}

function openSellModal(position) {
  state.pendingSell = position;
  els.modalText.textContent = `${position.title} / ${position.outcome} / size ${formatNumber(position.size)}。确认后将按市价清仓，成交价格可能出现滑点。`;
  els.modal.classList.remove('hidden');
}

function closeSellModal() {
  state.pendingSell = null;
  els.modal.classList.add('hidden');
}

async function postJson(url, body = {}) {
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  const payload = await response.json();
  if (!response.ok) throw new Error(payload.error || 'Request failed');
  return payload;
}

async function loadPositions() {
  const response = await fetch('/api/positions', { cache: 'no-store' });
  const snapshot = await response.json();
  renderSnapshot(snapshot);
}

els.cashoutBtn.addEventListener('click', async () => {
  els.cashoutBtn.disabled = true;
  setStatus('收米处理中');
  try {
    const payload = await postJson('/api/cashout');
    renderSnapshot(payload.snapshot);
    setStatus('收米完成');
  } catch (error) {
    setStatus(`收米失败：${error.message}`);
  } finally {
    els.cashoutBtn.disabled = false;
  }
});

els.cancelSellBtn.addEventListener('click', closeSellModal);
els.modal.addEventListener('click', event => {
  if (event.target === els.modal) closeSellModal();
});

els.confirmSellBtn.addEventListener('click', async () => {
  if (!state.pendingSell) return;
  const asset = state.pendingSell.asset;
  els.confirmSellBtn.disabled = true;
  setStatus('清仓处理中');

  try {
    const payload = await postJson(`/api/positions/${encodeURIComponent(asset)}/sell`);
    renderSnapshot(payload.snapshot);
    closeSellModal();
    setStatus('清仓订单已提交');
  } catch (error) {
    setStatus(`清仓失败：${error.message}`);
  } finally {
    els.confirmSellBtn.disabled = false;
  }
});

const events = new EventSource('/events');
events.addEventListener('open', () => setStatus('WS 实时价格已连接'));
events.addEventListener('snapshot', event => renderSnapshot(JSON.parse(event.data)));
events.addEventListener('status', event => {
  const payload = JSON.parse(event.data);
  setStatus(payload.message);
});
events.addEventListener('error', () => setStatus('实时连接断开，正在重连'));

void loadPositions().catch(error => setStatus(`加载失败：${error.message}`));
