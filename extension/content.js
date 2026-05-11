// content.js - editorial sidebar version
const BACKEND = 'http://localhost:5000';

(function injectHook() {
  const s = document.createElement('script');
  s.src = chrome.runtime.getURL('page_hook.js');
  s.onload = () => s.remove();
  (document.head || document.documentElement).appendChild(s);
})();

const captured = {
  pdp: null,
  search: null,
  ratings: null,
  ratingsAll: new Map(),
  recommendCount: 0,
  // 当前用户在 Shopee 评论区点的是哪一星（0=全部, 1-5=对应星级, -1=有内容评论, -2=有媒体）
  currentStarFilter: 0
};
let aiResult = null;
let aiLoading = false;

window.addEventListener('message', (ev) => {
  if (ev.source !== window) return;
  const data = ev.data;
  if (!data || data.type !== 'SHOPEE_ASSISTANT_API_RESPONSE') return;

  const { url, body } = data;
  console.log('[Shopee助手] 截获 API:', url);

  const isRatings = /\/item\/get_ratings/.test(url);
  const isPDP = !isRatings && (/\/pdp\/get/.test(url) || /\/item\/get/.test(url));
  const isSearch = /\/search\/search_items/.test(url);
  const isRecommend = /\/recommend/.test(url);

  if (isPDP) {
    const newItem = (body && body.data && body.data.item) || (body && body.item) || null;
    if (newItem && (newItem.item_id || newItem.itemid)) {
      const newId = newItem.item_id || newItem.itemid;
      const oldItem = captured.pdp ? ((captured.pdp.data && captured.pdp.data.item) || captured.pdp.item) : null;
      const oldId = oldItem ? (oldItem.item_id || oldItem.itemid) : null;
      if (newId !== oldId) {
        // 商品变了，清掉上一个商品的评论 + AI 结果
        captured.ratingsAll.clear();
        captured.ratings = null;
        aiResult = null;
        console.log('[Shopee助手] 切换商品，清空旧数据');
      }
      captured.pdp = body;
      renderPanel();
    }
    upload({ kind: 'pdp', url, body });
  } else if (isSearch) {
    if (body && Array.isArray(body.items) && body.items.length > 0) {
      captured.search = body;
      renderPanel();
    }
    upload({ kind: 'search', url, body });
  } else if (isRatings) {
    captured.ratings = body;
    const newRatings = (body && body.data && body.data.ratings) || [];

    // 从响应推断当前 filter：本批次内若所有评论同一星级，说明用户点了那个星级 tab
    if (newRatings.length > 0) {
      const starsInBatch = new Set(
        newRatings.map(r => r.rating_star || r.rating).filter(s => s != null)
      );
      if (starsInBatch.size === 1) {
        captured.currentStarFilter = [...starsInBatch][0];
      } else {
        // 混合 = 用户在"全部"标签
        captured.currentStarFilter = 0;
      }
      console.log('[Shopee助手] 当前 filter:', captured.currentStarFilter, '本批 stars:', [...starsInBatch]);
    }

    // 累积去重
    for (const r of newRatings) {
      if (r && r.cmtid != null) {
        captured.ratingsAll.set(r.cmtid, r);
      }
    }
    aiResult = null;
    renderPanel();
    upload({ kind: 'ratings', url, body });
  } else if (isRecommend) {
    captured.recommendCount++;
    upload({ kind: 'recommend', url, body });
  }
});

function upload(payload) {
  fetch(BACKEND + '/api/collect', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ...payload, page_url: location.href, collected_at: Date.now() })
  }).catch(() => {});
}

async function triggerAI() {
  if (!captured.pdp) return;
  aiLoading = true;
  aiResult = null;
  renderPanel();
  try {
    const reviews = Array.from(captured.ratingsAll.values());
    const r = await fetch(BACKEND + '/api/analyze', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ pdp: captured.pdp, reviews: reviews })
    });
    aiResult = await r.json();
  } catch (e) {
    aiResult = { error: e.message || String(e) };
  } finally {
    aiLoading = false;
    renderPanel();
  }
}

let panelEl = null;
function ensurePanel() {
  if (panelEl) return panelEl;
  panelEl = document.createElement('div');
  panelEl.id = 'shopee-assistant-panel';
  panelEl.innerHTML = `
    <div class="sa-handle" id="sa-handle" title="展开">
      <div class="sa-handle-arrow">◀</div>
      <div class="sa-handle-text">选品 <em>助手</em></div>
    </div>
    <div class="sa-header">
      <div class="sa-mast-tiny">
        <span>蝦皮 · 选品分析 · 演示</span>
        <span class="sa-toggle" id="sa-toggle" title="折叠">▶</span>
      </div>
      <div class="sa-mast-title">选品 <em>助手</em></div>
    </div>
    <div class="sa-body" id="sa-body"></div>
    <div class="sa-footer">
      <span><span class="sa-pulse"></span><span id="sa-status">待机中</span></span>
      <span id="sa-count">— · —</span>
    </div>
  `;
  document.body.appendChild(panelEl);
  // 折叠（点 header 里的箭头）
  document.getElementById('sa-toggle').addEventListener('click', () => {
    panelEl.classList.add('sa-collapsed');
  });
  // 展开（点折叠后露出的 handle）
  document.getElementById('sa-handle').addEventListener('click', () => {
    panelEl.classList.remove('sa-collapsed');
  });
  // 初始空态
  document.getElementById('sa-body').innerHTML =
    `<div class="sa-empty">尚无数据。<br>浏览任意 Shopee 商品或<br>使用搜索即可开始分析。</div>`;
  return panelEl;
}

function renderPanel() {
  ensurePanel();
  const body = document.getElementById('sa-body');
  const status = document.getElementById('sa-status');
  const count = document.getElementById('sa-count');

  let html = '';
  if (captured.pdp) {
    html = renderPDPView(captured.pdp);
    const ratingN = captured.ratingsAll.size;
    status.textContent = '分析中';
    count.textContent = `已抓取评论 · ${ratingN} 条`;
  } else if (captured.search) {
    html = renderSearchView(captured.search);
    status.textContent = '搜索结果';
    count.textContent = `商品 · ${(captured.search.items || []).length} 条`;
  } else {
    html = `<div class="sa-empty">尚无数据。<br>浏览任意 Shopee 商品或<br>使用搜索即可开始分析。</div>`;
  }
  body.innerHTML = html;

  const aiBtn = document.getElementById('sa-ai-btn');
  if (aiBtn) aiBtn.addEventListener('click', triggerAI);

  const descToggle = document.getElementById('sa-desc-toggle');
  const descEl = document.getElementById('sa-desc');
  if (descToggle && descEl) {
    descToggle.addEventListener('click', () => {
      const expanded = descEl.classList.toggle('sa-expanded');
      descToggle.textContent = expanded ? '收起 ▴' : '展开全文 ▾';
    });
  }
}

function fmt(n) {
  if (n === null || n === undefined) return '—';
  if (typeof n === 'number') return n.toLocaleString();
  return String(n);
}

function renderPDPView(body) {
  const data = body.data || body;
  const item = data.item || data;
  const review = data.product_review || {};
  const productPrice = data.product_price || {};

  const name = item.title || item.name || '???';
  const priceRaw = item.price || 0;
  const price = priceRaw ? (priceRaw / 100000).toLocaleString() : '—';
  const currency = item.currency || '';

  // 评分优先用 product_review 里的（更准）
  const rating = review.rating_star ?? (item.item_rating && item.item_rating.rating_star);
  const ratingStr = rating ? Number(rating).toFixed(2) : '—';

  // 销量优先用 product_review.historical_sold_display（页面显示的字符串值）
  const soldDisplay = review.historical_sold_display || review.sold_count_display || review.global_sold_display;
  const soldNum = item.global_sold_count ?? item.historical_sold;
  const soldShown = soldDisplay || (soldNum != null ? soldNum.toLocaleString() : '—');

  const ctime = item.ctime ? new Date(item.ctime * 1000).toISOString().slice(0, 10) : '—';
  const shopLoc = item.shop_location || '—';
  const brand = item.brand || '—';
  const discount = productPrice.discount || item.show_discount || item.raw_discount || 0;

  // 评论统计
  const totalRating = review.total_rating_count;
  const cmtCount = review.cmt_count;
  const likedCount = review.liked_count;

  // 分类路径
  const categories = (item.categories || []).map(c => c.display_name).filter(Boolean);

  // 商品规格（attributes：饮料形式、产地等）
  const attributes = (item.attributes || []).filter(a => a && a.name);

  // 品种（tier_variations 里的 options，比如 8 种口味）
  const variations = (item.tier_variations || []).map(v => ({
    name: v.name,
    options: v.options || []
  }));

  // 描述
  const description = item.description || '';


  return `
    <div>
      <div class="sa-section-label">商品</div>
      <h1 class="sa-product-title">${escapeHtml(name)}</h1>
    </div>

    <div>
      <div class="sa-section-label">核心指标</div>
      <div class="sa-hero">
        <div class="sa-stat">
          <div class="sa-stat-label">价格</div>
          <div class="sa-stat-value sa-shopee-text">${price}<span class="sa-stat-suffix"> ${currency}</span></div>
        </div>
        <div class="sa-stat">
          <div class="sa-stat-label">评分</div>
          <div class="sa-stat-value">${ratingStr}<span class="sa-stat-suffix"> / 5</span></div>
        </div>
        <div class="sa-stat">
          <div class="sa-stat-label">累计销量</div>
          <div class="sa-stat-value">${escapeHtml(String(soldShown))}</div>
        </div>
        <div class="sa-stat">
          <div class="sa-stat-label">折扣</div>
          <div class="sa-stat-value">${discount}<span class="sa-stat-suffix">%</span></div>
        </div>
      </div>
    </div>

    <div>
      <div class="sa-section-label">商品档案</div>
      <div class="sa-file">
        <div class="sa-file-row"><div class="sa-file-key">上架日期</div><div class="sa-file-val sa-mono">${ctime}</div></div>
        <div class="sa-file-row"><div class="sa-file-key">品牌</div><div class="sa-file-val">${escapeHtml(brand)}</div></div>
        <div class="sa-file-row"><div class="sa-file-key">店铺所在地</div><div class="sa-file-val">${escapeHtml(shopLoc)}</div></div>
        ${attributes.map(a => `<div class="sa-file-row"><div class="sa-file-key">${escapeHtml(a.name)}</div><div class="sa-file-val">${escapeHtml(a.value || '—')}</div></div>`).join('')}
      </div>
    </div>

    ${categories.length ? `
    <div>
      <div class="sa-section-label">商品分类</div>
      <div class="sa-breadcrumb">${categories.map(escapeHtml).join('<span class="sa-bc-sep">›</span>')}</div>
    </div>` : ''}

    ${variations.length && variations[0].options.length ? `
    <div>
      <div class="sa-section-label">${escapeHtml(variations[0].name || '品种')} · ${variations[0].options.length} 款</div>
      <div class="sa-variations">
        ${variations[0].options.map(o => `<span class="sa-variation-chip">${escapeHtml(o)}</span>`).join('')}
      </div>
    </div>` : ''}

    ${description ? `
    <div>
      <div class="sa-section-label">商品描述</div>
      <div class="sa-desc" id="sa-desc">${escapeHtml(description)}</div>
      <span class="sa-desc-toggle" id="sa-desc-toggle">展开全文 ▾</span>
    </div>` : ''}

    ${renderReviewsSection()}

    ${renderAISection()}
  `;
}

function renderReviewsSection() {
  const allRatings = Array.from(captured.ratingsAll.values());
  const pdpReview = (captured.pdp && captured.pdp.data && captured.pdp.data.product_review) || {};
  const total = pdpReview.total_rating_count || 0;
  const cmt = pdpReview.cmt_count || 0;
  const liked = pdpReview.liked_count || 0;

  // 抓到的样本按星级分布
  const captBy = {1:0,2:0,3:0,4:0,5:0};
  for (const r of allRatings) {
    const s = r.rating_star || r.rating;
    if (captBy[s] != null) captBy[s]++;
  }

  // 全站评分分布（来自 PDP）
  const ratingArr = pdpReview.rating_count || [];
  const siteBy = (Array.isArray(ratingArr) && ratingArr.length >= 6)
    ? {1: ratingArr[1], 2: ratingArr[2], 3: ratingArr[3], 4: ratingArr[4], 5: ratingArr[5]}
    : null;

  const summaryHtml = `
    <div class="sa-review-summary">
      <div class="sa-review-summary-item">
        <div class="sa-review-summary-num">${fmt(total)}</div>
        <div class="sa-review-summary-lbl">总评分数</div>
      </div>
      <div class="sa-review-summary-item">
        <div class="sa-review-summary-num">${fmt(cmt)}</div>
        <div class="sa-review-summary-lbl">有内容评论</div>
      </div>
      <div class="sa-review-summary-item">
        <div class="sa-review-summary-num">${fmt(liked)}</div>
        <div class="sa-review-summary-lbl">收藏数</div>
      </div>
    </div>
  `;

  // 评论分布：纵向表格，每行一个星级
  const distHtml = `
    <div class="sa-review-dist">
      <div class="sa-dist-head">
        <div>星级</div>
        <div>已抓</div>
        <div>全站</div>
      </div>
      ${[5,4,3,2,1].map(s => `
        <div class="sa-dist-row">
          <div class="sa-dist-star">${s} ★</div>
          <div class="sa-dist-num ${captBy[s]?'sa-captured':'sa-zero'}">${captBy[s]}</div>
          <div class="sa-dist-num ${siteBy && siteBy[s]?'':'sa-zero'}">${siteBy ? fmt(siteBy[s]) : '—'}</div>
        </div>
      `).join('')}
    </div>
  `;

  // 提示用户去抓低星
  let tip = '';
  const lowCaptured = captBy[1] + captBy[2] + captBy[3];
  if (allRatings.length === 0) {
    tip = `<div class="sa-tip">⚠ 滚动到 Shopee 评论区让评论加载，监听器会自动抓取</div>`;
  } else if (lowCaptured === 0) {
    tip = `<div class="sa-tip">💡 当前抓到的全是好评。<br>点击 Shopee 评论区上方的 <b>1星 / 2星 / 3星</b> 标签，扩展会自动累积所有星级评论，AI 分析会更客观</div>`;
  } else if (lowCaptured < 5) {
    tip = `<div class="sa-tip">💡 已抓到 ${lowCaptured} 条低星评论。继续点 1-3 星标签可让样本更充分</div>`;
  }

  // 选择要显示的评论
  const filter = captured.currentStarFilter;
  let displayReviews;
  let filterBadge = '';
  if (filter >= 1 && filter <= 5) {
    // 用户在 Shopee 点了某个星级 → 面板只显示该星级
    displayReviews = allRatings.filter(r => (r.rating_star || r.rating) === filter);
    filterBadge = `<div class="sa-filter-badge">聚焦：${filter} ★ 评论 · ${displayReviews.length} 条</div>`;
  } else {
    // 全部模式：按时间倒序混合显示
    displayReviews = [...allRatings].sort((a, b) => (b.ctime || 0) - (a.ctime || 0));
    if (allRatings.length > 0) {
      filterBadge = `<div class="sa-filter-badge">全部评论 · 按时间倒序</div>`;
    }
  }

  const reviewItems = displayReviews.slice(0, 8).map(r => {
    const stars = r.rating_star || r.rating || 0;
    const starHtml = '★'.repeat(stars) + `<span class="sa-star-empty">${'★'.repeat(5 - stars)}</span>`;
    const date = r.ctime ? new Date(r.ctime * 1000).toISOString().slice(0, 10) : '';
    const author = r.author_username || '匿名';
    const cmt = (r.comment || '').trim().slice(0, 280);
    if (!cmt) return '';
    return `
      <div class="sa-review">
        <div class="sa-review-head">
          <div class="sa-review-stars">${starHtml}</div>
          <div class="sa-review-meta">${escapeHtml(author)} · ${date}</div>
        </div>
        <div class="sa-review-body">${escapeHtml(cmt)}</div>
      </div>
    `;
  }).join('');

  return `
    <div>
      <div class="sa-section-label">用户评价 · 抓样 ${allRatings.length} / ${fmt(cmt)}</div>
      ${summaryHtml}
      ${distHtml}
      ${tip}
      ${filterBadge}
      ${reviewItems}
    </div>
  `;
}

function renderAISection() {
  if (aiLoading) {
    return `
      <div class="sa-ai">
        <div class="sa-ai-mast">
          <div class="sa-ai-mast-eye">—— AI 智能分析 ——</div>
          <div class="sa-ai-mast-title">选品分析</div>
        </div>
        <div class="sa-loading">正在分析评论</div>
      </div>
    `;
  }

  if (aiResult && aiResult.error) {
    return `
      <div class="sa-ai">
        <div class="sa-ai-mast">
          <div class="sa-ai-mast-eye">—— AI 智能分析 ——</div>
          <div class="sa-ai-mast-title">选品分析</div>
        </div>
        <div class="sa-error">${escapeHtml(aiResult.error)}</div>
        <button class="sa-ai-trigger" id="sa-ai-btn"><span>重试</span></button>
      </div>
    `;
  }

  if (aiResult && aiResult.ok) {
    return renderAIResult(aiResult);
  }

  return `
    <div class="sa-ai">
      <div class="sa-ai-mast">
        <div class="sa-ai-mast-eye">— Editorial AI —</div>
        <div class="sa-ai-mast-title">Analysis</div>
      </div>
      <button class="sa-ai-trigger" id="sa-ai-btn"><span>启动 AI 分析</span></button>
    </div>
  `;
}

function renderAIResult(r) {
  const cluster = r.review_cluster || {};
  const decision = r.decision || {};
  const lis = (arr) => (arr && arr.length ? arr : ['(无数据)']).map(x => `<li>${escapeHtml(x)}</li>`).join('');

  return `
    <div class="sa-ai">
      <div class="sa-ai-mast">
        <div class="sa-ai-mast-eye">— Editorial AI —</div>
        <div class="sa-ai-mast-title">Analysis</div>
      </div>

      <div class="sa-ai-block sa-pros">
        <div class="sa-ai-block-head"><span class="sa-zh">优</span><span class="sa-en">用户喜欢</span></div>
        <ul class="sa-ai-list">${lis(cluster.pros)}</ul>
      </div>

      <div class="sa-ai-block sa-cons">
        <div class="sa-ai-block-head"><span class="sa-zh">缺</span><span class="sa-en">用户抱怨</span></div>
        <ul class="sa-ai-list">${lis(cluster.cons)}</ul>
      </div>

      <div class="sa-ai-block sa-imp">
        <div class="sa-ai-block-head"><span class="sa-zh">改</span><span class="sa-en">改良建议</span></div>
        <ul class="sa-ai-list">${lis(cluster.improvements)}</ul>
      </div>

      <div class="sa-verdict">
        <div class="sa-verdict-eye">—— 决策判断 ——</div>
        <div class="sa-verdict-call">${escapeHtml(decision.verdict || '—')}</div>
        <div class="sa-verdict-body">${escapeHtml(decision.reasoning || '')}</div>
      </div>

      <button class="sa-ai-trigger" id="sa-ai-btn" style="margin-top:24px;"><span>重新分析</span></button>
    </div>
  `;
}

function renderSearchView(body) {
  const items = body.items || [];
  if (!items.length) return `<div class="sa-empty">本次搜索无商品。</div>`;

  const rows = items.slice(0, 12).map((it) => {
    const ib = it.item_basic || it;
    const name = (ib.name || '').slice(0, 60);
    const price = ib.price ? (ib.price / 100000).toLocaleString() : '—';
    const sold = ib.historical_sold || ib.sold || '—';
    const cur = ib.currency || '';
    return `
      <div class="sa-search-item">
        <div class="sa-search-name">${escapeHtml(name)}</div>
        <div class="sa-search-price">${cur} ${price}</div>
        <div class="sa-search-meta">累计销量 · ${fmt(sold)}</div>
      </div>
    `;
  }).join('');

  return `
    <div>
      <div class="sa-section-label">搜索结果 · ${items.length} 条</div>
      ${rows}
    </div>
  `;
}

function escapeHtml(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

ensurePanel();
console.log('[Shopee助手] content script loaded');
