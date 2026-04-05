// ---- Tab navigation ----
document.querySelectorAll('.tab-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
    document.querySelectorAll('.tab-content').forEach(c => c.classList.remove('active'));
    btn.classList.add('active');
    document.getElementById('tab-' + btn.dataset.tab).classList.add('active');
  });
});

// ---- Chart instances ----
let chartN225 = null, chartTOPIX = null, chartSectors = null, chartDetail = null;
let currentDetailData = null; // 詳細チャート再描画用にデータを保持

function destroyChart(ref) { if (ref) { ref.destroy(); } return null; }

// ---- Color helpers ----
function pctColor(v) { return v > 0 ? 'pos' : v < 0 ? 'neg' : 'neutral'; }
function pctStr(v) { return (v > 0 ? '+' : '') + v.toFixed(2) + '%'; }
function num(v, d = 2) { return v != null ? Number(v).toLocaleString('ja-JP', { maximumFractionDigits: d }) : '—'; }
function scoreColor(s) { return s >= 80 ? '#3fb950' : s >= 60 ? '#ffa657' : '#8b949e'; }
function scoreBadgeClass(s) { return s >= 80 ? 'score-high' : s >= 60 ? 'score-mid' : 'score-low'; }

function makeLineChart(ctx, labels, data, label, color) {
  return new Chart(ctx, {
    type: 'line',
    data: {
      labels,
      datasets: [{
        label, data,
        borderColor: color, backgroundColor: color + '22',
        borderWidth: 2, pointRadius: 0, fill: true, tension: 0.3,
      }]
    },
    options: {
      responsive: true,
      interaction: { mode: 'index', intersect: false },
      plugins: { legend: { display: false }, tooltip: { callbacks: {
        label: ctx => '  ' + Number(ctx.raw).toLocaleString('ja-JP') + ' 円'
      }}},
      scales: {
        x: { ticks: { color: '#8b949e', maxTicksLimit: 6,
          callback(val) { return this.getLabelForValue(val).slice(5); } },
          grid: { color: '#21262d' } },
        y: { ticks: { color: '#8b949e', callback: v => v.toLocaleString('ja-JP') },
          grid: { color: '#21262d' } }
      }
    }
  });
}

// ---- Market tab ----
async function loadMarket() {
  document.getElementById('marketCards').innerHTML = '<div class="loading">取得中...</div>';
  const res = await fetch('/api/market');
  const { indices } = await res.json();

  const cards = document.getElementById('marketCards');
  cards.innerHTML = '';
  indices.forEach(idx => {
    const flowClass = idx.money_flow === '流入' ? 'flow-in' : idx.money_flow === '流出' ? 'flow-out' : 'flow-neutral';
    cards.innerHTML += `
      <div class="index-card">
        <div class="index-card-name">${idx.name}</div>
        <div class="index-card-price">${Number(idx.price).toLocaleString('ja-JP')} <small>円</small></div>
        <div class="index-card-change ${pctColor(idx.change_pct)}">${pctStr(idx.change_pct)}</div>
        <div class="index-card-meta">
          <span>MA25: ${num(idx.ma25, 0)}</span>
          <span>MA75: ${num(idx.ma75, 0)}</span>
        </div>
        <span class="flow-badge ${flowClass}">資金${idx.money_flow}</span>
      </div>`;
  });

  const n225 = indices.find(i => i.symbol === '^N225');
  const topix = indices.find(i => i.symbol === '1306.T');

  if (n225 && n225.price_history.length) {
    chartN225 = destroyChart(chartN225);
    chartN225 = makeLineChart(document.getElementById('chartN225'),
      n225.price_history.map(p => p.date), n225.price_history.map(p => p.close), '日経225', '#58a6ff');
  }
  if (topix && topix.price_history.length) {
    chartTOPIX = destroyChart(chartTOPIX);
    chartTOPIX = makeLineChart(document.getElementById('chartTOPIX'),
      topix.price_history.map(p => p.date), topix.price_history.map(p => p.close), 'TOPIX ETF', '#3fb950');
  }

  const mf = document.getElementById('moneyFlowInfo');
  const inflows = indices.filter(i => i.money_flow === '流入');
  const outflows = indices.filter(i => i.money_flow === '流出');
  const overall = inflows.length > outflows.length ? '流入優勢' : inflows.length < outflows.length ? '流出優勢' : '均衡';
  const oc = overall === '流入優勢' ? '#3fb950' : overall === '流出優勢' ? '#f85149' : '#8b949e';
  mf.innerHTML = `
    <div class="mf-item"><div class="mf-item-label">市場全体</div><div class="mf-item-value" style="color:${oc}">${overall}</div></div>
    ${indices.map(i => `
      <div class="mf-item">
        <div class="mf-item-label">${i.name}</div>
        <div class="mf-item-value ${i.money_flow === '流入' ? 'pos' : i.money_flow === '流出' ? 'neg' : 'neutral'}">${i.money_flow}</div>
        <div style="font-size:11px;color:#8b949e;margin-top:4px">前日比: <span class="${pctColor(i.change_pct)}">${pctStr(i.change_pct)}</span></div>
      </div>`).join('')}`;

  document.getElementById('lastUpdated').textContent = '最終更新: ' + new Date().toLocaleTimeString('ja-JP');
}

// ---- Sectors tab ----
function _renderSectorsChart(sectors) {
  const chartWrap = document.getElementById('sectorChart');
  const tableWrap = document.getElementById('sectorTable');
  chartWrap.style.display = 'block';
  chartSectors = destroyChart(chartSectors);
  chartSectors = new Chart(document.getElementById('chartSectors'), {
    type: 'bar',
    data: {
      labels: sectors.map(s => s.name),
      datasets: [{ label: '前日比(%)', data: sectors.map(s => s.change_pct),
        backgroundColor: sectors.map(s => s.change_pct >= 0 ? '#3fb950' : '#f85149'), borderRadius: 4 }]
    },
    options: {
      responsive: true,
      plugins: { legend: { display: false } },
      scales: {
        x: { ticks: { color: '#8b949e', font: { size: 11 } }, grid: { color: '#21262d' } },
        y: { ticks: { color: '#8b949e', callback: v => v + '%' }, grid: { color: '#21262d' } }
      }
    }
  });
  tableWrap.style.display = 'block';
  tableWrap.innerHTML = `
    <table><thead><tr><th>セクター</th><th>前日比</th><th>出来高流入比率</th><th>資金動向</th></tr></thead>
    <tbody>${sectors.map(s => {
      const fc = s.inflow_ratio >= 1.1 ? 'pos' : s.inflow_ratio <= 0.9 ? 'neg' : 'neutral';
      const fl = s.inflow_ratio >= 1.1 ? '流入' : s.inflow_ratio <= 0.9 ? '流出' : '中立';
      return `<tr>
        <td>${s.name}</td>
        <td class="${pctColor(s.change_pct)}">${pctStr(s.change_pct)}</td>
        <td><div class="inflow-bar"><div class="inflow-fill" style="width:${Math.min(s.inflow_ratio*50,100)}px"></div><span>${s.inflow_ratio.toFixed(2)}倍</span></div></td>
        <td class="${fc}">${fl}</td></tr>`;
    }).join('')}</tbody></table>`;
}

async function loadSectors() {
  const loading = document.getElementById('sectorLoading');
  const tableWrap = document.getElementById('sectorTable');
  const chartWrap = document.getElementById('sectorChart');
  const banner = document.getElementById('sectorPartialBanner');
  loading.style.display = 'block';
  tableWrap.style.display = 'none';
  chartWrap.style.display = 'none';
  banner.style.display = 'none';

  const res = await fetch('/api/sectors');
  const { sectors } = await res.json();
  loading.style.display = 'none';
  if (!sectors.length) return;
  _renderSectorsChart(sectors);
}

async function loadSectorsPartial() {
  const loading = document.getElementById('sectorLoading');
  const tableWrap = document.getElementById('sectorTable');
  const chartWrap = document.getElementById('sectorChart');
  const banner = document.getElementById('sectorPartialBanner');
  loading.style.display = 'none';
  tableWrap.style.display = 'none';
  chartWrap.style.display = 'none';
  banner.style.display = 'none';

  let result;
  try {
    const res = await fetch('/api/sectors/partial');
    if (!res.ok) throw new Error(`サーバーエラー: ${res.status}`);
    result = await res.json();
  } catch (e) {
    tableWrap.style.display = 'block';
    tableWrap.innerHTML = `<div style="color:#f85149;padding:20px">取得に失敗しました: ${e.message}</div>`;
    return;
  }

  const { sectors, cached_count, total } = result;
  banner.style.display = 'block';
  if (cached_count === 0) {
    banner.innerHTML = `⚡ 途中表示 — キャッシュなし。先に「更新」を押してデータを取得してください。`;
    return;
  }
  const pct = Math.round(cached_count / total * 100);
  banner.innerHTML = `⚡ 途中表示 — 全${total}セクター中 <strong>${cached_count}セクター（${pct}%）</strong> のキャッシュ済みデータをもとに表示しています`;
  _renderSectorsChart(sectors);
}

// ---- Stocks tab ----
let currentPage = 0;
let searchTimer = null;

function debounceSearch() {
  clearTimeout(searchTimer);
  searchTimer = setTimeout(() => loadStocks(0), 400);
}

function _renderStocksTable(stocks) {
  if (!stocks.length) return '<div class="loading" style="color:#8b949e">該当銘柄なし</div>';
  return `<table>
    <thead><tr>
      <th>順位</th><th>コード</th><th>銘柄名</th><th>株価</th><th>前日比</th>
      <th>PER</th><th>PBR</th><th>配当利回り</th>
      <th>出来高比率</th><th>RSI</th><th>1M騰落率</th>
      <th>総合スコア</th><th>評価根拠</th>
    </tr></thead>
    <tbody>${stocks.map(s => {
      const bc = scoreColor(s.score);
      return `<tr class="clickable" onclick="showDetail('${s.symbol}')">
        <td style="color:#8b949e;text-align:center">${s.rank != null ? s.rank : '—'}</td>
        <td style="color:#58a6ff">${s.symbol.replace('.T','')}</td>
        <td>${s.name}</td>
        <td>${Number(s.price).toLocaleString('ja-JP')} 円</td>
        <td class="${pctColor(s.change_pct)}">${pctStr(s.change_pct)}</td>
        <td>${s.per != null ? s.per + '倍' : '—'}</td>
        <td>${s.pbr != null ? s.pbr + '倍' : '—'}</td>
        <td>${s.div_yield != null ? s.div_yield + '%' : '—'}</td>
        <td class="${s.vol_ratio >= 1.5 ? 'pos' : s.vol_ratio <= 0.7 ? 'neg' : 'neutral'}">${s.vol_ratio}倍</td>
        <td class="${s.rsi < 30 ? 'neg' : s.rsi > 70 ? 'pos' : 'neutral'}">${s.rsi}</td>
        <td class="${pctColor(s.momentum_1m)}">${pctStr(s.momentum_1m)}</td>
        <td>
          <div class="score-bar-wrap">
            <div class="score-bar"><div class="score-bar-fill" style="width:${s.score}%;background:${bc}"></div></div>
            <span class="score-num ${scoreBadgeClass(s.score)}">${s.score}</span>
          </div>
        </td>
        <td style="max-width:200px;white-space:normal;font-size:11px;color:#8b949e">${(s.reasons||[]).slice(0,2).join(' / ')}</td>
      </tr>`;
    }).join('')}</tbody>
  </table>
  <p class="note" style="margin-top:8px">※ 行をクリックすると詳細を表示します</p>`;
}

async function loadStocks(page = 0) {
  currentPage = page;
  const loading = document.getElementById('stocksLoading');
  const tableWrap = document.getElementById('stocksTable');
  const pagination = document.getElementById('pagination');
  const sortBy = document.getElementById('sortSelect').value;
  const search = document.getElementById('stockSearch').value.trim();

  loading.style.display = 'block';
  tableWrap.style.display = 'none';
  pagination.style.display = 'none';
  document.getElementById('stocksPartialBanner').style.display = 'none';

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 120000);
  let result;
  try {
    const url = `/api/stocks?sort_by=${sortBy}&page=${page}&page_size=50` + (search ? `&search=${encodeURIComponent(search)}` : '');
    const res = await fetch(url, { signal: controller.signal });
    clearTimeout(timer);
    if (!res.ok) throw new Error(`サーバーエラー: ${res.status}`);
    result = await res.json();
  } catch (e) {
    clearTimeout(timer);
    loading.style.display = 'none';
    tableWrap.style.display = 'block';
    tableWrap.innerHTML = `<div style="color:#f85149;padding:20px">
      取得に失敗しました: ${e.name === 'AbortError' ? 'タイムアウト（120秒）' : e.message}<br>
      <small>「更新」ボタンを押してください</small></div>`;
    return;
  }

  loading.style.display = 'none';
  tableWrap.style.display = 'block';

  const { stocks, total, total_pages, cached, page_size: ps,
          skipped_ratelimit = [], skipped_notfound = [] } = result;
  document.getElementById('stocksCountBadge').textContent = `${total}銘柄`;
  const cacheEl = document.getElementById('cacheStatus');
  cacheEl.textContent = cached === ps ? '⚡ キャッシュ済み' : `取得中 (${cached}/${ps} キャッシュ)`;
  cacheEl.style.color = cached === ps ? '#3fb950' : '#ffa657';

  // スキップ銘柄の表示
  const skipEl = document.getElementById('skippedInfo');
  if (skipped_ratelimit.length || skipped_notfound.length) {
    let html = '';
    if (skipped_ratelimit.length) {
      html += `<div class="skip-row skip-rl">
        <span class="skip-label">⚠ レートリミットでスキップ（30秒後に再試行）:</span>
        <span>${skipped_ratelimit.join('、')}</span>
      </div>`;
    }
    if (skipped_notfound.length) {
      html += `<div class="skip-row skip-nf">
        <span class="skip-label">✕ データなし（上場廃止等）:</span>
        <span>${skipped_notfound.join('、')}</span>
      </div>`;
    }
    skipEl.innerHTML = html;
    skipEl.style.display = 'block';
  } else {
    skipEl.style.display = 'none';
  }

  tableWrap.innerHTML = _renderStocksTable(stocks);
  if (!stocks.length) return;

  // ページネーション
  if (total_pages > 1) {
    pagination.style.display = 'flex';
    let html = `<button class="page-btn" onclick="loadStocks(${page-1})" ${page===0?'disabled':''}>◀ 前へ</button>`;
    html += `<span class="page-info">${page+1} / ${total_pages} ページ（全${total}銘柄）</span>`;
    const start = Math.max(0, page - 2);
    const end = Math.min(total_pages - 1, page + 2);
    for (let i = start; i <= end; i++) {
      html += `<button class="page-btn ${i===page?'active':''}" onclick="loadStocks(${i})">${i+1}</button>`;
    }
    html += `<button class="page-btn" onclick="loadStocks(${page+1})" ${page===total_pages-1?'disabled':''}>次へ ▶</button>`;
    pagination.innerHTML = html;
  }
}

async function loadStocksPartial(page = 0) {
  currentPage = page;
  const loading = document.getElementById('stocksLoading');
  const tableWrap = document.getElementById('stocksTable');
  const pagination = document.getElementById('pagination');
  const banner = document.getElementById('stocksPartialBanner');
  const sortBy = document.getElementById('sortSelect').value;
  const search = document.getElementById('stockSearch').value.trim();

  loading.style.display = 'none';
  tableWrap.style.display = 'none';
  pagination.style.display = 'none';
  banner.style.display = 'none';
  document.getElementById('skippedInfo').style.display = 'none';

  let result;
  try {
    const url = `/api/stocks/partial?sort_by=${sortBy}&page=${page}&page_size=50` + (search ? `&search=${encodeURIComponent(search)}` : '');
    const res = await fetch(url);
    if (!res.ok) throw new Error(`サーバーエラー: ${res.status}`);
    result = await res.json();
  } catch (e) {
    tableWrap.style.display = 'block';
    tableWrap.innerHTML = `<div style="color:#f85149;padding:20px">取得に失敗しました: ${e.message}</div>`;
    return;
  }

  const { stocks, total, total_all, cached_count, page_size: ps, total_pages } = result;

  // 進捗バナー表示
  banner.style.display = 'block';
  if (cached_count === 0) {
    banner.innerHTML = `⚡ 途中表示 — キャッシュなし。先に「更新」を押してデータを取得してください。`;
    tableWrap.style.display = 'none';
    return;
  }
  const pct = Math.round(cached_count / total_all * 100);
  banner.innerHTML = `⚡ 途中表示 — 全${total_all}銘柄中 <strong>${cached_count}銘柄（${pct}%）</strong> のキャッシュ済みデータをもとに表示しています`;

  document.getElementById('stocksCountBadge').textContent = `${total}銘柄（キャッシュ済み）`;

  tableWrap.style.display = 'block';
  tableWrap.innerHTML = _renderStocksTable(stocks);
  if (!stocks.length) return;

  // ページネーション
  if (total_pages > 1) {
    pagination.style.display = 'flex';
    let html = `<button class="page-btn" onclick="loadStocksPartial(${page-1})" ${page===0?'disabled':''}>◀ 前へ</button>`;
    html += `<span class="page-info">${page+1} / ${total_pages} ページ（キャッシュ済み${total}銘柄）</span>`;
    const start = Math.max(0, page - 2);
    const end = Math.min(total_pages - 1, page + 2);
    for (let i = start; i <= end; i++) {
      html += `<button class="page-btn ${i===page?'active':''}" onclick="loadStocksPartial(${i})">${i+1}</button>`;
    }
    html += `<button class="page-btn" onclick="loadStocksPartial(${page+1})" ${page===total_pages-1?'disabled':''}>次へ ▶</button>`;
    pagination.innerHTML = html;
  }
}

function showDetail(symbol) {
  document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
  document.querySelectorAll('.tab-content').forEach(c => c.classList.remove('active'));
  document.querySelector('[data-tab="detail"]').classList.add('active');
  document.getElementById('tab-detail').classList.add('active');
  document.getElementById('symbolInput').value = symbol.replace('.T', '');
  loadDetail();
}

// ---- Detail tab ----
async function loadDetail() {
  const sym = document.getElementById('symbolInput').value.trim();
  if (!sym) return;
  const loading = document.getElementById('detailLoading');
  const content = document.getElementById('detailContent');
  loading.style.display = 'block';
  content.style.display = 'none';

  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 30000);
    const res = await fetch(`/api/stock/${sym}`, { signal: controller.signal });
    clearTimeout(timer);
    if (!res.ok) throw new Error('Not found');
    const s = await res.json();
    currentDetailData = s;

    document.getElementById('detailName').textContent = s.name;
    document.getElementById('detailSymbol').textContent = s.symbol;
    document.getElementById('detailPrice').textContent = Number(s.price).toLocaleString('ja-JP') + ' 円';
    const chEl = document.getElementById('detailChange');
    chEl.textContent = pctStr(s.change_pct);
    chEl.className = 'detail-change ' + pctColor(s.change_pct);
    const scoreEl = document.getElementById('detailScore');
    scoreEl.textContent = s.score + ' pt';
    scoreEl.style.color = scoreColor(s.score);

    document.getElementById('dPer').textContent = s.per != null ? s.per + '倍' : '—';
    document.getElementById('dPbr').textContent = s.pbr != null ? s.pbr + '倍' : '—';
    document.getElementById('dDiv').textContent = s.div_yield != null ? s.div_yield + '%' : '—';
    const rsiEl = document.getElementById('dRsi');
    rsiEl.textContent = s.rsi;
    rsiEl.className = 'metric-value ' + (s.rsi < 30 ? 'neg' : s.rsi > 70 ? 'pos' : 'neutral');
    document.getElementById('dVol').textContent = s.vol_ratio + '倍';
    const momEl = document.getElementById('dMom');
    momEl.textContent = pctStr(s.momentum_1m);
    momEl.className = 'metric-value ' + pctColor(s.momentum_1m);
    document.getElementById('dHigh').textContent = s.high_52w != null ? Number(s.high_52w).toLocaleString('ja-JP') + '円' : '—';
    document.getElementById('dLow').textContent = s.low_52w != null ? Number(s.low_52w).toLocaleString('ja-JP') + '円' : '—';
    document.getElementById('detailReasons').innerHTML = (s.reasons || []).map(r => `<li>${r}</li>`).join('');

    drawDetailChart(s);
    loading.style.display = 'none';
    content.style.display = 'block';
  } catch (e) {
    loading.style.display = 'none';
    alert('銘柄が見つかりませんでした: ' + sym + (e.name === 'AbortError' ? '（タイムアウト）' : ''));
  }
}

// 銘柄詳細：検索サジェスト
let suggestTimer = null;
const symbolInput = document.getElementById('symbolInput');
const suggestBox  = document.getElementById('suggestBox');

symbolInput.addEventListener('keydown', e => { if (e.key === 'Enter') { hideSuggest(); loadDetail(); } });
symbolInput.addEventListener('input', () => {
  clearTimeout(suggestTimer);
  const q = symbolInput.value.trim();
  if (!q) { hideSuggest(); return; }
  suggestTimer = setTimeout(() => fetchSuggest(q), 200);
});
symbolInput.addEventListener('blur', () => { setTimeout(hideSuggest, 150); });

async function fetchSuggest(q) {
  try {
    const res = await fetch(`/api/search?q=${encodeURIComponent(q)}`);
    const { results } = await res.json();
    if (!results.length) { hideSuggest(); return; }
    suggestBox.innerHTML = results.map(r =>
      `<div class="suggest-item" onmousedown="pickSuggest('${r.code}','${r.name}')">
        <span class="suggest-code">${r.code}</span>
        <span class="suggest-name">${r.name}</span>
      </div>`
    ).join('');
    suggestBox.style.display = 'block';
  } catch { hideSuggest(); }
}

function pickSuggest(code, name) {
  symbolInput.value = code;
  hideSuggest();
  loadDetail();
}
function hideSuggest() { suggestBox.style.display = 'none'; }

function redrawDetailChart() {
  if (currentDetailData) drawDetailChart(currentDetailData);
}

function drawDetailChart(s) {
  if (!s.price_history || !s.price_history.length) return;
  chartDetail = destroyChart(chartDetail);

  const showTV = document.getElementById('toggleTradingValue').checked;
  const showPer = document.getElementById('togglePer').checked;

  const labels = s.price_history.map(p => p.date);
  const prices = s.price_history.map(p => p.close);
  const tvData = s.price_history.map(p => p.trading_value ?? 0);
  const perData = s.price_history.map(p => p.est_per ?? null);
  const hasPerData = perData.some(v => v !== null);

  const datasets = [
    {
      label: '株価（円）',
      data: prices,
      borderColor: '#58a6ff',
      backgroundColor: '#58a6ff22',
      borderWidth: 2,
      pointRadius: 0,
      fill: true,
      tension: 0.3,
      yAxisID: 'yPrice',
      order: 1,
    }
  ];

  if (showTV) {
    datasets.push({
      label: '売買代金（億円）',
      data: tvData,
      type: 'bar',
      backgroundColor: 'rgba(255, 166, 87, 0.35)',
      borderColor: 'rgba(255, 166, 87, 0.6)',
      borderWidth: 1,
      yAxisID: 'yRight',
      order: 2,
    });
  }

  if (showPer && hasPerData) {
    datasets.push({
      label: '推定PER（倍）',
      data: perData,
      borderColor: '#bc8cff',
      backgroundColor: 'transparent',
      borderWidth: 1.5,
      borderDash: [4, 3],
      pointRadius: 0,
      tension: 0.3,
      yAxisID: 'yRight',
      order: 0,
    });
  }

  const scales = {
    x: {
      ticks: { color: '#8b949e', maxTicksLimit: 6,
        callback(val) { return this.getLabelForValue(val).slice(5); } },
      grid: { color: '#21262d' }
    },
    yPrice: {
      position: 'left',
      ticks: { color: '#8b949e', callback: v => v.toLocaleString('ja-JP') },
      grid: { color: '#21262d' },
      title: { display: true, text: '株価（円）', color: '#8b949e', font: { size: 11 } }
    },
  };

  if (showTV || (showPer && hasPerData)) {
    scales.yRight = {
      position: 'right',
      ticks: { color: '#8b949e' },
      grid: { drawOnChartArea: false },
      title: {
        display: true,
        text: showTV && showPer && hasPerData ? '売買代金（億円）/ PER（倍）' : showTV ? '売買代金（億円）' : 'PER（倍）',
        color: '#8b949e',
        font: { size: 11 }
      }
    };
  }

  chartDetail = new Chart(document.getElementById('chartDetail'), {
    type: 'line',
    data: { labels, datasets },
    options: {
      responsive: true,
      interaction: { mode: 'index', intersect: false },
      plugins: {
        legend: {
          display: true,
          labels: { color: '#8b949e', font: { size: 11 }, boxWidth: 14 }
        },
        tooltip: { callbacks: {
          label: ctx => {
            const v = ctx.raw;
            if (v == null) return null;
            if (ctx.dataset.label.includes('株価')) return `  株価: ${Number(v).toLocaleString('ja-JP')} 円`;
            if (ctx.dataset.label.includes('売買代金')) return `  売買代金: ${v.toFixed(1)} 億円`;
            if (ctx.dataset.label.includes('PER')) return `  推定PER: ${v} 倍`;
            return String(v);
          }
        }}
      },
      scales,
    }
  });
}

async function clearCacheAndReload() {
  await fetch('/api/cache/clear');
  loadStocks(currentPage);
}

// ---- Initial load ----
loadMarket();
