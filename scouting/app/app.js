(() => {
  "use strict";

  const POS_LABELS = {
    ST: "Strikers",
    W: "Wingers / Wide",
    AM: "Attacking Midfielders",
    CM: "Central Midfielders",
    DM: "Defensive Midfielders",
    FB_WB: "Full-Backs / Wing-Backs",
    CB: "Centre-Backs",
    GK: "Goalkeepers",
  };

  const DEFAULT_AXES = {
    ST: ["npxg_p90", "xa_p90"],
    W: ["npxg_p90", "xa_p90"],
    AM: ["npxg_p90", "xa_p90"],
    CM: ["prog_passes_p90", "tackles_cmp_p90"],
    DM: ["prog_passes_p90", "tackles_cmp_p90"],
    FB_WB: ["xa_p90", "tackles_cmp_p90"],
    CB: ["headers_won_pct", "prog_passes_p90"],
    GK: ["xg_prevented_p90", "save_pct"],
  };

  const MAX_TABLE_ROWS = 150;
  const MAX_SCATTER_DOTS = 260;
  const SHORTLIST_KEY = "hull_fm27_moneyball_shortlist_v1";

  const state = {
    pos: "ST",
    season: null,
    seasons: [],
    meta: null,
    cache: new Map(),
    shortlist: loadShortlist(),
    sortCol: "active_score",
    sortDir: "descending",
    filtered: [],
    renderedMap: new Map(),
    activePlayer: null,
  };

  const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: "base" });

  const els = {
    clubCrest: document.getElementById("club-crest"),
    clubTitle: document.getElementById("club-title"),
    saveMeta: document.getElementById("save-meta"),
    seasonSelect: document.getElementById("f-season"),
    saveSelect: document.getElementById("f-save"),
    btnRefreshSave: document.getElementById("btn-refresh-save"),
    tablist: document.getElementById("position-tablist"),
    tabs: [...document.querySelectorAll('#position-tablist [role="tab"]')],
    search: document.getElementById("f-search"),
    minMins: document.getElementById("f-min-mins"),
    maxAge: document.getElementById("f-max-age"),
    maxVal: document.getElementById("f-max-val"),
    maxWage: document.getElementById("f-max-wage"),
    contract: document.getElementById("f-contract"),
    minRep: document.getElementById("f-min-rep"),
    role: document.getElementById("f-role"),
    benchmark: document.getElementById("f-benchmark"),
    dynamicPct: document.getElementById("f-dynamic-pct"),
    includeHull: document.getElementById("f-include-hull"),
    poolSummary: document.getElementById("pool-summary"),
    scatterX: document.getElementById("scatter-x"),
    scatterY: document.getElementById("scatter-y"),
    scatterSvg: document.getElementById("scatter-svg"),
    scatterTooltip: document.getElementById("scatter-tooltip"),
    table: document.getElementById("scouting-table"),
    tableCaption: document.getElementById("table-caption"),
    thead: document.getElementById("table-head"),
    tbody: document.getElementById("table-body"),
    sortStatus: document.getElementById("sort-status"),
    shortlistCount: document.getElementById("shortlist-count"),
    btnShortlistView: document.getElementById("btn-shortlist-view"),
    btnExportCsv: document.getElementById("btn-export-csv"),
    playerDialog: document.getElementById("player-dialog"),
    dialogName: document.getElementById("dialog-player-name"),
    dialogMeta: document.getElementById("dialog-player-meta"),
    dialogShortlistBtn: document.getElementById("dialog-shortlist-btn"),
    dialogCloseBtn: document.getElementById("dialog-close-btn"),
    dialogCompareSelect: document.getElementById("dialog-compare-select"),
    radarSvg: document.getElementById("radar-svg"),
    radarLegend: document.getElementById("radar-legend"),
    dialogStatsList: document.getElementById("dialog-stats-list"),
    dialogProgressionWrap: document.getElementById("dialog-progression-wrap"),
    dialogProgressionList: document.getElementById("dialog-progression-list"),
    shortlistDialog: document.getElementById("shortlist-dialog"),
    shortlistBody: document.getElementById("shortlist-body"),
    shortlistCloseBtn: document.getElementById("shortlist-close-btn"),
    btnExportShortlist: document.getElementById("btn-export-shortlist"),
    btnClearShortlist: document.getElementById("btn-clear-shortlist"),
  };

  function loadShortlist() {
    try {
      const raw = localStorage.getItem(SHORTLIST_KEY);
      return raw ? JSON.parse(raw) : {};
    } catch {
      return {};
    }
  }

  function saveShortlist() {
    try {
      localStorage.setItem(SHORTLIST_KEY, JSON.stringify(state.shortlist));
    } catch {
      // Ignore storage quota errors
    }
    els.shortlistCount.textContent = String(Object.keys(state.shortlist).length);
  }

  function formatMoney(val) {
    if (val === null || val === undefined || val === "") return "—";
    const num = Number(val);
    if (!Number.isFinite(num)) return "—";
    if (num >= 1_000_000) return `£${(num / 1_000_000).toFixed(1)}M`;
    if (num >= 1_000) return `£${Math.round(num / 1_000)}k`;
    return `£${num}`;
  }

  function formatStat(key, val) {
    if (val === null || val === undefined) return "—";
    const num = Number(val);
    if (!Number.isFinite(num)) return "—";
    if (key.endsWith("_pct")) return `${num.toFixed(1)}%`;
    if (key === "avg_rating") return num.toFixed(2);
    return num.toFixed(2);
  }

  function pctClass(pct) {
    if (pct >= 85) return "pct-elite";
    if (pct >= 65) return "pct-good";
    if (pct >= 35) return "pct-mid";
    return "pct-low";
  }

  function escapeHtml(str) {
    return String(str)
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;")
      .replaceAll('"', "&quot;");
  }

  function enableLightDismissFallback(dialog) {
    if ("closedBy" in HTMLDialogElement.prototype) return;
    dialog.addEventListener("click", (event) => {
      if (event.target !== dialog) return;
      const rect = dialog.getBoundingClientRect();
      const inside =
        rect.top <= event.clientY &&
        event.clientY <= rect.top + rect.height &&
        rect.left <= event.clientX &&
        event.clientX <= rect.left + rect.width;
      if (!inside) dialog.close();
    });
  }

  function activeDataset() {
    return state.cache.get(`${state.season || "latest"}:${state.pos}`);
  }

  async function loadPosition(pos, season = state.season) {
    const key = `${season || "latest"}:${pos}`;
    if (state.cache.has(key)) return state.cache.get(key);
    const url = season ? `/seasons/${encodeURIComponent(season)}/data/${pos}.json` : `data/${pos}.json`;
    const res = await fetch(url);
    if (!res.ok) throw new Error(`Failed loading ${url}`);
    const data = await res.json();
    state.cache.set(key, data);
    return data;
  }

  async function loadMeta(season = state.season) {
    const url = season ? `/seasons/${encodeURIComponent(season)}/data/meta.json` : "data/meta.json";
    const res = await fetch(url);
    if (!res.ok) throw new Error(`Failed loading ${url}`);
    state.meta = await res.json();
    const clubName = state.meta.club_name || "Moneyball Scout";
    const shortName = state.meta.club_short_name || clubName;
    const initials = shortName
      .split(/\s+/)
      .slice(0, 2)
      .map((w) => w[0]?.toUpperCase() || "")
      .join("") || "FM";
    els.clubCrest.textContent = initials;
    els.clubTitle.textContent = `${clubName} — Moneyball Scout`;
    const seasonLabel = state.meta.season ? `Season ${state.meta.season} · ` : "";
    els.saveMeta.textContent = `FM27 · ${seasonLabel}${state.meta.in_game_date || ""} · ${state.meta.save_file || ""} · Stats-Only`;
  }

  function populatePositionControls(dataset) {
    const prevRole = els.role.value;
    const roleEntries = Object.entries(dataset.roles);
    els.role.innerHTML = [
      `<option value="overall">Overall Moneyball Score</option>`,
      ...roleEntries.map(([slug, info]) => `<option value="${slug}">${escapeHtml(info.label)}</option>`),
    ].join("");
    if ([...els.role.options].some((o) => o.value === prevRole)) {
      els.role.value = prevRole;
    }

    const metricOpts = dataset.metrics
      .map((m) => `<option value="${m.key}">${escapeHtml(m.label)}</option>`)
      .join("");
    els.scatterX.innerHTML = metricOpts;
    els.scatterY.innerHTML = metricOpts;
    const [defX, defY] = DEFAULT_AXES[dataset.position] || [dataset.metrics[0].key, dataset.metrics[1].key];
    els.scatterX.value = defX;
    els.scatterY.value = defY;

    const hullInPos = dataset.players.filter((p) => p.is_hull);
    const hullFallback = (state.meta?.hull_squad || []).filter((p) => !hullInPos.some((h) => h.uid === p.uid));
    const clubTag = state.meta?.club_short_name || "CLUB";
    const benchOptions = [
      `<option value="">None</option>`,
      ...hullInPos.map((p) => `<option value="${p.uid}">[${escapeHtml(clubTag)} ${dataset.position}] ${escapeHtml(p.name)} (${p.minutes}m)</option>`),
      ...hullFallback.map((p) => `<option value="${p.uid}">[${escapeHtml(clubTag)}] ${escapeHtml(p.name)} (${p.positions})</option>`),
    ];
    els.benchmark.innerHTML = benchOptions.join("");
    if (hullInPos.length > 0) {
      els.benchmark.value = hullInPos[0].uid;
    }
  }

  function bisectLeft(arr, target) {
    let lo = 0;
    let hi = arr.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (arr[mid] < target) lo = mid + 1;
      else hi = mid;
    }
    return lo;
  }

  function bisectRight(arr, target) {
    let lo = 0;
    let hi = arr.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (arr[mid] <= target) lo = mid + 1;
      else hi = mid;
    }
    return lo;
  }

  function computePoolRows(dataset) {
    const minMins = Number(els.minMins.value);
    const minRep = Number(els.minRep.value);
    const maxAge = Number(els.maxAge.value);
    const maxVal = Number(els.maxVal.value);
    const maxWage = Number(els.maxWage.value);
    const contractFilter = els.contract.value;
    const search = els.search.value.trim().toLowerCase();
    const roleSlug = els.role.value;
    const dynamicPct = els.dynamicPct.checked;
    const includeHull = els.includeHull.checked;

    // Peer baseline pool uses sample-size and competition-tier gates only.
    const peerPool = dataset.players.filter((p) => p.minutes >= minMins && (p.club_rep >= minRep || p.is_hull));

    let distMap = null;
    if (dynamicPct && peerPool.length >= 10) {
      distMap = new Map();
      for (const m of dataset.metrics) {
        const sorted = peerPool.map((p) => Number(p[m.key]) || 0).sort((a, b) => a - b);
        distMap.set(m.key, { sorted, higher: m.higher_is_better });
      }
    }

    const roleMetrics =
      roleSlug === "overall"
        ? dataset.metrics.map((m) => m.key)
        : dataset.roles[roleSlug]?.metrics || dataset.metrics.map((m) => m.key);

    const out = [];
    for (const p of dataset.players) {
      if (!includeHull && p.is_hull) continue;
      if (!p.is_hull && p.minutes < minMins) continue;
      if (p.is_hull && p.minutes < 300) continue;
      if (!p.is_hull && p.club_rep < minRep) continue;
      if (!p.is_hull && (p.age === null || p.age > maxAge)) continue;
      if (!p.is_hull && maxVal < 999999999 && p.value !== null && p.value > maxVal) continue;
      if (!p.is_hull && maxWage < 999999999 && p.wage !== null && p.wage > maxWage) continue;
      if (!p.is_hull && contractFilter === "2028" && !String(p.contract_end).startsWith("2028")) continue;
      if (!p.is_hull && contractFilter === "2029") {
        const yr = Number(String(p.contract_end).slice(0, 4));
        if (!yr || yr > 2029) continue;
      }
      if (search) {
        const hay = `${p.name} ${p.club} ${p.positions}`.toLowerCase();
        if (!hay.includes(search)) continue;
      }

      const activePcts = {};
      for (const m of dataset.metrics) {
        if (distMap) {
          const { sorted, higher } = distMap.get(m.key);
          const v = Number(p[m.key]) || 0;
          const mid = (bisectLeft(sorted, v) + bisectRight(sorted, v)) / 2;
          let pct = (mid / sorted.length) * 100;
          if (!higher) pct = 100 - pct;
          activePcts[m.key] = Math.max(0, Math.min(100, Math.round(pct)));
        } else {
          activePcts[m.key] = p[`pct_${m.key}`] ?? 50;
        }
      }

      const activeScore =
        Math.round((roleMetrics.reduce((acc, k) => acc + activePcts[k], 0) / roleMetrics.length) * 10) / 10;

      out.push({
        ...p,
        active_pcts: activePcts,
        active_score: activeScore,
      });
    }

    return { rows: out, peerCount: peerPool.length };
  }

  function sortRowsData(rows, col, dir) {
    const factor = dir === "ascending" ? 1 : -1;
    const textCols = new Set(["name", "club", "positions", "contract_end"]);
    const isText = textCols.has(col);
    rows.sort((a, b) => {
      if (isText) {
        return factor * collator.compare(String(a[col] ?? ""), String(b[col] ?? ""));
      }
      const va = Number(a[col] ?? -1e12);
      const vb = Number(b[col] ?? -1e12);
      return factor * (va - vb);
    });
  }

  function buildTableHead(dataset) {
    const metricCols = dataset.metrics.slice(0, 7);
    const cols = [
      { key: "name", label: "Player", type: "text", align: "left" },
      { key: "club", label: "Club", type: "text", align: "left" },
      { key: "age", label: "Age", type: "number" },
      { key: "positions", label: "Pos", type: "text", align: "left" },
      { key: "minutes", label: "Mins", type: "number" },
      { key: "value", label: "Value", type: "number" },
      { key: "wage", label: "Wage/wk", type: "number" },
      { key: "contract_end", label: "Contract", type: "text", align: "left" },
      { key: "active_score", label: "Role Score", type: "number" },
      ...metricCols.map((m) => ({ key: m.key, label: m.label, type: "number" })),
    ];

    const tr = document.createElement("tr");
    for (const c of cols) {
      const th = document.createElement("th");
      th.scope = "col";
      th.dataset.col = c.key;
      th.dataset.type = c.type;
      if (c.align === "left") th.dataset.align = "left";
      if (c.key === state.sortCol) th.setAttribute("aria-sort", state.sortDir);

      const btn = document.createElement("button");
      btn.type = "button";
      btn.setAttribute("commandfor", "scouting-table");
      btn.setAttribute("command", "--sort");
      btn.textContent = c.label;
      th.append(btn);
      tr.append(th);
    }
    els.thead.replaceChildren(tr);
  }

  function createPlayerRow(p, dataset) {
    const metricCols = dataset.metrics.slice(0, 7);
    const tr = document.createElement("tr");
    tr.dataset.uid = p.uid;
    if (p.is_hull) tr.classList.add("is-hull");

    const th = document.createElement("th");
    th.scope = "row";
    th.dataset.value = p.name;
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "player-link";
    btn.textContent = p.name;
    btn.addEventListener("click", () => openPlayerDialog(p, dataset));
    th.append(btn);
    if (p.is_hull) {
      const badge = document.createElement("span");
      badge.className = "hull-badge";
      badge.textContent = els.clubCrest.textContent || "CLUB";
      th.append(badge);
    }
    tr.append(th);

    const addCell = (text, value, align = "right", cls = "") => {
      const td = document.createElement("td");
      td.textContent = text;
      if (value !== undefined && value !== null) td.dataset.value = String(value);
      if (align === "left") td.dataset.align = "left";
      if (cls) td.className = cls;
      tr.append(td);
      return td;
    };

    addCell(p.club, p.club, "left");
    addCell(p.age ?? "—", p.age ?? -1);
    addCell(p.positions, p.positions, "left");
    addCell(String(p.minutes), p.minutes);
    addCell(formatMoney(p.value), p.value ?? 999999999);
    addCell(p.wage ? `${formatMoney(p.wage)}` : "—", p.wage ?? 999999999);
    addCell(p.contract_end || "—", p.contract_end || "9999-12-31", "left");
    addCell(p.active_score.toFixed(1), p.active_score, "right", "score-cell");

    for (const m of metricCols) {
      const td = document.createElement("td");
      const val = p[m.key];
      const pct = p.active_pcts[m.key];
      td.dataset.value = String(val ?? 0);
      td.innerHTML = `${formatStat(m.key, val)} <span class="pct-pill ${pctClass(pct)}">${pct}</span>`;
      tr.append(td);
    }

    return tr;
  }

  function renderTableRows(dataset) {
    const slice = state.filtered.slice(0, MAX_TABLE_ROWS);
    const fragment = document.createDocumentFragment();
    state.renderedMap.clear();
    for (const p of slice) {
      const row = createPlayerRow(p, dataset);
      state.renderedMap.set(p.uid, row);
      fragment.append(row);
    }
    els.tbody.replaceChildren(fragment);
    els.tableCaption.textContent = `${POS_LABELS[dataset.position]} — Showing ${slice.length} of ${state.filtered.length} matching players`;
  }

  function reorderDomRows(orderedRows) {
    if (typeof els.tbody.moveBefore === "function") {
      for (const row of orderedRows) els.tbody.moveBefore(row, null);
    } else {
      for (const row of orderedRows) els.tbody.append(row);
    }
  }

  function handleSort(th) {
    const col = th.dataset.col;
    const type = th.dataset.type || "number";
    const direction = th.getAttribute("aria-sort") === "ascending" ? "descending" : "ascending";
    for (const h of els.thead.rows[0].cells) h.removeAttribute("aria-sort");
    th.setAttribute("aria-sort", direction);

    state.sortCol = col;
    state.sortDir = direction;
    sortRowsData(state.filtered, col, direction);

    const dataset = activeDataset();
    if (state.filtered.length <= MAX_TABLE_ROWS && state.renderedMap.size === state.filtered.length) {
      const orderedDom = state.filtered.map((p) => state.renderedMap.get(p.uid)).filter(Boolean);
      reorderDomRows(orderedDom);
    } else {
      renderTableRows(dataset);
    }

    const label = th.querySelector("button")?.textContent.trim() || col;
    els.sortStatus.textContent = `Sorted by ${label}, ${direction}, ${Math.min(state.filtered.length, MAX_TABLE_ROWS)} rows shown`;
  }

  function renderScatter(dataset) {
    const xKey = els.scatterX.value;
    const yKey = els.scatterY.value;
    const xMeta = dataset.metrics.find((m) => m.key === xKey) || dataset.metrics[0];
    const yMeta = dataset.metrics.find((m) => m.key === yKey) || dataset.metrics[1];

    const hullPlayers = state.filtered.filter((p) => p.is_hull);
    const others = state.filtered.filter((p) => !p.is_hull).slice(0, MAX_SCATTER_DOTS);
    const pts = [...others, ...hullPlayers];

    const W = 860;
    const H = 320;
    const pad = { l: 58, r: 24, t: 20, b: 44 };
    const plotW = W - pad.l - pad.r;
    const plotH = H - pad.t - pad.b;

    const xVals = pts.map((p) => Number(p[xKey]) || 0);
    const yVals = pts.map((p) => Number(p[yKey]) || 0);
    const minX = xVals.length ? Math.min(...xVals) : 0;
    const maxX = xVals.length ? Math.max(...xVals) : 1;
    const minY = yVals.length ? Math.min(...yVals) : 0;
    const maxY = yVals.length ? Math.max(...yVals) : 1;
    const spanX = maxX - minX || 1;
    const spanY = maxY - minY || 1;

    const scaleX = (v) => pad.l + ((v - minX) / spanX) * plotW;
    const scaleY = (v) => pad.t + plotH - ((v - minY) / spanY) * plotH;

    const avgX = xVals.length ? xVals.reduce((a, b) => a + b, 0) / xVals.length : 0;
    const avgY = yVals.length ? yVals.reduce((a, b) => a + b, 0) / yVals.length : 0;

    const benchUid = els.benchmark.value;

    let svg = "";
    // Grid & axes
    for (let i = 0; i <= 4; i++) {
      const gx = pad.l + (plotW * i) / 4;
      const gy = pad.t + (plotH * i) / 4;
      const xv = minX + (spanX * i) / 4;
      const yv = maxY - (spanY * i) / 4;
      svg += `<line x1="${gx}" y1="${pad.t}" x2="${gx}" y2="${pad.t + plotH}" stroke="currentColor" stroke-opacity="0.12" />`;
      svg += `<line x1="${pad.l}" y1="${gy}" x2="${pad.l + plotW}" y2="${gy}" stroke="currentColor" stroke-opacity="0.12" />`;
      svg += `<text x="${gx}" y="${H - 22}" fill="currentColor" fill-opacity="0.65" font-size="10" text-anchor="middle">${formatStat(xKey, xv)}</text>`;
      svg += `<text x="${pad.l - 8}" y="${gy + 3}" fill="currentColor" fill-opacity="0.65" font-size="10" text-anchor="end">${formatStat(yKey, yv)}</text>`;
    }

    // Pool average crosshairs
    svg += `<line x1="${scaleX(avgX)}" y1="${pad.t}" x2="${scaleX(avgX)}" y2="${pad.t + plotH}" stroke="#94a3b8" stroke-dasharray="4 4" stroke-opacity="0.55" />`;
    svg += `<line x1="${pad.l}" y1="${scaleY(avgY)}" x2="${pad.l + plotW}" y2="${scaleY(avgY)}" stroke="#94a3b8" stroke-dasharray="4 4" stroke-opacity="0.55" />`;

    svg += `<text x="${pad.l + plotW / 2}" y="${H - 5}" fill="currentColor" font-size="11" font-weight="700" text-anchor="middle">${escapeHtml(xMeta.label)}</text>`;
    svg += `<text x="14" y="${pad.t + plotH / 2}" fill="currentColor" font-size="11" font-weight="700" text-anchor="middle" transform="rotate(-90 14 ${pad.t + plotH / 2})">${escapeHtml(yMeta.label)}</text>`;

    for (const p of pts) {
      const cx = scaleX(Number(p[xKey]) || 0).toFixed(1);
      const cy = scaleY(Number(p[yKey]) || 0).toFixed(1);
      const isBench = p.uid === benchUid;
      const fill = p.is_hull ? "#f59e0b" : "#38bdf8";
      const r = p.is_hull ? (isBench ? 7.5 : 6) : 4.2;
      const stroke = isBench ? "#ffffff" : p.is_hull ? "#111827" : "none";
      const opacity = p.is_hull ? "1" : "0.72";
      svg += `<circle class="scatter-dot" data-uid="${p.uid}" cx="${cx}" cy="${cy}" r="${r}" fill="${fill}" fill-opacity="${opacity}" stroke="${stroke}" stroke-width="${isBench ? 2.5 : 1.5}" style="cursor:pointer" />`;
      if (p.is_hull) {
        svg += `<text x="${Number(cx) + 8}" y="${Number(cy) + 3}" fill="#f59e0b" font-size="10.5" font-weight="700">${escapeHtml(p.name)}</text>`;
      }
    }

    els.scatterSvg.innerHTML = svg;

    const byUid = new Map(pts.map((p) => [p.uid, p]));
    els.scatterSvg.querySelectorAll(".scatter-dot").forEach((dot) => {
      const p = byUid.get(dot.dataset.uid);
      if (!p) return;
      dot.addEventListener("mouseenter", (ev) => {
        els.scatterTooltip.hidden = false;
        els.scatterTooltip.innerHTML = `<strong>${escapeHtml(p.name)}</strong> (${escapeHtml(p.club)}, Age ${p.age})<br>${escapeHtml(xMeta.label)}: ${formatStat(xKey, p[xKey])} | ${escapeHtml(yMeta.label)}: ${formatStat(yKey, p[yKey])}<br>Value: ${formatMoney(p.value)} · Score: ${p.active_score}`;
        const wrapRect = els.scatterSvg.getBoundingClientRect();
        els.scatterTooltip.style.left = `${Math.min(wrapRect.width - 210, Math.max(8, ev.clientX - wrapRect.left + 12))}px`;
        els.scatterTooltip.style.top = `${Math.max(8, ev.clientY - wrapRect.top - 42)}px`;
      });
      dot.addEventListener("mouseleave", () => {
        els.scatterTooltip.hidden = true;
      });
      dot.addEventListener("click", () => openPlayerDialog(p, dataset));
    });
  }

  function renderRadar(player, comparePlayer, dataset) {
    const metrics = dataset.metrics;
    const n = metrics.length;
    const cx = 210;
    const cy = 210;
    const maxR = 140;

    let svg = "";
    for (const ring of [20, 40, 60, 80, 100]) {
      const r = (maxR * ring) / 100;
      svg += `<circle cx="${cx}" cy="${cy}" r="${r}" fill="none" stroke="currentColor" stroke-opacity="0.16" />`;
      svg += `<text x="${cx + 4}" y="${cy - r + 10}" fill="currentColor" fill-opacity="0.55" font-size="9">${ring}</text>`;
    }

    const toXY = (idx, pct) => {
      const angle = (Math.PI * 2 * idx) / n - Math.PI / 2;
      const r = (maxR * pct) / 100;
      return [cx + Math.cos(angle) * r, cy + Math.sin(angle) * r];
    };

    for (let i = 0; i < n; i++) {
      const [lx, ly] = toXY(i, 100);
      const [tx, ty] = toXY(i, 118);
      svg += `<line x1="${cx}" y1="${cy}" x2="${lx.toFixed(1)}" y2="${ly.toFixed(1)}" stroke="currentColor" stroke-opacity="0.16" />`;
      const anchor = Math.abs(tx - cx) < 10 ? "middle" : tx > cx ? "start" : "end";
      svg += `<text x="${tx.toFixed(1)}" y="${ty.toFixed(1)}" fill="currentColor" font-size="10" font-weight="600" text-anchor="${anchor}" dominant-baseline="middle">${escapeHtml(metrics[i].label.replace(" / 90", ""))}</text>`;
    }

    if (comparePlayer) {
      const cPts = metrics
        .map((m, i) => toXY(i, comparePlayer.active_pcts?.[m.key] ?? comparePlayer[`pct_${m.key}`] ?? 50).map((v) => v.toFixed(1)).join(","))
        .join(" ");
      svg += `<polygon points="${cPts}" fill="#38bdf8" fill-opacity="0.22" stroke="#38bdf8" stroke-width="2" />`;
    }

    const pPts = metrics
      .map((m, i) => toXY(i, player.active_pcts?.[m.key] ?? player[`pct_${m.key}`] ?? 50).map((v) => v.toFixed(1)).join(","))
      .join(" ");
    svg += `<polygon points="${pPts}" fill="#f59e0b" fill-opacity="0.32" stroke="#f59e0b" stroke-width="2.5" />`;

    els.radarSvg.innerHTML = svg;
    els.radarLegend.innerHTML = `
      <span class="legend-item"><span class="swatch" style="background:#f59e0b"></span>${escapeHtml(player.name)}</span>
      ${comparePlayer ? `<span class="legend-item"><span class="swatch" style="background:#38bdf8"></span>${escapeHtml(comparePlayer.name)} (${escapeHtml(state.meta?.club_short_name || "Club")})</span>` : ""}
    `;
  }

  function openPlayerDialog(player, dataset) {
    state.activePlayer = player;
    els.dialogName.textContent = player.name;
    els.dialogMeta.textContent = `${player.club} · Age ${player.age ?? "?"} · ${player.positions} · ${player.minutes} mins · Value ${formatMoney(player.value)} · Wage ${player.wage ? formatMoney(player.wage) + "/wk" : "—"} · Contract ${player.contract_end || "—"}`;

    const isSaved = Boolean(state.shortlist[player.uid]);
    els.dialogShortlistBtn.textContent = isSaved ? "Remove Shortlist" : "Add to Shortlist";

    const hullPool = dataset.players.filter((p) => p.is_hull && p.uid !== player.uid);
    const hullOther = (state.meta?.hull_squad || []).filter((p) => p.uid !== player.uid && !hullPool.some((h) => h.uid === p.uid));
    els.dialogCompareSelect.innerHTML = [
      `<option value="">No comparison</option>`,
      ...hullPool.map((h) => `<option value="${h.uid}">${escapeHtml(h.name)} (${h.positions}, ${h.minutes}m)</option>`),
      ...hullOther.map((h) => `<option value="${h.uid}">${escapeHtml(h.name)} (${h.positions}, ${h.minutes}m)</option>`),
    ].join("");

    const benchUid = els.benchmark.value;
    if (benchUid && benchUid !== player.uid) {
      els.dialogCompareSelect.value = benchUid;
    }

    const drawCompare = () => {
      const cid = els.dialogCompareSelect.value;
      const cmp =
        hullPool.find((h) => h.uid === cid) ||
        hullOther.find((h) => h.uid === cid) ||
        null;
      renderRadar(player, cmp, dataset);
    };
    els.dialogCompareSelect.onchange = drawCompare;
    drawCompare();

    els.dialogStatsList.innerHTML = dataset.metrics
      .map((m) => {
        const pct = player.active_pcts?.[m.key] ?? player[`pct_${m.key}`] ?? 50;
        return `
          <div class="stat-row">
            <span>${escapeHtml(m.label)}</span>
            <strong>${formatStat(m.key, player[m.key])}</strong>
            <span class="pct-pill ${pctClass(pct)}">${pct}</span>
            <div class="stat-bar-wrap"><div class="stat-bar-fill" style="width:${pct}%"></div></div>
          </div>
        `;
      })
      .join("");

    renderPlayerProgression(player);
    els.playerDialog.showModal();
  }

  async function renderPlayerProgression(player) {
    if (!state.seasons || state.seasons.length < 2) {
      els.dialogProgressionWrap.hidden = true;
      return;
    }
    els.dialogProgressionWrap.hidden = false;
    els.dialogProgressionList.innerHTML = `<p class="subtitle">Loading past seasons...</p>`;

    const history = [];
    for (const entry of state.seasons) {
      try {
        const ds = await loadPosition(state.pos, entry.season);
        const match = ds.players.find((p) => p.uid === player.uid);
        if (match) history.push({ season: entry.season, row: match });
      } catch {
        // Skip unavailable season
      }
    }

    if (history.length < 2) {
      els.dialogProgressionWrap.hidden = true;
      return;
    }

    els.dialogProgressionList.innerHTML = history
      .map(
        ({ season, row }) => `
        <div class="stat-row">
          <span><strong>${escapeHtml(season)}</strong> (${escapeHtml(row.club)}) · ${row.minutes}m</span>
          <strong>Rtg ${Number(row.avg_rating || 0).toFixed(2)} · np-xG ${Number(row.npxg_p90 || 0).toFixed(2)} · xA ${Number(row.xa_p90 || 0).toFixed(2)}</strong>
          <span class="pct-pill ${pctClass(Math.round(row.score_overall || 50))}">${Number(row.score_overall || 0).toFixed(1)}</span>
        </div>
      `
      )
      .join("");
  }

  function downloadCsv(rows, filename, dataset) {
    if (!rows.length) return;
    const cols = [
      "name",
      "club",
      "age",
      "positions",
      "minutes",
      "apps",
      "value",
      "wage",
      "contract_end",
      "avg_rating",
      "active_score",
      ...dataset.metrics.map((m) => m.key),
    ];
    const escapeCsv = (v) => {
      const s = String(v ?? "");
      return s.includes(",") || s.includes('"') ? `"${s.replaceAll('"', '""')}"` : s;
    };
    const lines = [
      cols.join(","),
      ...rows.map((r) => cols.map((c) => escapeCsv(r[c])).join(",")),
    ];
    const blob = new Blob([lines.join("\n")], { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    a.click();
    URL.revokeObjectURL(url);
  }

  function renderShortlistModal() {
    const items = Object.values(state.shortlist);
    if (!items.length) {
      els.shortlistBody.innerHTML = `<p class="subtitle">No players shortlisted yet. Click any player name to add them.</p>`;
    } else {
      els.shortlistBody.innerHTML = items
        .map(
          (p) => `
          <div class="shortlist-item">
            <div>
              <strong>${escapeHtml(p.name)}</strong> · ${escapeHtml(p.club)} · Age ${p.age ?? "?"} · ${escapeHtml(p.positions)}
              <div class="subtitle">Mins ${p.minutes} · Value ${formatMoney(p.value)} · Wage ${p.wage ? formatMoney(p.wage) + "/wk" : "—"} · Contract ${p.contract_end || "—"}</div>
            </div>
            <button type="button" class="btn secondary remove-shortlist-btn" data-uid="${p.uid}">Remove</button>
          </div>
        `
        )
        .join("");
      els.shortlistBody.querySelectorAll(".remove-shortlist-btn").forEach((btn) => {
        btn.addEventListener("click", () => {
          delete state.shortlist[btn.dataset.uid];
          saveShortlist();
          renderShortlistModal();
        });
      });
    }
    els.shortlistDialog.showModal();
  }

  function refreshView() {
    const dataset = activeDataset();
    if (!dataset) return;
    const { rows, peerCount } = computePoolRows(dataset);
    sortRowsData(rows, state.sortCol, state.sortDir);
    state.filtered = rows;

    const pctMode = els.dynamicPct.checked
      ? `Dynamic percentiles vs ${peerCount.toLocaleString()} peers (mins ≥ ${els.minMins.value}, rep ≥ ${els.minRep.value})`
      : `Global ≥900m percentiles`;
    const clubLabel = state.meta?.club_short_name || "Managed Club";
    els.poolSummary.textContent = `${rows.length.toLocaleString()} targets matched · ${pctMode} · ${clubLabel} highlighted in amber`;

    renderScatter(dataset);
    renderTableRows(dataset);
  }

  async function selectPosition(pos, focusTab = false) {
    state.pos = pos;
    for (const tab of els.tabs) {
      const selected = tab.dataset.pos === pos;
      tab.setAttribute("aria-selected", String(selected));
      tab.tabIndex = selected ? 0 : -1;
      if (selected) {
        tab.scrollIntoView({ block: "nearest", inline: "nearest" });
        if (focusTab) tab.focus();
      }
    }
    const dataset = await loadPosition(pos);
    populatePositionControls(dataset);
    state.sortCol = "active_score";
    state.sortDir = "descending";
    buildTableHead(dataset);
    refreshView();
  }

  function wireEvents() {
    els.tablist.addEventListener("click", (ev) => {
      const tab = ev.target.closest('[role="tab"]');
      if (tab) selectPosition(tab.dataset.pos);
    });

    els.tablist.addEventListener("keydown", (ev) => {
      const idx = els.tabs.findIndex((t) => t.dataset.pos === state.pos);
      let next = idx;
      if (ev.key === "ArrowRight") next = (idx + 1) % els.tabs.length;
      else if (ev.key === "ArrowLeft") next = (idx - 1 + els.tabs.length) % els.tabs.length;
      else if (ev.key === "Home") next = 0;
      else if (ev.key === "End") next = els.tabs.length - 1;
      else return;
      ev.preventDefault();
      selectPosition(els.tabs[next].dataset.pos, true);
    });

    [
      els.search,
      els.minMins,
      els.maxAge,
      els.maxVal,
      els.maxWage,
      els.contract,
      els.minRep,
      els.role,
      els.benchmark,
      els.dynamicPct,
      els.includeHull,
    ].forEach((el) => {
      el.addEventListener("input", refreshView);
      el.addEventListener("change", refreshView);
    });

    [els.scatterX, els.scatterY].forEach((el) => {
      el.addEventListener("change", () => {
        const dataset = activeDataset();
        if (dataset) renderScatter(dataset);
      });
    });

    // Invoker command + fallback click listener per sortable-table guide
    els.table.addEventListener("command", (event) => {
      if (event.command !== "--sort") return;
      const th = event.source.closest("th");
      if (th) handleSort(th);
    });
    if (!("commandForElement" in HTMLButtonElement.prototype)) {
      els.thead.addEventListener("click", (event) => {
        const btn = event.target.closest('button[command="--sort"]');
        if (btn) handleSort(btn.closest("th"));
      });
    }

    enableLightDismissFallback(els.playerDialog);
    enableLightDismissFallback(els.shortlistDialog);
    els.dialogCloseBtn.addEventListener("click", () => els.playerDialog.close());
    els.shortlistCloseBtn.addEventListener("click", () => els.shortlistDialog.close());

    els.dialogShortlistBtn.addEventListener("click", () => {
      const p = state.activePlayer;
      if (!p) return;
      if (state.shortlist[p.uid]) {
        delete state.shortlist[p.uid];
        els.dialogShortlistBtn.textContent = "Add to Shortlist";
      } else {
        state.shortlist[p.uid] = {
          uid: p.uid,
          name: p.name,
          club: p.club,
          age: p.age,
          positions: p.positions,
          minutes: p.minutes,
          value: p.value,
          wage: p.wage,
          contract_end: p.contract_end,
          pos_group: state.pos,
        };
        els.dialogShortlistBtn.textContent = "Remove Shortlist";
      }
      saveShortlist();
    });

    els.seasonSelect.addEventListener("change", async () => {
      state.season = els.seasonSelect.value || null;
      await loadMeta(state.season);
      await selectPosition(state.pos);
    });

    els.btnRefreshSave.addEventListener("click", () => {
      refreshFromSave(els.saveSelect.value || null);
    });

    els.btnShortlistView.addEventListener("click", renderShortlistModal);
    els.btnClearShortlist.addEventListener("click", () => {
      state.shortlist = {};
      saveShortlist();
      renderShortlistModal();
    });
    els.btnExportCsv.addEventListener("click", () => {
      const dataset = activeDataset();
      if (dataset) downloadCsv(state.filtered, `moneyball_scout_${state.pos}.csv`, dataset);
    });
    els.btnExportShortlist.addEventListener("click", () => {
      const items = Object.values(state.shortlist);
      if (!items.length) return;
      const cols = ["name", "club", "age", "positions", "pos_group", "minutes", "value", "wage", "contract_end"];
      const lines = [cols.join(","), ...items.map((r) => cols.map((c) => `"${String(r[c] ?? "").replaceAll('"', '""')}"`).join(","))];
      const blob = new Blob([lines.join("\n")], { type: "text/csv;charset=utf-8" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = "moneyball_shortlist.csv";
      a.click();
      URL.revokeObjectURL(url);
    });
  }

  function renderServerControls(status) {
    state.seasons = status.seasons || [];
    if (state.seasons.length) {
      els.seasonSelect.innerHTML = state.seasons
        .map(
          (s) =>
            `<option value="${escapeHtml(s.season)}">${escapeHtml(s.season)} (${escapeHtml(s.in_game_date || "")})</option>`
        )
        .join("");
      if (!state.season || !state.seasons.some((s) => s.season === state.season)) {
        state.season = status.latest_season || state.seasons[0].season;
      }
      els.seasonSelect.value = state.season;
    }

    const saves = status.saves || [];
    if (saves.length) {
      const prevSave = els.saveSelect.value;
      els.saveSelect.innerHTML = saves
        .map(
          (s) =>
            `<option value="${escapeHtml(s.path)}">${escapeHtml(s.name)} (${escapeHtml(s.modified)})</option>`
        )
        .join("");
      if (prevSave && saves.some((s) => s.path === prevSave)) {
        els.saveSelect.value = prevSave;
      }
    } else {
      els.saveSelect.innerHTML = `<option value="">No .fm saves found</option>`;
    }
  }

  async function refreshFromSave(savePath = null) {
    els.btnRefreshSave.disabled = true;
    const origText = els.btnRefreshSave.textContent;
    els.btnRefreshSave.textContent = "Reading .fm save...";
    els.poolSummary.textContent = "Reading current FM27 save and updating season archive...";
    try {
      const res = await fetch("/api/refresh", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ save_path: savePath }),
      });
      const data = await res.json();
      if (!res.ok || data.error) {
        throw new Error(data.error || `HTTP ${res.status}`);
      }
      state.cache.clear();
      state.season = data.latest_season || state.season;
      renderServerControls(data);
      await loadMeta(state.season);
      await selectPosition(state.pos);
    } catch (err) {
      els.poolSummary.textContent = `Save refresh failed: ${err.message}`;
    } finally {
      els.btnRefreshSave.disabled = false;
      els.btnRefreshSave.textContent = origText;
    }
  }

  async function init() {
    saveShortlist();
    wireEvents();

    let serverStatus = null;
    try {
      const statusRes = await fetch("/api/status");
      if (statusRes.ok) serverStatus = await statusRes.json();
    } catch {
      // Static fallback without server API
    }

    if (serverStatus) {
      renderServerControls(serverStatus);
    }

    const params = new URLSearchParams(window.location.search);
    const shouldAutoRefresh = params.get("auto_refresh") === "1" && serverStatus?.newest_save_stale;

    await loadMeta(state.season);
    await selectPosition("ST");

    if (shouldAutoRefresh) {
      await refreshFromSave(serverStatus.saves?.[0]?.path || null);
    }
  }

  init().catch((err) => {
    els.poolSummary.textContent = `Error loading scouting data: ${err.message}`;
  });
})();
