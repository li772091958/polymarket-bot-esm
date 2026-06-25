const state = {
  events: [],
  selected: [],
  quote: null,
  positions: null,
};

const els = {
  status: document.querySelector('#comboStatus'),
  eventList: document.querySelector('#eventList'),
  selectedLegs: document.querySelector('#selectedLegs'),
  legCount: document.querySelector('#legCount'),
  amountInput: document.querySelector('#amountInput'),
  quotePrice: document.querySelector('#quotePrice'),
  quotePayout: document.querySelector('#quotePayout'),
  refreshQuoteBtn: document.querySelector('#refreshQuoteBtn'),
  submitOrderBtn: document.querySelector('#submitOrderBtn'),
  comboPositions: document.querySelector('#comboPositions'),
  refreshPositionsBtn: document.querySelector('#refreshPositionsBtn'),
  modal: document.querySelector('#comboModal'),
  confirmSummary: document.querySelector('#confirmSummary'),
  cancelComboBtn: document.querySelector('#cancelComboBtn'),
  confirmComboBtn: document.querySelector('#confirmComboBtn'),
};

const money = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 2 });
const number = new Intl.NumberFormat('en-US', { maximumFractionDigits: 4 });

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#039;' })[char]);
}

function setStatus(message) {
  els.status.textContent = message;
}

function formatDate(value) {
  return value ? new Date(value).toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }) : '--';
}

function selectedKey(leg) {
  return `${leg.conditionId}:${leg.outcomeIndex}`;
}

function isSelected(conditionId, outcomeIndex) {
  return state.selected.some(leg => leg.conditionId === conditionId && leg.outcomeIndex === outcomeIndex);
}

function clearQuote() {
  state.quote = null;
  els.quotePrice.textContent = '--';
  els.quotePayout.textContent = '--';
}

function quoteValue(name) {
  if (!state.quote || typeof state.quote !== 'object') return undefined;
  return state.quote[name] ?? state.quote.quote?.[name] ?? state.quote.data?.[name];
}

function renderQuote() {
  const price = quoteValue('price') ?? quoteValue('price_usdc') ?? quoteValue('priceDecimal') ?? quoteValue('price_e6');
  const payout = quoteValue('payout') ?? quoteValue('payout_usdc') ?? quoteValue('payoutDecimal');
  els.quotePrice.textContent = price === undefined ? '已返回' : String(price).endsWith('000') && Number(price) > 1000 ? number.format(Number(price) / 1_000_000) : number.format(Number(price));
  els.quotePayout.textContent = payout === undefined ? '--' : money.format(Number(payout));
}

function renderEvents() {
  if (state.events.length === 0) {
    els.eventList.innerHTML = '<div class="empty">当前窗口没有可串关的世界杯市场</div>';
    return;
  }

  els.eventList.replaceChildren(...state.events.map(event => {
    const card = document.createElement('article');
    card.className = 'event-card';
    card.innerHTML = `
      <div class="event-head">
        <div><strong>${escapeHtml(event.title)}</strong><span>${formatDate(event.startsAt)}</span></div>
        <em>${event.markets.length} 个市场</em>
      </div>
      <div class="market-stack"></div>
    `;
    const stack = card.querySelector('.market-stack');
    for (const market of event.markets) {
      const row = document.createElement('div');
      row.className = 'combo-market';
      row.innerHTML = `<div class="combo-question">${escapeHtml(market.title)}</div><div class="outcome-grid"></div>`;
      const grid = row.querySelector('.outcome-grid');
      (market.outcomes || []).forEach((outcome, index) => {
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = `outcome-btn ${isSelected(market.condition_id, index) ? 'selected' : ''}`;
        btn.innerHTML = `<span>${escapeHtml(outcome)}</span><b>${escapeHtml(market.outcome_prices?.[index] ?? '--')}</b>`;
        btn.addEventListener('click', () => toggleLeg(event, market, index));
        grid.append(btn);
      });
      stack.append(row);
    }
    return card;
  }));
}

function renderTicket() {
  els.legCount.textContent = `${state.selected.length}/5 腿`;
  if (state.selected.length === 0) {
    els.selectedLegs.className = 'selected-legs empty-ticket';
    els.selectedLegs.textContent = '请选择至少 2 个结果';
  } else {
    els.selectedLegs.className = 'selected-legs';
    els.selectedLegs.replaceChildren(...state.selected.map(leg => {
      const item = document.createElement('div');
      item.className = 'selected-leg';
      item.innerHTML = `
        <button type="button" aria-label="移除">×</button>
        <div><strong>${escapeHtml(leg.outcome)}</strong><span>${escapeHtml(leg.marketTitle)}</span></div>
      `;
      item.querySelector('button').addEventListener('click', () => removeLeg(leg));
      return item;
    }));
  }
  els.submitOrderBtn.disabled = state.selected.length < 2 || !state.quote;
}

function toggleLeg(event, market, outcomeIndex) {
  const existingIndex = state.selected.findIndex(leg => leg.conditionId === market.condition_id);
  if (existingIndex >= 0) {
    if (state.selected[existingIndex].outcomeIndex === outcomeIndex) {
      state.selected.splice(existingIndex, 1);
    } else {
      state.selected[existingIndex] = buildLeg(event, market, outcomeIndex);
    }
  } else {
    if (state.selected.length >= 5) return setStatus('最多选择 5 腿');
    state.selected.push(buildLeg(event, market, outcomeIndex));
  }
  clearQuote();
  renderEvents();
  renderTicket();
}

function buildLeg(event, market, outcomeIndex) {
  return {
    eventId: event.id,
    eventTitle: event.title,
    marketId: market.id,
    marketTitle: market.title,
    conditionId: market.condition_id,
    positionId: market.position_ids[outcomeIndex],
    outcomeIndex,
    outcome: market.outcomes[outcomeIndex],
  };
}

function removeLeg(leg) {
  const key = selectedKey(leg);
  state.selected = state.selected.filter(item => selectedKey(item) !== key);
  clearQuote();
  renderEvents();
  renderTicket();
}

async function fetchJson(url, options) {
  const response = await fetch(url, { cache: 'no-store', ...options });
  const payload = await response.json();
  if (!response.ok) throw new Error(payload.error || '请求失败');
  return payload;
}

async function postJson(url, body) {
  return fetchJson(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

async function loadMarkets() {
  setStatus('正在加载可串关市场');
  const payload = await fetchJson('/api/combo/markets');
  state.events = payload.events || [];
  renderEvents();
  setStatus(`已加载 ${state.events.length} 场比赛`);
}

async function refreshQuote() {
  const amount = Number(els.amountInput.value);
  if (state.selected.length < 2) throw new Error('至少选择 2 腿');
  const payload = await postJson('/api/combo/quote', { legs: state.selected, amount });
  state.quote = payload.quote;
  renderQuote();
  renderTicket();
  setStatus('官方报价已更新');
}

async function loadPositions() {
  els.comboPositions.innerHTML = '<div class="empty">正在加载串关持仓</div>';
  const payload = await fetchJson('/api/combo/positions');
  const combos = payload.combos || [];
  if (combos.length === 0) {
    els.comboPositions.innerHTML = '<div class="empty">暂无串关持仓</div>';
    return;
  }
  els.comboPositions.replaceChildren(...combos.map(combo => {
    const item = document.createElement('article');
    item.className = 'combo-position';
    const legs = combo.legs || [];
    item.innerHTML = `
      <div><strong>${escapeHtml(combo.combo_condition_id || combo.title || 'Combo')}</strong><span>${legs.length || combo.legs_total || 0} 腿</span></div>
      <div>${money.format(Number(combo.entry_cost_usdc || combo.total_cost_usdc || combo.currentValue || 0))}</div>
    `;
    return item;
  }));
}

function openConfirm() {
  els.confirmSummary.innerHTML = `
    <div>下注金额：<b>${money.format(Number(els.amountInput.value || 0))}</b></div>
    <div>腿数：<b>${state.selected.length}</b></div>
    <ol>${state.selected.map(leg => `<li>${escapeHtml(leg.marketTitle)} / ${escapeHtml(leg.outcome)}</li>`).join('')}</ol>
  `;
  els.modal.classList.remove('hidden');
}

function closeConfirm() {
  els.modal.classList.add('hidden');
}

els.refreshQuoteBtn.addEventListener('click', () => refreshQuote().catch(error => setStatus(`报价失败：${error.message}`)));
els.amountInput.addEventListener('input', () => { clearQuote(); renderTicket(); });
els.submitOrderBtn.addEventListener('click', openConfirm);
els.cancelComboBtn.addEventListener('click', closeConfirm);
els.refreshPositionsBtn.addEventListener('click', () => loadPositions().catch(error => setStatus(`持仓加载失败：${error.message}`)));
els.confirmComboBtn.addEventListener('click', async () => {
  els.confirmComboBtn.disabled = true;
  try {
    const payload = await postJson('/api/combo/order', { legs: state.selected, amount: Number(els.amountInput.value), quote: state.quote });
    closeConfirm();
    state.selected = [];
    clearQuote();
    renderEvents();
    renderTicket();
    setStatus(`串关订单已提交：${payload.result?.id || payload.result?.order_id || '成功'}`);
    await loadPositions();
  } catch (error) {
    setStatus(`下单失败：${error.message}`);
  } finally {
    els.confirmComboBtn.disabled = false;
  }
});

renderTicket();
await Promise.allSettled([loadMarkets(), loadPositions()]).then(results => {
  const rejected = results.find(result => result.status === 'rejected');
  if (rejected) setStatus(`加载失败：${rejected.reason.message}`);
});
