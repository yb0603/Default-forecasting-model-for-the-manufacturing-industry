/* Default Forecasting Model — 대시보드 로직 (vanilla JS, 빌드 도구 없음)
   data/dashboard_data.js가 미리 로드되어 window.__DASHBOARD_DATA__를 채워둠. */

(function () {
  "use strict";

  const DATA = window.__DASHBOARD_DATA__;
  const META = DATA.meta;
  const COMPANIES = DATA.companies;
  const PROB_HISTORY = window.__COMPANY_PROBABILITY_HISTORY__ || {};
  const NEWS = window.__COMPANY_NEWS__ || {};

  const TIER_THRESHOLDS = { all: 0, top30: 70, top10: 90, top1: 99 };
  const PAGE_SIZE = 50;
  const TREND_THRESHOLD = 0.02; // 2%p 미만 변화는 "보합(flat)"으로 간주(잡음 필터링)

  const state = {
    search: "",
    listedStatus: "all",
    priorDefault: "all",
    tier: "all",
    sortKey: "rank",
    sortDir: "asc",
    page: 1,
  };

  // ---------------- 파생 지표(추세/최근 부정뉴스) 사전계산 ----------------
  // 리스트는 항상 current_screening(2025년말 스크리닝 대상)만 다루므로,
  // 별도 데이터 파일(부도확률 3개년 시계열/뉴스 감성분석)에서 회사별로 한
  // 번만 계산해 COMPANIES 각 항목에 붙여둔다(정렬 지원을 위해 사전계산 필요).

  function computeTrend(c) {
    const entry = PROB_HISTORY[c.corp_code + "::" + c.group];
    if (!entry) return { dir: "na", diff: null };
    const chron = entry.points.slice().reverse(); // 과거->최신 순
    const usable = chron.filter((p) => p.probability !== null);
    if (usable.length < 2) return { dir: "na", diff: null };
    const diff = usable[usable.length - 1].probability - usable[0].probability;
    if (diff > TREND_THRESHOLD) return { dir: "up", diff };
    if (diff < -TREND_THRESHOLD) return { dir: "down", diff };
    return { dir: "flat", diff };
  }

  function countNegativeNews(c) {
    const entry = NEWS[c.corp_code + "::" + c.group];
    if (!entry || !entry.articles) return 0;
    return entry.articles.filter((a) => a.sentiment && a.sentiment.label === "negative").length;
  }

  function enrichCompanies() {
    COMPANIES.forEach((c) => {
      const trend = computeTrend(c);
      c.trend_dir = trend.dir;
      c.trend_diff = trend.diff;
      c.neg_news_count = countNegativeNews(c);
    });
  }

  // ---------------- 유틸 ----------------

  function tierInfo(percentile) {
    if (percentile >= 99) return { key: "critical", label: "상위 1%" };
    if (percentile >= 90) return { key: "serious", label: "상위 10%" };
    if (percentile >= 70) return { key: "warning", label: "상위 30%" };
    return { key: "good", label: "하위 70%" };
  }

  function fmtPct(v, digits) {
    if (v === null || v === undefined || Number.isNaN(v)) return "N/A";
    return (v * 100).toFixed(digits === undefined ? 1 : digits) + "%";
  }

  function fmtIndicator(key, value) {
    if (value === null || value === undefined) return "N/A";
    const def = META.feature_defs[key];
    if (!def) return String(value);
    if (def.format === "percent") return fmtPct(value, 1);
    if (def.format === "ratio" || def.format === "number") {
      const abs = Math.abs(value);
      const digits = abs >= 100 ? 1 : abs >= 1 ? 2 : 4;
      return value.toLocaleString("ko-KR", { minimumFractionDigits: digits, maximumFractionDigits: digits });
    }
    return String(value);
  }

  function debounce(fn, ms) {
    let t;
    return function (...args) {
      clearTimeout(t);
      t = setTimeout(() => fn.apply(null, args), ms);
    };
  }

  // ---------------- 헤더: 통계 타일 ----------------

  function renderStatTiles() {
    const p = META.performance;
    const xgb = p.time_split.XGBoost;
    const tiles = [
      {
        label: "2025년말 스크리닝 대상", value: META.screening.n_companies.toLocaleString(),
        sub: `비상장 ${META.screening.n_unlisted} · 상장 ${META.screening.n_listed} · 과거 부도 이력 ${META.screening.n_prior_default}건 포함`,
      },
      { label: "과거 실제부도 참고사례", value: META.n_default_reference.toLocaleString(), sub: "확률 눈금 보정용" },
      { label: "시간분할 ROC-AUC", value: xgb.roc_auc.toFixed(3), sub: "과거→미래 예측 시나리오 기준(모델 검증)" },
      { label: "시간분할 PR-AUC", value: xgb.pr_auc.toFixed(3), sub: `학습데이터 부도비율 ${META.training.positive_rate_pct}%` },
      { label: "모델 학습 표본", value: META.training.n_total.toLocaleString(), sub: `부도 ${META.training.n_default} · 정상 ${META.training.n_control}` },
    ];

    const el = document.getElementById("statTiles");
    el.innerHTML = tiles
      .map(
        (t) => `
      <div class="stat-tile">
        <div class="stat-tile-label">${t.label}</div>
        <div class="stat-tile-value">${t.value}</div>
        <div class="stat-tile-sub">${t.sub}</div>
      </div>`
      )
      .join("");
  }

  // ---------------- 한계점 배너 ----------------

  function renderLimitations() {
    document.getElementById("limitationsCount").textContent =
      `이 모델은 완벽하지 않습니다 — ${META.limitations.length}가지 한계가 있습니다.`;

    const el = document.getElementById("limitationsDetail");
    el.innerHTML = META.limitations
      .map(
        (l) => `
      <div class="limitation-card">
        <h3>${l.title}</h3>
        <p>${l.body}</p>
      </div>`
      )
      .join("");

    const toggleBtn = document.getElementById("limitationsToggle");
    toggleBtn.addEventListener("click", () => {
      const isHidden = el.hasAttribute("hidden");
      if (isHidden) {
        el.removeAttribute("hidden");
        toggleBtn.setAttribute("aria-expanded", "true");
      } else {
        el.setAttribute("hidden", "");
        toggleBtn.setAttribute("aria-expanded", "false");
      }
    });

    document.getElementById("jumpToLimitations").addEventListener("click", () => {
      document.getElementById("limitationsBanner").scrollIntoView({ behavior: "smooth" });
      if (el.hasAttribute("hidden")) toggleBtn.click();
    });
  }

  // ---------------- 컨트롤바 ----------------

  function renderTierChips() {
    const chips = [
      { key: "all", label: "전체" },
      { key: "top30", label: "상위 30%" },
      { key: "top10", label: "상위 10%" },
      { key: "top1", label: "상위 1%" },
    ];
    const el = document.getElementById("tierChips");
    el.innerHTML = chips
      .map((c) => `<button type="button" class="chip" data-tier="${c.key}" aria-pressed="${state.tier === c.key}">${c.label}</button>`)
      .join("");
    el.querySelectorAll(".chip").forEach((btn) => {
      btn.addEventListener("click", () => {
        state.tier = btn.dataset.tier;
        state.page = 1;
        renderTierChips();
        renderTable();
      });
    });
  }

  function initControls() {
    const searchInput = document.getElementById("searchInput");
    searchInput.addEventListener(
      "input",
      debounce((e) => {
        state.search = e.target.value.trim().toLowerCase();
        state.page = 1;
        renderTable();
      }, 180)
    );

    const listedFilter = document.getElementById("listedFilter");
    listedFilter.addEventListener("change", (e) => {
      state.listedStatus = e.target.value;
      state.page = 1;
      renderTable();
    });

    const priorDefaultFilter = document.getElementById("priorDefaultFilter");
    priorDefaultFilter.addEventListener("change", (e) => {
      state.priorDefault = e.target.value;
      state.page = 1;
      renderTable();
    });

    renderTierChips();

    document.getElementById("resetFilters").addEventListener("click", () => {
      state.search = "";
      state.listedStatus = "all";
      state.priorDefault = "all";
      state.tier = "all";
      state.sortKey = "rank";
      state.sortDir = "asc";
      state.page = 1;
      searchInput.value = "";
      listedFilter.value = "all";
      priorDefaultFilter.value = "all";
      renderTierChips();
      updateSortHeaders();
      renderTable();
    });

    document.querySelectorAll("#rankingTable th.sortable").forEach((th) => {
      th.addEventListener("click", () => {
        const key = th.dataset.sort;
        if (state.sortKey === key) {
          state.sortDir = state.sortDir === "asc" ? "desc" : "asc";
        } else {
          state.sortKey = key;
          state.sortDir = "asc";
        }
        state.page = 1;
        updateSortHeaders();
        renderTable();
      });
    });
  }

  function updateSortHeaders() {
    document.querySelectorAll("#rankingTable th.sortable").forEach((th) => {
      th.classList.toggle("sort-active", th.dataset.sort === state.sortKey);
      const existingCaret = th.querySelector(".sort-caret");
      if (existingCaret) existingCaret.remove();
      if (th.dataset.sort === state.sortKey) {
        const caret = document.createElement("span");
        caret.className = "sort-caret";
        caret.textContent = state.sortDir === "asc" ? "▲" : "▼";
        th.appendChild(caret);
      }
    });
  }

  // ---------------- 필터링 / 정렬 / 페이지네이션 ----------------

  function getSortValue(c, key) {
    if (key === "rank" || key === "corp_name" || key === "sector_name" ||
        key === "ref_year" || key === "probability" || key === "default_year" ||
        key === "neg_news_count" || key === "trend_diff") {
      return c[key];
    }
    return c.indicators[key];
  }

  function getFilteredSorted() {
    let rows = COMPANIES.filter((c) => {
      if (c.group !== "current_screening") return false; // 리스트는 항상 2025년말 스크리닝 대상만
      if (state.listedStatus !== "all" && c.listed_status !== state.listedStatus) return false;
      if (state.priorDefault === "has" && !c.default_year) return false;
      if (state.priorDefault === "none" && c.default_year) return false;
      if (state.tier !== "all" && c.percentile < TIER_THRESHOLDS[state.tier]) return false;
      if (state.search) {
        const nameMatch = c.corp_name.toLowerCase().includes(state.search);
        const codeMatch = c.corp_code.includes(state.search);
        if (!nameMatch && !codeMatch) return false;
      }
      return true;
    });

    rows.sort((a, b) => {
      const va = getSortValue(a, state.sortKey);
      const vb = getSortValue(b, state.sortKey);
      if (va === null && vb === null) return 0;
      if (va === null) return 1;
      if (vb === null) return -1;
      let cmp;
      if (typeof va === "string") cmp = va.localeCompare(vb, "ko");
      else cmp = va - vb;
      return state.sortDir === "asc" ? cmp : -cmp;
    });

    return rows;
  }

  // ---------------- 테이블 렌더링 ----------------

  function rowKey(c) {
    return c.corp_code + "_" + c.rank;
  }

  function trendCell(c) {
    if (c.trend_dir === "na" || c.trend_dir === undefined) return '<span class="na">N/A</span>';
    const cls = c.trend_dir === "up" ? "trend-up" : c.trend_dir === "down" ? "trend-down" : "trend-flat";
    const arrow = c.trend_dir === "up" ? "▲" : c.trend_dir === "down" ? "▼" : "→";
    const diffText = ` ${c.trend_diff >= 0 ? "+" : ""}${(c.trend_diff * 100).toFixed(1)}%p`;
    return `<span class="trend-badge ${cls}" title="2023년→2025년 부도확률 변화">${arrow}${diffText}</span>`;
  }

  function negNewsCell(c) {
    if (c.neg_news_count > 0) {
      return `<span class="neg-news-badge" title="KR-FinBERT 감성분석 기준 부정 분류된 주요 기사 수">${c.neg_news_count}건</span>`;
    }
    return '<span class="na">0건</span>';
  }

  function buildDataRow(c) {
    const tier = tierInfo(c.percentile);
    const priorDefaultBadge = c.default_year
      ? `<span class="badge badge-warning" title="공시 기준 과거 부도(회생/워크아웃 등) 이력 - 확률은 그 이후 재무제표 기준 재예측값">${c.default_year}년</span>`
      : '<span class="na">-</span>';

    const tr = document.createElement("tr");
    tr.className = "data-row";
    tr.dataset.key = rowKey(c);

    tr.innerHTML = `
      <td>${c.rank.toLocaleString()}</td>
      <td class="corp-cell">
        <span class="corp-name">${c.corp_name}</span>
        <span class="corp-code">${c.corp_code}</span>
      </td>
      <td class="industry-cell">${c.sector_name || "미분류"}</td>
      <td>${priorDefaultBadge}</td>
      <td>${negNewsCell(c)}</td>
      <td>${trendCell(c)}</td>
      <td>
        <div class="risk-cell risk-${tier.key}">
          <span class="risk-badge"><span class="risk-dot"></span><span class="risk-label">${tier.label}</span></span>
          <span class="risk-prob">${fmtPct(c.probability, 1)}</span>
        </div>
      </td>
    `;
    tr.addEventListener("click", () => {
      window.location.href = "company.html?corp_code=" + encodeURIComponent(c.corp_code) +
        "&group=" + encodeURIComponent(c.group);
    });
    return tr;
  }

  function renderPagination(totalRows, totalPages) {
    const el = document.getElementById("pagination");
    if (totalPages <= 1) {
      el.innerHTML = "";
      return;
    }
    el.innerHTML = `
      <button type="button" id="prevPage" ${state.page <= 1 ? "disabled" : ""}>이전</button>
      <span class="pagination-info">${state.page} / ${totalPages}페이지</span>
      <button type="button" id="nextPage" ${state.page >= totalPages ? "disabled" : ""}>다음</button>
    `;
    const prev = document.getElementById("prevPage");
    const next = document.getElementById("nextPage");
    if (prev) prev.addEventListener("click", () => { state.page -= 1; renderTable(); window.scrollTo({ top: 0, behavior: "smooth" }); });
    if (next) next.addEventListener("click", () => { state.page += 1; renderTable(); window.scrollTo({ top: 0, behavior: "smooth" }); });
  }

  function renderTable() {
    const filtered = getFilteredSorted();
    const totalPages = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));
    state.page = Math.min(state.page, totalPages);

    const start = (state.page - 1) * PAGE_SIZE;
    const pageRows = filtered.slice(start, start + PAGE_SIZE);

    const tbody = document.getElementById("tableBody");
    tbody.innerHTML = "";
    const frag = document.createDocumentFragment();
    pageRows.forEach((c) => {
      frag.appendChild(buildDataRow(c));
    });
    tbody.appendChild(frag);

    document.getElementById("resultCount").textContent =
      `${META.screening.n_companies.toLocaleString()}개 중 ${filtered.length.toLocaleString()}개 표시 중`;

    renderPagination(filtered.length, totalPages);
  }

  // ---------------- 헤더 툴팁(ⓘ) ----------------
  // .table-scroll이 overflow-x:auto라 그 안에 있는 절대위치 툴팁은 오른쪽
  // 끝 컬럼에서 잘림(2026-08-21 발견) - body에 직접 붙는 공용 툴팁 하나를
  // position:fixed로 띄우고 뷰포트 안으로 좌표를 클램핑하는 방식으로 해결.

  function initTooltips() {
    const tip = document.createElement("div");
    tip.className = "global-tooltip";
    tip.setAttribute("role", "tooltip");
    tip.hidden = true;
    document.body.appendChild(tip);

    function show(el) {
      const text = el.dataset.tooltip;
      if (!text) return;
      tip.textContent = text;
      tip.hidden = false;
      tip.style.left = "0px";
      tip.style.top = "0px";
      const anchor = el.getBoundingClientRect();
      const tipRect = tip.getBoundingClientRect();
      const margin = 8;
      let left = anchor.left + anchor.width / 2 - tipRect.width / 2;
      left = Math.min(Math.max(margin, left), window.innerWidth - tipRect.width - margin);
      let top = anchor.top - tipRect.height - 8;
      if (top < margin) top = anchor.bottom + 8; // 위 공간 부족하면 아래로
      tip.style.left = `${left}px`;
      tip.style.top = `${top}px`;
    }
    function hide() {
      tip.hidden = true;
    }

    document.querySelectorAll(".th-tooltip").forEach((el) => {
      el.addEventListener("mouseenter", () => show(el));
      el.addEventListener("mouseleave", hide);
      el.addEventListener("focus", () => show(el));
      el.addEventListener("blur", hide);
      el.addEventListener("click", (e) => {
        e.stopPropagation(); // th의 정렬 클릭으로 전파 방지
        show(el);
      });
    });
    document.addEventListener("scroll", hide, true);
    window.addEventListener("resize", hide);
  }

  // ---------------- 테마 토글 ----------------

  function initTheme() {
    const stored = localStorage.getItem("dfm-theme");
    if (stored) document.documentElement.setAttribute("data-theme", stored);
    updateThemeIcon();

    document.getElementById("themeToggle").addEventListener("click", () => {
      const current = document.documentElement.getAttribute("data-theme");
      const systemDark = window.matchMedia("(prefers-color-scheme: dark)").matches;
      const isDark = current ? current === "dark" : systemDark;
      const next = isDark ? "light" : "dark";
      document.documentElement.setAttribute("data-theme", next);
      localStorage.setItem("dfm-theme", next);
      updateThemeIcon();
    });
  }

  function updateThemeIcon() {
    const current = document.documentElement.getAttribute("data-theme");
    const systemDark = window.matchMedia("(prefers-color-scheme: dark)").matches;
    const isDark = current ? current === "dark" : systemDark;
    document.getElementById("themeIcon").textContent = isDark ? "☀️" : "🌙";
  }

  // ---------------- 푸터 ----------------

  function renderFooterMeta() {
    const d = new Date(META.generated_at);
    document.getElementById("footerMeta").textContent = `모델 데이터 기준: ${d.toLocaleString("ko-KR")}`;
  }

  // ---------------- 초기화 ----------------

  function init() {
    initTheme();
    enrichCompanies();
    renderStatTiles();
    renderLimitations();
    initControls();
    initTooltips();
    updateSortHeaders();
    renderTable();
    renderFooterMeta();
  }

  document.addEventListener("DOMContentLoaded", init);
})();
