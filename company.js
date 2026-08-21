/* Default Forecasting Model — 회사 상세페이지 로직 (vanilla JS)
   data/dashboard_data.js + data/company_financials.js + data/company_audit_history.js가
   미리 로드되어 window.__DASHBOARD_DATA__ / __COMPANY_FINANCIALS__ /
   __COMPANY_AUDIT_HISTORY__를 채워둠. */

(function () {
  "use strict";

  const DATA = window.__DASHBOARD_DATA__;
  const META = DATA.meta;
  const COMPANIES = DATA.companies;
  const FINANCIALS = window.__COMPANY_FINANCIALS__ || {};
  const AUDIT_HISTORY = window.__COMPANY_AUDIT_HISTORY__ || {};
  const NEWS = window.__COMPANY_NEWS__ || {};
  const PROFITABILITY_EXTRA = window.__COMPANY_PROFITABILITY_EXTRA__ || {};
  const PROB_HISTORY = window.__COMPANY_PROBABILITY_HISTORY__ || {};
  const FEATURES = Object.keys(META.feature_defs);
  const IMPORTANCE_RANK = Object.fromEntries(META.feature_importance.map((f) => [f.feature, f.rank]));
  const FEATURES_BY_IMPORTANCE = [...FEATURES].sort((a, b) => IMPORTANCE_RANK[a] - IMPORTANCE_RANK[b]);

  const STMT_ORDER = [
    { key: "BS", label: "재무상태표" },
    { key: "IS", label: "손익계산서" },
    { key: "CF", label: "현금흐름표" },
  ];

  // 계정 레벨(단계) 분류 - 실제 XBRL 프레젠테이션 깊이 정보가 없어(project 데이터
  // 소스 한계) 계정명 키워드로 추정하는 휴리스틱. level 0 = 최종 총계/합계선,
  // level 1 = 구간 소계(유동자산/영업이익 등), level 2 = 나머지 세부 라인아이템.
  // 2026-08-21: 전역 키워드 목록 하나를 BS/IS/CF에 다 같이 쓰던 방식은
  // 통계표를 모르고 매칭해서 서로 다른 표의 계정명이 우연히 겹치면(예: 향후
  // "매출채권"(BS)과 "매출"(IS)) 오분류될 위험이 있었음 - 통계표별로 분리.
  const LEVEL0_KEYWORDS = {
    BS: ["자산총계", "부채총계", "자본총계",
         "부채와자본총계", "부채및자본총계", "자본과부채총계", "자본및부채총계"],
    IS: ["매출액", "수익(매출액)", "매출",
         "매출총이익", "매출총손실",
         "영업이익", "영업손실",
         "법인세비용차감전순이익", "법인세비용차감전순손실",
         "당기순이익", "당기순손실",
         "총포괄손익", "당기총포괄손익", "총포괄이익", "당기총포괄이익"],
    CF: ["영업활동현금흐름", "영업활동으로인한현금흐름",
         "투자활동현금흐름", "투자활동으로인한현금흐름",
         "재무활동현금흐름", "재무활동으로인한현금흐름",
         "현금및현금성자산의증가", "현금및현금성자산의순증가", "현금및현금성자산의감소",
         "기초현금및현금성자산", "기초의현금및현금성자산",
         "기말현금및현금성자산", "기말의현금및현금성자산"],
  };
  const LEVEL1_KEYWORDS = {
    BS: ["유동자산", "비유동자산", "유동부채", "비유동부채",
         "자본금", "자본잉여금", "이익잉여금", "기타자본항목", "기타포괄손익누계액"],
    IS: ["매출원가", "판매비와관리비", "영업외수익", "영업외비용",
         "금융수익", "금융비용", "법인세비용", "기타수익", "기타비용", "기타포괄손익"],
    CF: [],
  };
  // "유동자산"/"비유동자산" 등은 "기타유동자산"·"매각예정비유동자산"처럼 훨씬
  // 흔한 세부 계정명의 부분문자열이기도 해서(포함 여부로 판정하면 세부항목이
  // 소계처럼 굵게 표시되는 오탐이 발생) 이 4개만 정확히 일치할 때만 인정.
  const EXACT_ONLY_KEYWORDS = new Set(["유동자산", "비유동자산", "유동부채", "비유동부채"]);

  function normAccountName(name) {
    return (name || "").replace(/\s+/g, "");
  }

  // 통계표(stmtKey)별 LEVEL0/LEVEL1 키워드 중 실제로 매칭되면서 가장 긴(=가장
  // 구체적인) 키워드를 채택한다 - 예: "매출원가"는 짧은 "매출"에도 걸리지만
  // "매출원가"가 더 길어 그쪽이 우선하므로 원가가 매출(총계)로 오분류되지 않음.
  function accountLevel(stmtKey, name) {
    const n = normAccountName(name);
    if (!n) return 2;
    let best = null;
    (LEVEL0_KEYWORDS[stmtKey] || []).forEach((k) => {
      const hit = EXACT_ONLY_KEYWORDS.has(k) ? n === k : n.includes(k);
      if (hit && (!best || k.length > best.k.length)) best = { k, level: 0 };
    });
    (LEVEL1_KEYWORDS[stmtKey] || []).forEach((k) => {
      const hit = EXACT_ONLY_KEYWORDS.has(k) ? n === k : n.includes(k);
      if (hit && (!best || k.length > best.k.length)) best = { k, level: 1 };
    });
    return best ? best.level : 2;
  }

  // 재무제표 표준 표시 순서(사람이 읽는 관례) - 원본 데이터는 XBRL 계정코드
  // 순서라 실제 신고서 표시 순서와 무관하게 뒤섞여 있어(예: "매출액"이 맨
  // 뒤에, CF는 기초/기말현금이 맨 앞에 오기도 함), 알려진 구간(대분류/소계)
  // 키워드를 기준으로 재배치한다. 구간에 안 걸리는 세부 라인아이템은
  // "직전에 나온 구간"에 안정적으로 묶여 원래 상대 순서를 유지.
  const CANONICAL_ORDER = {
    BS: ["유동자산", "비유동자산", "자산총계",
         "유동부채", "비유동부채", "부채총계",
         "자본금", "자본잉여금", "이익잉여금", "기타자본항목", "기타포괄손익누계액",
         "자본총계",
         "부채와자본총계", "부채및자본총계", "자본과부채총계", "자본및부채총계"],
    IS: ["매출액", "수익(매출액)", "매출",
         "매출원가", "매출총이익", "매출총손실",
         "판매비와관리비", "영업이익", "영업손실",
         "기타영업수익", "기타영업비용", "금융수익", "금융비용", "기타수익", "기타비용",
         "법인세비용차감전순이익", "법인세비용차감전순손실", "법인세비용",
         "당기순이익", "당기순손실",
         "기타포괄손익", "총포괄손익", "당기총포괄손익", "총포괄이익", "당기총포괄이익",
         "기본주당이익", "희석주당이익"],
    CF: ["영업활동현금흐름", "영업활동으로인한현금흐름",
         "투자활동현금흐름", "투자활동으로인한현금흐름",
         "재무활동현금흐름", "재무활동으로인한현금흐름",
         "환율변동효과", "현금및현금성자산의증가", "현금및현금성자산의순증가",
         "현금및현금성자산의감소",
         "기초현금및현금성자산", "기초의현금및현금성자산",
         "기말현금및현금성자산", "기말의현금및현금성자산"],
  };

  function orderStatementLines(stmtKey, lines) {
    const order = CANONICAL_ORDER[stmtKey] || [];
    let lastAnchor = -1;
    const withKeys = lines.map((line) => {
      const n = normAccountName(line.name);
      let bestIdx = -1;
      let bestLen = -1;
      order.forEach((k, i) => {
        if (n.includes(k) && k.length > bestLen) {
          bestIdx = i;
          bestLen = k.length;
        }
      });
      if (bestIdx !== -1) lastAnchor = bestIdx;
      return { line, sortKey: bestIdx !== -1 ? bestIdx : lastAnchor };
    });
    // Array.prototype.sort는 안정 정렬(stable) - 같은 sortKey 안에서는
    // 원본(신고서) 순서 그대로 유지됨
    withKeys.sort((a, b) => a.sortKey - b.sortKey);
    return withKeys.map((w) => w.line);
  }

  // ---------------- 유틸 (app.js와 동일 로직, 페이지 독립성을 위해 별도 보관) ----------------

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

  function fmtAmount(v) {
    if (v === null || v === undefined) return "";
    const eok = v / 1e8;
    return eok.toLocaleString("ko-KR", { minimumFractionDigits: 1, maximumFractionDigits: 1 }) + "억";
  }

  // ---------------- 회사 찾기 ----------------

  function findCompany() {
    const params = new URLSearchParams(window.location.search);
    const corpCode = params.get("corp_code");
    const group = params.get("group");
    if (!corpCode) return null;
    return COMPANIES.find((c) => c.corp_code === corpCode && (!group || c.group === group)) || null;
  }

  // ---------------- 렌더링 ----------------

  function renderOverview(c) {
    const tier = tierInfo(c.percentile);
    const groupLabel = c.group === "default" ? "실제부도(과거 참고사례)" : "2025년말 스크리닝 대상";
    const groupBadgeClass = c.group === "default" ? "badge-default" : "badge-control";
    const rangeBadge = c.group === "current_screening" && !c.in_training_range
      ? '<span class="badge badge-warning">학습범위 밖(외삽)</span>' : "";

    let metaHtml = `
      <span><strong>산업</strong> ${escapeHtml(c.sector_name) || "미분류"}</span>
      <span><strong>순위</strong> ${c.rank.toLocaleString()} / ${(c.group === "default" ? META.n_default_reference : META.screening.n_companies).toLocaleString()} (그룹 내 백분위 ${c.percentile.toFixed(1)})</span>
      <span><strong>기준연도</strong> ${c.ref_year === null ? "N/A" : c.ref_year}</span>`;
    if (c.group === "default") {
      metaHtml += `
      <span><strong>상장여부(사건당시)</strong> ${escapeHtml(c.listed_status) || "N/A"}</span>
      <span><strong>부도연도</strong> ${c.default_year === null ? "N/A" : c.default_year}</span>
      <span><strong>채점방식</strong> 교차검증(out-of-fold)</span>`;
    } else {
      const methodLabel = c.score_method === "oof_cv" ? "교차검증(out-of-fold)" : "배포모델(전체 학습데이터로 예측)";
      metaHtml += `
      <span><strong>자산총계</strong> ${c.asset_total === null ? "N/A" : fmtAmount(c.asset_total) + "원"}</span>
      <span><strong>채점방식</strong> ${methodLabel}</span>
      <span><strong>학습범위</strong> ${c.in_training_range ? "범위 내" : "범위 밖(외삽)"}</span>
      <span><strong>과거 부도 이력</strong> ${c.default_year ? `${c.default_year}년 (공시 기준)` : "확인된 이력 없음"}</span>`;
    }

    document.getElementById("companyOverview").innerHTML = `
      <div class="company-overview-title">
        <h1>${escapeHtml(c.corp_name)}</h1>
        <span class="corp-code">${escapeHtml(c.corp_code)}</span>
        <div class="company-overview-badges">
          <span class="badge ${groupBadgeClass}">${groupLabel}</span>
          ${rangeBadge}
          ${c.group === "current_screening" && c.default_year ? `<span class="badge badge-warning">과거 부도 ${c.default_year}</span>` : ""}
        </div>
      </div>
      <div class="overview-risk risk-${tier.key}">
        <span class="overview-risk-value">${fmtPct(c.probability, 1)}</span>
        <span class="overview-risk-sub risk-label">${tier.label}</span>
      </div>
      <div class="company-overview-meta">${metaHtml}</div>
    `;

    document.title = `${c.corp_name} — Default Forecasting Model`;
  }

  function renderNotes(c) {
    const tier = tierInfo(c.percentile);
    let html = "";
    if (c.group === "current_screening" && (tier.key === "critical" || tier.key === "serious")) {
      html += `<div class="growth-note">⚠ 이 기업이 고위험으로 평가된 이유는 재무구조 악화일 수도, R&D 투자형
        성장기업의 특성(만성 적자, 외부자금 조달)일 수도 있습니다 - 모델은 두 경우를 구분하지 못하는 한계가
        있으니 실제 사업 현황을 함께 확인하세요.</div>`;
    }
    if (c.group === "current_screening" && !c.in_training_range) {
      html += `<div class="growth-note">⚠ 이 기업은 모델이 학습한 자산 규모 범위(100억~3,000억)를 벗어나
        있어 예측 신뢰도가 상대적으로 낮습니다(외삽).</div>`;
    }
    if (c.group === "current_screening" && c.default_year) {
      html += `<div class="growth-note">⚠ 이 기업은 공시 기준 <strong>${c.default_year}년 회생/워크아웃 등 부도
        이력</strong>이 이미 확인된 회사입니다. 위 확률은 그 이후(2025년) 재무제표를 기준으로 다시 계산한
        예측값입니다 - 회생절차가 종결되고 재무구조가 정상화됐다면 낮게, 여전히 부실 상태라면 높게 나옵니다.
        이 회사는 "새로 위험을 예측"하는 대상이 아니라 "과거 이력을 반영한 현재 상태 확인" 대상으로
        해석하세요.</div>`;
    }
    document.getElementById("notesArea").innerHTML = html;
  }

  function directionNote(def) {
    if (def.higher_is_riskier === true) return "값이 높을수록 위험 신호";
    if (def.higher_is_riskier === false) return "값이 낮을수록 위험 신호";
    return "방향성 없음(규모 등 참고용 지표)";
  }

  function renderIndicators(c) {
    const html = FEATURES_BY_IMPORTANCE.map((key) => {
      const def = META.feature_defs[key];
      const rank = IMPORTANCE_RANK[key];
      return `
        <details class="indicator-item">
          <summary class="indicator-item-summary">
            <span class="indicator-item-label">
              <span>${def.label_kr}</span>
              <span class="indicator-rank-badge">#${rank} 중요도</span>
            </span>
            <span class="indicator-item-value">${fmtIndicator(key, c.indicators[key])}</span>
          </summary>
          <div class="indicator-desc">${def.description} · ${directionNote(def)}</div>
        </details>`;
    }).join("");
    document.getElementById("indicatorGrid").innerHTML = html;
  }

  // ---------------- 수익성·성장성 지표 확장(2026-08-20) ----------------
  // 영업이익률_T1/ROA_T1/ROA_T2/ROE/매출액증가율은 이미 모델 변수라
  // c.indicators에서 그대로 재사용. EBITDA마진/영업이익 3년 CAGR/매출액
  // 3년 CAGR만 compute_profitability_extra.py가 만든 별도 JSON(모델
  // 미사용, 화면 표시 전용)에서 가져온다.

  const PROFITABILITY_BASE_KEYS = ["영업이익률_T1", "ROA_T1", "ROA_T2", "ROE", "매출액증가율"];

  const EXTRA_FLAG_LABELS = {
    "D&A_데이터없음": "감가상각비 데이터 없음",
    "매출액_결측또는0": "매출액 데이터 없음",
    "영업이익_결측": "영업이익 데이터 없음",
    "T1또는T3_결측": "3개년치 데이터 부족",
    "T1_비영리": "최근연도 영업적자로 CAGR 계산 불가",
    "T3_비영리": "3년전 영업적자로 CAGR 계산 불가",
    "T1_매출없음": "최근연도 매출액 데이터 없음",
    "T3_매출없음": "3년전 매출액 데이터 없음",
    "원자료없음": "재무 원자료를 찾을 수 없음",
  };

  function renderProfitabilityExtra(c) {
    const extra = PROFITABILITY_EXTRA[c.corp_code + "::" + c.group];

    const baseItems = PROFITABILITY_BASE_KEYS.map((key) => {
      const def = META.feature_defs[key];
      return `
        <details class="indicator-item">
          <summary class="indicator-item-summary">
            <span class="indicator-item-label"><span>${def.label_kr}</span></span>
            <span class="indicator-item-value">${fmtIndicator(key, c.indicators[key])}</span>
          </summary>
          <div class="indicator-desc">${def.description} · ${directionNote(def)}</div>
        </details>`;
    });

    const ebitda = extra && extra.ebitda_margin;
    const ebitdaValue = ebitda && ebitda.value !== null ? fmtPct(ebitda.value, 1) : "N/A";
    const ebitdaDesc = ebitda && ebitda.flag
      ? `계산 불가: ${EXTRA_FLAG_LABELS[ebitda.flag] || ebitda.flag}`
      : "EBITDA마진 = (영업이익 + 감가상각비 + 무형자산상각비 등 상각비 합계) / 매출액 · 값이 낮을수록 위험 신호";

    const oiCagr = extra && extra.op_income_cagr_3y;
    const oiCagrYears = oiCagr && oiCagr.years ? `${oiCagr.years[0]}→${oiCagr.years[1]}` : "";
    const oiCagrValue = oiCagr && oiCagr.value !== null ? fmtPct(oiCagr.value, 1) : "N/A";
    const oiCagrDesc = oiCagr && oiCagr.flag
      ? `계산 불가: ${EXTRA_FLAG_LABELS[oiCagr.flag] || oiCagr.flag}`
      : `영업이익 3년 CAGR = (영업이익_최근연도 / 영업이익_3년전)^(1/2) - 1 (${oiCagrYears}) · 값이 낮을수록 위험 신호`;

    const revCagr = extra && extra.revenue_cagr_3y;
    const revCagrYears = revCagr && revCagr.years ? `${revCagr.years[0]}→${revCagr.years[1]}` : "";
    const revCagrValue = revCagr && revCagr.value !== null ? fmtPct(revCagr.value, 1) : "N/A";
    const revCagrDesc = revCagr && revCagr.flag
      ? `계산 불가: ${EXTRA_FLAG_LABELS[revCagr.flag] || revCagr.flag}`
      : `매출액 3년 CAGR = (매출액_최근연도 / 매출액_3년전)^(1/2) - 1 (${revCagrYears}) · 값이 낮을수록 위험 신호`;

    const extraItems = [
      { label: "EBITDA마진", value: ebitdaValue, desc: ebitdaDesc },
      { label: "영업이익 3년 CAGR", value: oiCagrValue, desc: oiCagrDesc },
      { label: "매출액 3년 CAGR", value: revCagrValue, desc: revCagrDesc },
    ].map((item) => `
      <details class="indicator-item">
        <summary class="indicator-item-summary">
          <span class="indicator-item-label"><span>${item.label}<span class="badge-note">모델 미사용 · 참고용</span></span></span>
          <span class="indicator-item-value">${item.value}</span>
        </summary>
        <div class="indicator-desc">${item.desc}</div>
      </details>`);

    document.getElementById("profitabilityExtraGrid").innerHTML = baseItems.concat(extraItems).join("");
  }

  // ---------------- 부도확률 3개년 추이(2026-08-20, current_screening만) ----------------
  // 같은 배포모델(전체 데이터로 100% 학습)로 2023/2024/2025년 재무스냅샷을 각각
  // 채점한 결과 - 연도별로 모델을 다시 학습하지 않아 "회사가 실제로 변한 것"만
  // 반영된다. default(과거부도 참고) 그룹은 스코프 밖(섹션 자체를 숨김).

  function renderProbabilityHistory(c) {
    const section = document.getElementById("probabilityHistorySection");
    if (c.group !== "current_screening") {
      section.hidden = true;
      return;
    }
    section.hidden = false;

    const entry = PROB_HISTORY[c.corp_code + "::" + c.group];
    const note = document.getElementById("probHistoryNote");
    const container = document.getElementById("probHistoryBlock");

    const points = entry ? entry.points.slice().reverse() : []; // 과거->최신 순
    const usable = points.filter((p) => p.probability !== null);

    if (!entry || usable.length < 2) {
      note.textContent = "";
      container.innerHTML = '<p class="statement-empty">3개년 중 비교 가능한 데이터가 2개 미만이라 추세를 표시할 수 없습니다.</p>';
      return;
    }

    note.textContent = `같은 배포모델로 ${points.map((p) => p.year).join("/")}년 재무제표를 각각 채점한 결과입니다 · ` +
      "회사의 실제 변화만 반영되도록 연도별로 모델을 다시 학습하지 않았습니다";

    // padTop: 점 위 확률값 라벨용 여백 / padBottom: 점 아래 연도 라벨용 여백
    const width = 240, height = 92, padX = 14, padTop = 22, padBottom = 20;
    const probs = usable.map((p) => p.probability);
    const maxP = Math.max(...probs) * 1.15 || 0.05;
    const stepX = points.length > 1 ? (width - padX * 2) / (points.length - 1) : 0;

    const xAt = (i) => padX + stepX * i;
    const yAt = (p) => height - padBottom - (p / maxP) * (height - padTop - padBottom);

    const tier = tierInfo(c.percentile); // 상단 위험뱃지와 동일한 등급 색상 사용

    const segments = [];
    let current = [];
    points.forEach((p, i) => {
      if (p.probability === null) {
        if (current.length > 1) segments.push(current);
        current = [];
        return;
      }
      current.push([xAt(i), yAt(p.probability)]);
    });
    if (current.length > 1) segments.push(current);

    const pathsHtml = segments.map((seg) =>
      `<polyline points="${seg.map((pt) => pt.join(",")).join(" ")}" fill="none" stroke="var(--status-${tier.key})" stroke-width="2"/>`
    ).join("");

    const dotsHtml = points.map((p, i) => p.probability === null
      ? `<text x="${xAt(i)}" y="${height / 2}" text-anchor="middle" class="prob-history-point-label">N/A</text>`
      : `<circle cx="${xAt(i)}" cy="${yAt(p.probability)}" r="3" fill="var(--status-${tier.key})"/>`
    ).join("");

    // 꺾이는 점 위에 연도별 확률값 표기(사용자 요청, 2026-08-20)
    const valueLabelsHtml = points.map((p, i) => p.probability === null ? "" :
      `<text x="${xAt(i)}" y="${yAt(p.probability) - 7}" text-anchor="middle" class="prob-history-value-label">${fmtPct(p.probability, 1)}</text>`
    ).join("");

    const labelsHtml = points.map((p, i) =>
      `<text x="${xAt(i)}" y="${height - 6}" text-anchor="middle" class="prob-history-point-label">${p.year}</text>`
    ).join("");

    const svg = `
      <svg class="prob-history-svg" viewBox="0 0 ${width} ${height}" role="img" aria-label="부도확률 3개년 추이">
        ${pathsHtml}
        ${dotsHtml}
        ${valueLabelsHtml}
        ${labelsHtml}
      </svg>`;

    const stats = entry.stats;
    const statsHtml = stats
      ? `<div class="prob-history-stats">
          <span>최소 <strong>${fmtPct(stats.min, 1)}</strong></span>
          <span>최대 <strong>${fmtPct(stats.max, 1)}</strong></span>
          <span>변동폭 <strong>${fmtPct(stats.range, 1)}p</strong></span>
        </div>`
      : "";

    container.innerHTML = `<div class="prob-history-wrap">${svg}${statsHtml}</div>`;
  }

  function escapeHtml(s) {
    const div = document.createElement("div");
    div.textContent = s == null ? "" : String(s);
    return div.innerHTML;
  }

  const SENTIMENT_LABELS = { positive: "긍정", neutral: "중립", negative: "부정" };

  function renderNews(c) {
    const entry = NEWS[c.corp_code + "::" + c.group];
    const note = document.getElementById("newsNote");
    const summaryEl = document.getElementById("newsSentimentSummary");
    const container = document.getElementById("newsBlock");
    const articles = entry && entry.articles ? entry.articles : [];

    if (articles.length === 0) {
      note.textContent = "";
      summaryEl.innerHTML = "";
      container.innerHTML = '<p class="statement-empty">최근 1년 내 관련 뉴스를 찾지 못했습니다(뉴스가 없거나, 회사명이 흔해 정밀 매칭 기준을 통과한 기사가 없을 수 있습니다).</p>';
      return;
    }

    note.textContent = `네이버 뉴스 검색 기준(제목/본문에 회사명이 포함된 기사만) · ${entry.updated_at} 갱신 · 관련도(위험 키워드·주요 언론사) 우선 정렬 ${articles.length}건`;

    const withSentiment = articles.filter((a) => a.sentiment);
    if (withSentiment.length > 0) {
      const counts = { negative: 0, neutral: 0, positive: 0 };
      withSentiment.forEach((a) => { counts[a.sentiment.label] = (counts[a.sentiment.label] || 0) + 1; });
      summaryEl.innerHTML = `<span class="news-sentiment-summary-label">감성분석(KR-FinBERT, 주요기사 ${withSentiment.length}건 기준)</span>
        <span class="sentiment-badge sentiment-negative">부정 ${counts.negative}</span>
        <span class="sentiment-badge sentiment-neutral">중립 ${counts.neutral}</span>
        <span class="sentiment-badge sentiment-positive">긍정 ${counts.positive}</span>`;
    } else {
      summaryEl.innerHTML = "";
    }

    container.innerHTML = `
      <ul class="news-list">
        ${articles.map((a) => `
          <li class="news-item">
            ${a.score >= 3 ? '<span class="news-relevance-badge" title="위험 관련 키워드 또는 주요 언론사 기사">주요</span>' : ""}
            ${a.sentiment ? `<span class="sentiment-badge sentiment-${a.sentiment.label}" title="KR-FinBERT 감성분석(제목+설명 기준) · 신뢰도 ${(a.sentiment.confidence * 100).toFixed(0)}%">${SENTIMENT_LABELS[a.sentiment.label] || a.sentiment.label}</span>` : ""}
            <a href="${escapeHtml(a.link)}" target="_blank" rel="noopener noreferrer">${escapeHtml(a.title)}</a>
            <div class="news-meta">
              <span class="news-date">${escapeHtml(a.pub_date)}</span>
              ${a.source ? `<span class="news-source">${escapeHtml(a.source)}</span>` : ""}
            </div>
          </li>`).join("")}
      </ul>`;
  }

  function nl2br(text) {
    return text.split("\n").map((line) => line.trim()).filter(Boolean).map(escapeHtml).join("<br>");
  }

  function renderAuditMatters(o) {
    if (!o.matters || o.matters.length === 0) return "";
    const items = o.matters.map((m, i) => {
      let html = "";
      if (m.core_audit_matter) {
        html += `<div class="matter-block"><div class="matter-label">핵심감사사항</div><p>${nl2br(m.core_audit_matter)}</p></div>`;
      }
      if (m.emphasis_matter) {
        html += `<div class="matter-block"><div class="matter-label">강조사항 등${o.opinion_rank >= 1 ? " (의견 근거 서술 포함 가능)" : ""}</div><p>${nl2br(m.emphasis_matter)}</p></div>`;
      }
      if (m.special_note) {
        html += `<div class="matter-block"><div class="matter-label">감사보고서 특기사항</div><p>${nl2br(m.special_note)}</p></div>`;
      }
      return html ? `<div class="matter-item">${o.matters.length > 1 ? `<div class="matter-item-idx">항목 ${i + 1}</div>` : ""}${html}</div>` : "";
    }).join("");
    if (!items) return "";
    return `
      <details class="matter-details">
        <summary>${o.year}년 핵심감사사항·강조사항 상세 (${o.matters.length}건)</summary>
        <div class="matter-details-body">${items}</div>
      </details>`;
  }

  function renderAuditHistory(c) {
    const hist = AUDIT_HISTORY[c.corp_code + "::" + c.group];
    const note = document.getElementById("auditNote");
    const container = document.getElementById("auditHistoryBlock");

    if (!hist || !hist.years || hist.years.length === 0) {
      note.textContent = "";
      container.innerHTML = '<p class="statement-empty">감사의견 이력을 찾을 수 없습니다.</p>';
      return;
    }

    note.textContent = `DART "회계감사인의 명칭 및 감사의견" 공시 기준 · ${hist.years[0]}년 기준 최근 ${hist.years.length}개년 · "강조사항 등"은 DART 원문 필드명 그대로이며, 의견거절/한정 의견의 경우 실질적 근거 서술이 이 필드에 담기는 경우가 많습니다(항상 그런 것은 아님)`;

    const rows = hist.opinions.map((o) => {
      const opinionCell = o.opinion
        ? `<span class="opinion-badge opinion-${o.opinion}">${o.opinion}</span>`
        : '<span class="na">N/A</span>';
      return `
        <tr>
          <td class="year-cell">${o.year}</td>
          <td>${opinionCell}</td>
          <td>${o.auditor ? escapeHtml(o.auditor) : '<span class="na">N/A</span>'}</td>
        </tr>`;
    }).join("");

    const mattersHtml = hist.opinions.map(renderAuditMatters).filter(Boolean).join("");

    container.innerHTML = `
      <table class="audit-history-table">
        <thead><tr><th>연도</th><th>감사의견</th><th>외부감사인</th></tr></thead>
        <tbody>${rows}</tbody>
      </table>
      ${mattersHtml ? `<div class="matter-details-list">${mattersHtml}</div>` : ""}`;
  }

  // 요약계정(level 0) 주변의 상세 라인아이템(level 1/2)을 묶어 "그룹"으로
  // 만든다. BS/IS는 [상세...] 다음에 [합계]가 오는 구조라서(예: 유동자산/
  // 비유동자산 상세 -> 자산총계) 뒤따라오는 level-0 행이 그 앞의 상세행들을
  // "소유"한다. 맨 끝에 합계 없이 남는 상세행은 묶을 곳이 없어 header 없는
  // 그룹(항상 노출)으로 처리.
  // CF는 반대 구조다 - "영업활동현금흐름" 소계가 먼저 나오고 그 세부내역
  // (이자지급/법인세납부 등)이 다음 소계 전까지 뒤이어 나온다(2026-08-21
  // 실측 확인: 기존 "뒤따라오는 합계가 소유" 방식을 CF에 그대로 적용하면
  // 영업활동 세부내역이 투자활동현금흐름 그룹으로, 투자활동 세부내역이
  // 재무활동현금흐름 그룹으로 한 칸씩 밀려 들어가는 오류가 있었음) - 그래서
  // CF만 "이 소계가 다음 소계 전까지의 항목을 소유"하는 방식으로 그룹화한다.
  function buildStatementGroups(stmtKey, lines) {
    if (stmtKey === "CF") {
      const groups = [];
      let current = { header: null, children: [] };
      lines.forEach((line) => {
        if (accountLevel(stmtKey, line.name) === 0) {
          if (current.header || current.children.length > 0) groups.push(current);
          current = { header: line, children: [] };
        } else {
          current.children.push(line);
        }
      });
      if (current.header || current.children.length > 0) groups.push(current);
      return groups;
    }
    const groups = [];
    let pending = [];
    lines.forEach((line) => {
      if (accountLevel(stmtKey, line.name) === 0) {
        groups.push({ header: line, children: pending });
        pending = [];
      } else {
        pending.push(line);
      }
    });
    if (pending.length > 0) groups.push({ header: null, children: pending });
    return groups;
  }

  function renderAmountCells(values) {
    return values.map((v) => `<td>${v === null ? '<span class="na">N/A</span>' : fmtAmount(v)}</td>`).join("");
  }

  function renderStatementTable(stmtKey, lines, years) {
    const headerCols = years.map((y) => `<th>${y}</th>`).join("");

    // 손익계산서는 사용자 요청(2026-08-21)으로 접기/펼치기 없이 전 계정을
    // 항상 노출한다 - 매출총이익 아래 매출원가가 접혀 들어가는 등, 총계보다
    // 먼저 나와야 할 항목이 그 총계의 "숨겨진 하위 항목"처럼 보이는 게
    // 오히려 어색하다는 피드백. 레벨별 굵기/들여쓰기 구분만 유지.
    if (stmtKey === "IS") {
      const flatRows = lines.map((line) => `
        <tr class="level-${accountLevel(stmtKey, line.name)}">
          <td>${escapeHtml(line.name)}</td>
          ${renderAmountCells(line.values)}
        </tr>`).join("");
      return `
        <table class="statement-table" data-stmt="${stmtKey}">
          <thead><tr><th>계정과목</th>${headerCols}</tr></thead>
          <tbody>${flatRows}</tbody>
        </table>`;
    }

    const groups = buildStatementGroups(stmtKey, lines);

    const bodyHtml = groups.map((g, gi) => {
      if (!g.header) {
        return g.children.map((line) => `
          <tr class="level-${accountLevel(stmtKey, line.name)}">
            <td>${escapeHtml(line.name)}</td>
            ${renderAmountCells(line.values)}
          </tr>`).join("");
      }
      const expandable = g.children.length > 0;
      const groupId = `${stmtKey}-${gi}`;
      const headerRow = expandable
        ? `<tr class="stmt-row-header" data-group="${groupId}" role="button" tabindex="0" aria-expanded="false">
             <td><span class="stmt-toggle-icon">▸</span>${escapeHtml(g.header.name)}</td>
             ${renderAmountCells(g.header.values)}
           </tr>`
        : `<tr class="level-0">
             <td>${escapeHtml(g.header.name)}</td>
             ${renderAmountCells(g.header.values)}
           </tr>`;
      // 그룹 안에서도 소계(유동자산/매출원가 등, level-1)와 세부항목(level-2)을
      // 시각적으로 구분 - 이전엔 전부 동일한 들여쓰기/굵기로 나와 펼쳐봐도
      // 어떤 게 소계고 어떤 게 세부내역인지 구분이 안 됐음(2026-08-21 수정)
      const childRows = g.children.map((line) => {
        const lvl = accountLevel(stmtKey, line.name) === 1 ? "level-1" : "level-2";
        return `
        <tr class="stmt-row-detail ${lvl}" data-group="${groupId}" hidden>
          <td>${escapeHtml(line.name)}</td>
          ${renderAmountCells(line.values)}
        </tr>`;
      }).join("");
      return headerRow + childRows;
    }).join("");

    return `
      <table class="statement-table" data-stmt="${stmtKey}">
        <thead><tr><th>계정과목</th>${headerCols}</tr></thead>
        <tbody>${bodyHtml}</tbody>
      </table>`;
  }

  function toggleStatementGroup(container, row) {
    const groupId = row.dataset.group;
    const expanded = row.getAttribute("aria-expanded") === "true";
    container.querySelectorAll(`.stmt-row-detail[data-group="${groupId}"]`).forEach((tr) => {
      tr.hidden = expanded;
    });
    row.setAttribute("aria-expanded", String(!expanded));
    row.querySelector(".stmt-toggle-icon").textContent = expanded ? "▸" : "▾";
  }

  function renderStatements(c) {
    const fin = FINANCIALS[c.corp_code + "::" + c.group];
    const note = document.getElementById("financialsNote");
    const container = document.getElementById("statementBlocks");

    if (!fin) {
      note.textContent = "";
      container.innerHTML = '<p class="statement-empty">이 회사의 재무제표 원본 데이터를 찾을 수 없습니다.</p>';
      return;
    }

    note.textContent = `기준: ${fin.years.join(", ")} (단위: 억원, 실제 신고된 계정과목 원본) · ` +
      "손익계산서는 전 계정을 항상 표시 · 재무상태표·현금흐름표는 자산총계 등 요약 계정을 클릭하면 상세 내역이 펼쳐집니다";

    container.innerHTML = STMT_ORDER.map(({ key, label }) => {
      const lines = orderStatementLines(key, fin.statements[key] || []);
      if (lines.length === 0) {
        return `
          <div class="statement-block">
            <div class="statement-block-header"><h3>${label}</h3></div>
            <p class="statement-empty">데이터 없음</p>
          </div>`;
      }
      return `
        <div class="statement-block">
          <div class="statement-block-header"><h3>${label}</h3></div>
          <div class="table-scroll">${renderStatementTable(key, lines, fin.years)}</div>
        </div>`;
    }).join("");

    container.querySelectorAll(".stmt-row-header").forEach((row) => {
      row.addEventListener("click", () => toggleStatementGroup(container, row));
      row.addEventListener("keydown", (e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          toggleStatementGroup(container, row);
        }
      });
    });
  }

  // ---------------- 테마 토글 (index.html과 동일 로직) ----------------

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

  // ---------------- 초기화 ----------------

  function init() {
    initTheme();
    const c = findCompany();
    if (!c) {
      document.getElementById("notFound").removeAttribute("hidden");
      return;
    }
    document.getElementById("companyContent").removeAttribute("hidden");
    renderOverview(c);
    renderNotes(c);
    renderProbabilityHistory(c);
    renderIndicators(c);
    renderProfitabilityExtra(c);
    renderAuditHistory(c);
    renderStatements(c);
    renderNews(c);
  }

  document.addEventListener("DOMContentLoaded", init);
})();
