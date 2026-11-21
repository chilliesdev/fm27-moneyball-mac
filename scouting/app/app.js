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

  const POSITION_TOKENS = [
    "ST", "AML", "AMR", "AMC", "ML", "MR", "MC", "DM", "DC", "DL", "DR", "WBL", "WBR", "GK",
  ];
  const FOOT_OPTIONS = ["Left", "Right", "Both"];
  const STATUS_OPTIONS = ["Expiring Soon", "On Loan", "Not On Loan", "Free Agent"];
  const CLUB_PAGE_SIZE = 250;
  const SQUAD_PAGE_SIZE = 24;
  const MIN_FILTERS = [
    { id: "minAge", label: "Min Age", field: "age", prefix: "", suffix: "" },
    { id: "minVal", label: "Min Transfer Value", field: "value", prefix: "£", suffix: "" },
    { id: "minWage", label: "Min Weekly Wage", field: "wage", prefix: "£", suffix: "/wk" },
  ];

  const DEFAULT_FILTERS = {
    minMins: "900",
    minAge: "",
    maxAge: "25",
    minVal: "",
    maxVal: "15000000",
    minWage: "",
    maxWage: "999999999",
    contract: "all",
    minRep: "5500",
    dynamicPct: true,
    includeHull: true,
  };

  const SHORTLIST_KEY = "hull_fm27_moneyball_shortlist_v1";
  const PRESETS_KEY = "fm27_moneyball_role_presets_v1";
  const COLS_KEY = "fm27_moneyball_cols_v1";

  const METHOD_HINTS = {
    percentile: "Mid-rank percentile (0–100) within the active baseline pool.",
    zscore: "Standardized Z-score mapped ±3σ to 0–100 (50 = pool mean, clamped).",
    minmax: "Linear Min–Max normalization (0–100) within baseline pool bounds (clamped).",
  };

  const state = {
    pos: "ST",
    positionRequest: 0,
    season: null,
    seasons: [],
    meta: null,
    cache: new Map(),
    clubCatalogs: new WeakMap(),
    playerIndex: null,
    searchOptions: [],
    profileRequest: 0,
    distCache: new WeakMap(),
    catalogCache: new WeakMap(),
    shortlist: loadJsonStorage(SHORTLIST_KEY, {}),
    presets: loadJsonStorage(PRESETS_KEY, {}),
    colPrefs: loadJsonStorage(COLS_KEY, {}),
    filters: {
      leagues: new Set(),
      clubs: new Set(),
      positions: new Set(),
      nations: new Set(),
      feet: new Set(),
      statuses: new Set(),
    },
    clubOptionLimit: CLUB_PAGE_SIZE,
    squadLimit: SQUAD_PAGE_SIZE,
    squadEntries: [],
    scoreConfig: null,
    filtered: [],
    activeProfile: null,
    dialogOpenToken: 0,
    scatterChart: null,
    scatterResizeObs: null,
    scatterResizeRaf: null,
    radarChart: null,
    progressionChart: null,
    tabulatorTable: null,
    tabulatorBuilt: false,
    tabulatorBuiltPromise: null,
    lastTablePos: null,
    lastTableColSig: "",
    tableUpdateSeq: 0,
    scoreSyncTimer: null,
    scoreSyncRaf: null,
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
    searchSuggestions: document.getElementById("search-suggestions"),
    minMins: document.getElementById("f-min-mins"),
    minAge: document.getElementById("f-min-age"),
    maxAge: document.getElementById("f-max-age"),
    minVal: document.getElementById("f-min-val"),
    maxVal: document.getElementById("f-max-val"),
    minWage: document.getElementById("f-min-wage"),
    maxWage: document.getElementById("f-max-wage"),
    contract: document.getElementById("f-contract"),
    minRep: document.getElementById("f-min-rep"),
    role: document.getElementById("f-role"),
    btnCustomizeScore: document.getElementById("btn-customize-score"),
    benchmark: document.getElementById("f-benchmark"),
    dynamicPct: document.getElementById("f-dynamic-pct"),
    includeHull: document.getElementById("f-include-hull"),
    clubsScopeHint: document.getElementById("clubs-scope-hint"),
    clubListFooter: document.getElementById("club-list-footer"),
    clubListCount: document.getElementById("club-list-count"),
    btnMoreClubs: document.getElementById("btn-more-clubs"),
    activeFiltersBar: document.getElementById("active-filters-bar"),
    activeFiltersChips: document.getElementById("active-filters-chips"),
    btnResetFilters: document.getElementById("btn-reset-filters"),
    poolSummary: document.getElementById("pool-summary"),
    scatterX: document.getElementById("scatter-x"),
    scatterY: document.getElementById("scatter-y"),
    btnExportScatter: document.getElementById("btn-export-scatter"),
    scatterChart: document.getElementById("scatter-chart"),
    tableCaption: document.getElementById("table-caption"),
    tableCountNote: document.getElementById("table-count-note"),
    squadResults: document.getElementById("squad-results"),
    squadStatus: document.getElementById("squad-status"),
    squadPlayers: document.getElementById("squad-players"),
    btnMoreSquad: document.getElementById("btn-more-squad"),
    btnColumnChooser: document.getElementById("btn-column-chooser"),
    columnChooserPopover: document.getElementById("column-chooser-popover"),
    scoutingTable: document.getElementById("scouting-table"),
    sortStatus: document.getElementById("sort-status"),
    shortlistCount: document.getElementById("shortlist-count"),
    btnShortlistView: document.getElementById("btn-shortlist-view"),
    btnExportCsv: document.getElementById("btn-export-csv"),
    playerDialog: document.getElementById("player-dialog"),
    dialogPlayerImg: document.getElementById("dialog-player-img"),
    dialogClubImg: document.getElementById("dialog-club-img"),
    dialogName: document.getElementById("dialog-player-name"),
    dialogMeta: document.getElementById("dialog-player-meta"),
    dialogCopyName: document.getElementById("dialog-copy-name"),
    dialogShortlistBtn: document.getElementById("dialog-shortlist-btn"),
    dialogCloseBtn: document.getElementById("dialog-close-btn"),
    dialogCompareSelect: document.getElementById("dialog-compare-select"),
    radarChart: document.getElementById("radar-chart"),
    dialogProfileFacts: document.getElementById("dialog-profile-facts"),
    dialogSeasonHeading: document.getElementById("dialog-season-heading"),
    dialogSeasonEmpty: document.getElementById("dialog-season-empty"),
    dialogSeasonStats: document.getElementById("dialog-season-stats"),
    dialogRadarPanel: document.getElementById("dialog-radar-panel"),
    dialogProfileMetrics: document.getElementById("dialog-profile-metrics"),
    dialogStatsList: document.getElementById("dialog-stats-list"),
    dialogProgressionEmpty: document.getElementById("dialog-progression-empty"),
    progressionChart: document.getElementById("progression-chart"),
    scoreDialog: document.getElementById("score-dialog"),
    scoreDialogSubtitle: document.getElementById("score-dialog-subtitle"),
    scoreResetBtn: document.getElementById("score-reset-btn"),
    scoreCloseBtn: document.getElementById("score-close-btn"),
    scoreMethod: document.getElementById("score-method"),
    scoreMethodHint: document.getElementById("score-method-hint"),
    scorePresetPos: document.getElementById("score-preset-pos"),
    scorePresetSelect: document.getElementById("score-preset-select"),
    scorePresetName: document.getElementById("score-preset-name"),
    scoreSavePresetBtn: document.getElementById("score-save-preset-btn"),
    scoreRenamePresetBtn: document.getElementById("score-rename-preset-btn"),
    scoreDeletePresetBtn: document.getElementById("score-delete-preset-btn"),
    scoreMetricSearch: document.getElementById("score-metric-search"),
    scoreCategoryFilter: document.getElementById("score-category-filter"),
    scoreEnabledOnly: document.getElementById("score-enabled-only"),
    scoreTotalWeight: document.getElementById("score-total-weight"),
    scoreMetricsList: document.getElementById("score-metrics-list"),
    scorePreviewNote: document.getElementById("score-preview-note"),
    scorePreviewList: document.getElementById("score-preview-list"),
    shortlistDialog: document.getElementById("shortlist-dialog"),
    shortlistBody: document.getElementById("shortlist-body"),
    shortlistPosition: document.getElementById("shortlist-position"),
    shortlistCloseBtn: document.getElementById("shortlist-close-btn"),
    btnExportShortlist: document.getElementById("btn-export-shortlist"),
    btnClearShortlist: document.getElementById("btn-clear-shortlist"),
    toastRegion: document.getElementById("toast-region"),
  };

  const FACETS = {
    leagues: {
      label: "League",
      defaultText: "All Leagues",
      trigger: document.getElementById("btn-f-leagues"),
      popover: document.getElementById("pop-leagues"),
      listbox: document.getElementById("list-leagues"),
    },
    clubs: {
      label: "Club",
      defaultText: "All Clubs",
      trigger: document.getElementById("btn-f-clubs"),
      popover: document.getElementById("pop-clubs"),
      listbox: document.getElementById("list-clubs"),
    },
    positions: {
      label: "Pos",
      defaultText: "All Positions",
      trigger: document.getElementById("btn-f-positions"),
      popover: document.getElementById("pop-positions"),
      listbox: document.getElementById("list-positions"),
    },
    nations: {
      label: "Nation",
      defaultText: "All Nationalities",
      trigger: document.getElementById("btn-f-nations"),
      popover: document.getElementById("pop-nations"),
      listbox: document.getElementById("list-nations"),
    },
    feet: {
      label: "Foot",
      defaultText: "Any Foot",
      trigger: document.getElementById("btn-f-feet"),
      popover: document.getElementById("pop-feet"),
      listbox: document.getElementById("list-feet"),
    },
    statuses: {
      label: "Status",
      defaultText: "Any Status",
      trigger: document.getElementById("btn-f-statuses"),
      popover: document.getElementById("pop-statuses"),
      listbox: document.getElementById("list-statuses"),
    },
  };

  function loadJsonStorage(key, fallback) {
    try {
      const raw = localStorage.getItem(key);
      return raw ? JSON.parse(raw) : fallback;
    } catch {
      return fallback;
    }
  }

  function saveJsonStorage(key, value) {
    try {
      localStorage.setItem(key, JSON.stringify(value));
    } catch {
      // Ignore storage quota errors
    }
  }

  function saveShortlist() {
    saveJsonStorage(SHORTLIST_KEY, state.shortlist);
    els.shortlistCount.textContent = String(Object.keys(state.shortlist).length);
  }

  function savePresets() {
    saveJsonStorage(PRESETS_KEY, state.presets);
  }

  function saveColPrefs() {
    saveJsonStorage(COLS_KEY, state.colPrefs);
  }

  function escapeHtml(str) {
    return String(str ?? "")
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;")
      .replaceAll('"', "&quot;");
  }

  function playerName(p) {
    return p?.name || "Unnamed Player";
  }

  async function copyPlayerName(player) {
    try {
      await navigator.clipboard.writeText(player.name);
      showToast("Player name copied");
    } catch {
      showToast("Could not copy the player name");
    }
  }

  function clubNameOf(p) {
    return p?.club || "Free Agent";
  }

  function clubKeyOf(p) {
    return p?.club_uid || p?.club || "Free Agent";
  }

  function personImgUrl(p) {
    const id = p?.img_id || p?.uid || "";
    const name = p?.name || "?";
    return `/api/img/person/${encodeURIComponent(id)}?name=${encodeURIComponent(name)}`;
  }

  function clubImgUrl(id, name) {
    return `/api/img/club/${encodeURIComponent(id || "")}?name=${encodeURIComponent(name || "Club")}`;
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
    if (key === "minutes" || key === "starts" || key === "apps" || key === "goals" || key === "assists") {
      return String(Math.round(num));
    }
    if (key === "avg_rating") return num.toFixed(2);
    return num.toFixed(2);
  }

  function pctClass(pct) {
    if (pct >= 85) return "pct-elite";
    if (pct >= 65) return "pct-good";
    if (pct >= 35) return "pct-mid";
    return "pct-low";
  }

  function seasonEndYear() {
    const explicit = Number(state.meta?.season_end_year);
    if (Number.isFinite(explicit) && explicit > 1900) return explicit;
    const dateStr = String(state.meta?.in_game_date || "");
    const dateYr = Number(dateStr.slice(0, 4));
    if (Number.isFinite(dateYr) && dateYr > 1900) return dateYr;
    const seasonStr = String(state.meta?.season || "");
    const m = seasonStr.match(/^(\d{4})/);
    if (m) return Number(m[1]) + 1;
    return new Date().getFullYear();
  }

  function showToast(message) {
    if (!els.toastRegion || !message) return;
    while (els.toastRegion.children.length >= 3) {
      els.toastRegion.firstElementChild.remove();
    }
    const item = document.createElement("div");
    item.className = "toast-item";
    item.textContent = message;

    let remaining = 3000;
    let startedAt = Date.now();
    let timer = null;

    const schedule = () => {
      startedAt = Date.now();
      clearTimeout(timer);
      timer = setTimeout(() => {
        item.remove();
        if (!els.toastRegion.children.length) {
          try {
            if (els.toastRegion.matches(":popover-open")) els.toastRegion.hidePopover();
          } catch {
            // Ignore popover support differences
          }
        }
      }, remaining);
    };
    const pause = () => {
      clearTimeout(timer);
      remaining = Math.max(400, remaining - (Date.now() - startedAt));
    };

    item.addEventListener("mouseenter", pause);
    item.addEventListener("mouseleave", schedule);
    item.addEventListener("focusin", pause);
    item.addEventListener("focusout", schedule);
    els.toastRegion.append(item);
    try {
      if (typeof els.toastRegion.showPopover === "function") {
        // Re-promote to top of top-layer so toasts are visible above open modal dialogs
        if (els.toastRegion.matches(":popover-open")) els.toastRegion.hidePopover();
        els.toastRegion.showPopover();
      }
    } catch {
      // Ignore popover support differences
    }
    schedule();
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

  function getThemeColors() {
    const cs = getComputedStyle(document.documentElement);
    const isDark = window.matchMedia("(prefers-color-scheme: dark)").matches;
    // Canvas needs the theme's color values. The UI tokens can contain light-dark().
    const mode = isDark ? "dark" : "light";
    const read = (prop) => cs.getPropertyValue(`--${prop}-${mode}`).trim();
    return {
      surface: read("surface"),
      border: read("border"),
      text: read("text"),
      muted: read("muted"),
      accent: read("accent"),
      compare: read("compare"),
      poolDot: read("pool-dot"),
      gridLine: isDark ? "rgba(154, 166, 181, 0.16)" : "rgba(82, 93, 109, 0.15)",
      quadrantFill: isDark ? "rgba(245, 158, 11, 0.08)" : "rgba(196, 107, 0, 0.07)",
    };
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

  function playerLookupEntry(player, groups, hasStats) {
    return { player, groups, hasStats, nameKey: normalizeSearchText(player.name) };
  }

  async function readPlayerIndex(meta, season) {
    if (meta.has_player_search) {
      const url = season ? `/seasons/${encodeURIComponent(season)}/data/player_search.json` : "data/player_search.json";
      const res = await fetch(url);
      if (!res.ok) throw new Error("Failed to load the player index");
      const { fields, rows } = await res.json();
      return rows.map((row) => {
        const player = {};
        for (let i = 0; i < fields.length; i++) player[fields[i]] = row[i];
        return playerLookupEntry(player, player.position_groups, player.has_scouting_stats);
      });
    }

    const positions = await Promise.allSettled(Object.keys(POS_LABELS).map((pos) => loadPosition(pos, season)));
    const entries = new Map();
    for (const result of positions) {
      if (result.status !== "fulfilled") continue;
      const { players, position } = result.value;
      for (const player of players) {
        if (!player.name) continue;
        const entry = entries.get(player.uid);
        if (entry) entry.groups.push(position);
        else entries.set(player.uid, playerLookupEntry(player, [position], true));
      }
    }
    return [...entries.values()];
  }

  function ensurePlayerIndex() {
    if (state.playerIndex) return state.playerIndex;
    const index = { entries: null, failed: false };
    state.playerIndex = index;
    readPlayerIndex(state.meta, state.season).then((entries) => {
      index.entries = entries;
    }).catch(() => {
      index.failed = true;
    }).finally(() => {
      if (state.playerIndex !== index) return;
      if (!els.search.hasAttribute("aria-activedescendant")) renderSearchSuggestions();
      renderSquadProfiles();
    });
    return index;
  }

  function populateContractOptions() {
    const y = seasonEndYear();
    const prev = els.contract.value || "all";
    els.contract.innerHTML = [
      `<option value="all">Any Contract</option>`,
      `<option value="lte:${y}">Expiring &le; ${y}</option>`,
      `<option value="lte:${y + 1}">Expiring &le; ${y + 1}</option>`,
      `<option value="lte:${y + 2}">Expiring &le; ${y + 2}</option>`,
    ].join("");
    if ([...els.contract.options].some((o) => o.value === prev)) {
      els.contract.value = prev;
    } else {
      els.contract.value = "all";
    }
  }

  async function loadMeta(season = state.season) {
    const url = season ? `/seasons/${encodeURIComponent(season)}/data/meta.json` : "data/meta.json";
    const res = await fetch(url);
    if (!res.ok) throw new Error(`Failed loading ${url}`);
    const meta = await res.json();
    if (season !== state.season) return;
    state.meta = meta;
    state.playerIndex = null;
    state.clubCatalogs = new WeakMap();
    const clubName = state.meta.club_name || "Moneyball Scout";
    const shortName = state.meta.club_short_name || clubName;
    const crestId = state.meta.club_img_id || state.meta.club_uid || "";
    els.clubCrest.src = clubImgUrl(crestId, shortName);
    els.clubCrest.alt = `${clubName} crest`;
    els.clubTitle.textContent = `${clubName} — Moneyball Scout`;
    const seasonLabel = state.meta.season ? `Season ${state.meta.season} · ` : "";
    els.saveMeta.textContent = `FM27 · ${seasonLabel}${state.meta.in_game_date || ""} · ${state.meta.save_file || ""} · Stats-Only`;
    populateContractOptions();
  }

  // ---- Unified Metric Catalog & Lazy Float64Array Scoring Engine (F12) ----

  function getMetricCatalog(dataset) {
    if (state.catalogCache.has(dataset)) return state.catalogCache.get(dataset);

    const byKey = new Map();
    const list = [];
    for (const m of dataset.all_metrics || []) {
      const entry = {
        key: m.key,
        label: m.label,
        higher_is_better: Boolean(m.higher_is_better),
        category: m.category || "Other",
      };
      byKey.set(entry.key, entry);
      list.push(entry);
    }
    const defaultKeys = new Set();
    for (const m of dataset.metrics || []) {
      defaultKeys.add(m.key);
      if (!byKey.has(m.key)) {
        const entry = {
          key: m.key,
          label: m.label,
          higher_is_better: Boolean(m.higher_is_better),
          category: "Position Defaults",
        };
        byKey.set(entry.key, entry);
        list.push(entry);
      }
    }
    const catalog = { list, byKey, defaultKeys };
    state.catalogCache.set(dataset, catalog);
    return catalog;
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

  function getBaselinePool(dataset, minMins, minRep, dynamicPct) {
    const peerPool = dataset.players.filter(
      (p) => p.minutes >= minMins && (p.club_rep >= minRep || p.is_hull)
    );
    if (dynamicPct && peerPool.length >= 10) {
      return {
        pool: peerPool,
        peerCount: peerPool.length,
        isGlobal: false,
        tag: `${minMins}:${minRep}`,
      };
    }
    const minBase = dataset.baseline_minutes || 900;
    let globalPool = dataset.players.filter((p) => p.minutes >= minBase);
    if (globalPool.length < 20) globalPool = dataset.players;
    return {
      pool: globalPool,
      peerCount: peerPool.length,
      isGlobal: true,
      tag: `global:${minBase}`,
    };
  }

  function getMetricDist(dataset, baseline, key) {
    let pools = state.distCache.get(dataset);
    if (!pools) {
      pools = new Map();
      state.distCache.set(dataset, pools);
    }
    let metricMap = pools.get(baseline.tag);
    if (!metricMap) {
      metricMap = new Map();
      pools.set(baseline.tag, metricMap);
    }
    if (metricMap.has(key)) return metricMap.get(key);

    const pool = baseline.pool;
    const rawVals = [];
    for (let i = 0; i < pool.length; i++) {
      const raw = pool[i][key];
      if (raw === null || raw === undefined || raw === "") continue;
      const num = Number(raw);
      if (Number.isFinite(num)) rawVals.push(num);
    }
    const n = rawVals.length;
    if (n === 0) {
      const empty = { n: 0, mean: 0, std: 0, min: 0, max: 0, sorted: new Float64Array(0) };
      metricMap.set(key, empty);
      return empty;
    }

    const sorted = Float64Array.from(rawVals);
    let sum = 0;
    let min = sorted[0];
    let max = sorted[0];
    for (let i = 0; i < n; i++) {
      const v = sorted[i];
      sum += v;
      if (v < min) min = v;
      if (v > max) max = v;
    }
    const mean = sum / n;
    let sq = 0;
    for (let i = 0; i < n; i++) {
      const d = sorted[i] - mean;
      sq += d * d;
    }
    const std = Math.sqrt(sq / n);
    sorted.sort();
    const dist = { n, mean, std, min, max, sorted };
    metricMap.set(key, dist);
    return dist;
  }

  function scoreMetric(val, method, higher, dist, fallbackPct, defaultHigher) {
    if (val === null || val === undefined || val === "") return 50;
    const x = Number(val);
    if (!Number.isFinite(x)) return 50;
    if (!dist || dist.n === 0) {
      if (fallbackPct !== null && fallbackPct !== undefined) {
        return higher === defaultHigher ? fallbackPct : 100 - fallbackPct;
      }
      return 50;
    }
    if (method === "zscore") {
      if (dist.std === 0 || !Number.isFinite(dist.std)) return 50;
      let z = (x - dist.mean) / dist.std;
      if (!higher) z = -z;
      return Math.max(0, Math.min(100, 50 + z * (50 / 3)));
    }
    if (method === "minmax") {
      if (dist.max === dist.min) return 50;
      let norm = ((x - dist.min) / (dist.max - dist.min)) * 100;
      if (!higher) norm = 100 - norm;
      return Math.max(0, Math.min(100, norm));
    }
    // Default: percentile
    if (dist.min === dist.max) return 50;
    const mid = (bisectLeft(dist.sorted, x) + bisectRight(dist.sorted, x)) / 2;
    let pct = (mid / dist.n) * 100;
    if (!higher) pct = 100 - pct;
    return Math.max(0, Math.min(100, Math.round(pct)));
  }

  function getPlayerMetricPct(player, key, dataset, baseline) {
    if (player?.active_pcts && player.active_pcts[key] !== undefined) {
      return player.active_pcts[key];
    }
    const catalog = getMetricCatalog(dataset);
    const meta = catalog.byKey.get(key);
    const config = dataset.position === state.pos ? state.scoreConfig : null;
    const cfgItem = config?.metrics.find((m) => m.key === key);
    const higher = cfgItem ? cfgItem.higher_is_better : (meta?.higher_is_better ?? true);
    const method = config?.method || "percentile";
    const dist = getMetricDist(dataset, baseline, key);
    return Math.round(
      scoreMetric(player?.[key], method, higher, dist, player?.[`pct_${key}`], meta?.higher_is_better ?? true)
    );
  }

  function getPosPresets(pos) {
    const list = state.presets?.[pos];
    return Array.isArray(list) ? list : [];
  }

  function buildScoreConfigFromRole(dataset, roleValue, preserveMethod = null) {
    const catalog = getMetricCatalog(dataset);
    const pos = dataset.position;

    if (roleValue && roleValue.startsWith("custom:")) {
      const presetId = roleValue.slice(7);
      const preset = getPosPresets(pos).find((p) => p.id === presetId);
      if (preset) {
        const presetMap = new Map(preset.metrics.map((m) => [m.key, m]));
        return {
          pos,
          roleSlug: roleValue,
          presetId,
          method: preset.method || "percentile",
          metrics: catalog.list.map((cat) => {
            const saved = presetMap.get(cat.key);
            return {
              key: cat.key,
              weight: saved ? Math.max(0, Math.min(5, Number(saved.weight) || 0)) : 1,
              higher_is_better: saved ? Boolean(saved.higher_is_better) : cat.higher_is_better,
              enabled: Boolean(saved),
            };
          }),
        };
      }
    }

    const slug = roleValue && (roleValue === "overall" || dataset.roles[roleValue]) ? roleValue : "overall";
    const roleKeys =
      slug === "overall"
        ? new Set(dataset.metrics.map((m) => m.key))
        : new Set(dataset.roles[slug]?.metrics || dataset.metrics.map((m) => m.key));

    return {
      pos,
      roleSlug: slug,
      presetId: null,
      method: preserveMethod || state.scoreConfig?.method || "percentile",
      metrics: catalog.list.map((cat) => ({
        key: cat.key,
        weight: 1,
        higher_is_better: cat.higher_is_better,
        enabled: roleKeys.has(cat.key),
      })),
    };
  }

  function refreshRoleSelectOptions(dataset, desiredValue) {
    const pos = dataset.position;
    const roleEntries = Object.entries(dataset.roles || {});
    const presets = getPosPresets(pos);
    const parts = [
      `<option value="overall">Overall Moneyball Score</option>`,
      ...roleEntries.map(([slug, info]) => `<option value="${escapeHtml(slug)}">${escapeHtml(info.label)}</option>`),
    ];
    if (presets.length) {
      parts.push(
        `<optgroup label="Custom Presets">${presets
          .map((p) => `<option value="custom:${escapeHtml(p.id)}">${escapeHtml(p.name)}</option>`)
          .join("")}</optgroup>`
      );
    }
    if (desiredValue === "__custom_draft__") {
      parts.push(`<option value="__custom_draft__">Custom (Unsaved)</option>`);
    }
    els.role.innerHTML = parts.join("");
    if (desiredValue && [...els.role.options].some((o) => o.value === desiredValue)) {
      els.role.value = desiredValue;
    } else {
      els.role.value = "overall";
    }
  }

  function populateScatterAxes(dataset, preserveAxes) {
    const catalog = getMetricCatalog(dataset);
    const prevX = els.scatterX.value;
    const prevY = els.scatterY.value;

    const defaultItems = dataset.metrics || [];
    const grouped = new Map();
    for (const m of catalog.list) {
      if (catalog.defaultKeys.has(m.key)) continue;
      if (!grouped.has(m.category)) grouped.set(m.category, []);
      grouped.get(m.category).push(m);
    }

    const optHtml = [
      `<optgroup label="Position Defaults">${defaultItems
        .map((m) => `<option value="${escapeHtml(m.key)}">${escapeHtml(m.label)}</option>`)
        .join("")}</optgroup>`,
      ...[...grouped.entries()].map(
        ([cat, items]) =>
          `<optgroup label="${escapeHtml(cat)}">${items
            .map((m) => `<option value="${escapeHtml(m.key)}">${escapeHtml(m.label)}</option>`)
            .join("")}</optgroup>`
      ),
    ].join("");

    els.scatterX.innerHTML = optHtml;
    els.scatterY.innerHTML = optHtml;

    const [defX, defY] = DEFAULT_AXES[dataset.position] || [defaultItems[0]?.key, defaultItems[1]?.key];
    els.scatterX.value = preserveAxes && catalog.byKey.has(prevX) ? prevX : defX;
    els.scatterY.value = preserveAxes && catalog.byKey.has(prevY) ? prevY : defY;
  }

  function populatePositionControls(dataset) {
    const samePosition = state.scoreConfig?.pos === dataset.position;
    const prevRole = els.role.value;
    const validPrev =
      prevRole === "overall" ||
      Boolean(dataset.roles?.[prevRole]) ||
      (prevRole.startsWith("custom:") && getPosPresets(dataset.position).some((p) => `custom:${p.id}` === prevRole));
    const initialRole = validPrev ? prevRole : "overall";

    state.scoreConfig = buildScoreConfigFromRole(
      dataset,
      initialRole,
      initialRole.startsWith("custom:") ? null : state.scoreConfig?.method || "percentile"
    );
    refreshRoleSelectOptions(dataset, state.scoreConfig.roleSlug);
    populateScatterAxes(dataset, samePosition);

    const hullInPos = dataset.players.filter((p) => p.is_hull);
    const hullFallback = (state.meta?.hull_squad || []).filter((p) => !hullInPos.some((h) => h.uid === p.uid));
    const clubTag = state.meta?.club_short_name || "CLUB";
    els.benchmark.innerHTML = [
      `<option value="">None</option>`,
      ...hullInPos.map(
        (p) =>
          `<option value="${escapeHtml(p.uid)}">[${escapeHtml(clubTag)} ${escapeHtml(dataset.position)}] ${escapeHtml(
            playerName(p)
          )} (${p.minutes}m)</option>`
      ),
      ...hullFallback.map(
        (p) =>
          `<option value="${escapeHtml(p.uid)}">[${escapeHtml(clubTag)}] ${escapeHtml(playerName(p))} (${escapeHtml(
            p.positions
          )})</option>`
      ),
    ].join("");
    if (hullInPos.length > 0) {
      els.benchmark.value = hullInPos[0].uid;
    }
  }

  // ---- Multi-Select Facet Filters (F10) & Dynamic UX (F11) ----

  function parsePlayerPositions(posStr) {
    return String(posStr ?? "")
      .split(";")
      .map((s) => {
        const t = s.trim();
        return t === "STC" ? "ST" : t;
      })
      .filter(Boolean);
  }

  function playerHasStatus(p, status) {
    if (status === "Expiring Soon") {
      if (!p.contract_end) return false;
      const yr = Number(String(p.contract_end).slice(0, 4));
      return Number.isFinite(yr) && yr > 0 && yr <= seasonEndYear();
    }
    if (status === "On Loan") return Boolean(p.on_loan);
    if (status === "Not On Loan") return !p.on_loan;
    if (status === "Free Agent") return p.league === "Free Agent" || !p.club_uid || p.club === "Free Agent";
    return false;
  }

  function readScalarFilters() {
    return {
      minimums: MIN_FILTERS.flatMap((filter) => {
        const input = els[filter.id];
        return input.validity.valid && Number.isFinite(input.valueAsNumber)
          ? [{ ...filter, value: input.valueAsNumber }]
          : [];
      }),
      minMins: Number(els.minMins.value),
      minRep: Number(els.minRep.value),
      maxAge: Number(els.maxAge.value),
      maxVal: Number(els.maxVal.value),
      maxWage: Number(els.maxWage.value),
      contractFilter: els.contract.value || "all",
      search: normalizeSearchText(els.search.value),
      dynamicPct: els.dynamicPct.checked,
      includeHull: els.includeHull.checked,
    };
  }

  function normalizeSearchText(value) {
    return String(value ?? "").normalize("NFD").replace(/\p{M}/gu, "").toLowerCase().trim();
  }

  function matchesSearch(player, query) {
    if (!query) return true;
    return normalizeSearchText(`${player.name ?? ""} ${player.club ?? ""} ${player.positions ?? ""} ${player.league ?? ""} ${player.nation ?? ""}`).includes(query);
  }

  function matchesLocation(player, omitFacet = null) {
    const { leagues, clubs } = state.filters;
    return (omitFacet === "leagues" || !leagues.size || leagues.has(player.league || "Free Agent")) &&
      (omitFacet === "clubs" || !clubs.size || clubs.has(clubKeyOf(player)));
  }

  function matchesPlayer(p, scalar, omitFacet = null) {
    if (!scalar.includeHull && p.is_hull) return false;
    if (!p.is_hull && p.minutes < scalar.minMins) return false;
    if (p.is_hull && p.minutes < 300) return false;
    if (!p.is_hull && p.club_rep < scalar.minRep) return false;
    if (scalar.minimums.some(({ field, value }) => !Number.isFinite(p[field]) || p[field] < value)) {
      return false;
    }
    if (!p.is_hull && scalar.maxAge < 99 && (p.age === null || p.age === undefined || p.age > scalar.maxAge)) {
      return false;
    }
    if (!p.is_hull && scalar.maxVal < 999999999 && p.value !== null && p.value !== undefined && p.value > scalar.maxVal) {
      return false;
    }
    if (
      !p.is_hull &&
      scalar.maxWage < 999999999 &&
      p.wage !== null &&
      p.wage !== undefined &&
      p.wage > scalar.maxWage
    ) {
      return false;
    }
    if (!p.is_hull && scalar.contractFilter !== "all") {
      const yr = Number(String(p.contract_end || "").slice(0, 4));
      if (scalar.contractFilter.startsWith("lte:")) {
        const limit = Number(scalar.contractFilter.slice(4));
        if (!yr || yr > limit) return false;
      } else {
        const exact = Number(scalar.contractFilter);
        if (!yr || yr !== exact) return false;
      }
    }
    if (!matchesSearch(p, scalar.search) || !matchesLocation(p, omitFacet)) return false;

    // Categorical multi-select filters apply uniformly (including is_hull)
    if (omitFacet !== "positions" && state.filters.positions.size > 0) {
      const tokens = parsePlayerPositions(p.positions);
      if (!tokens.some((t) => state.filters.positions.has(t))) return false;
    }
    if (omitFacet !== "nations" && state.filters.nations.size > 0) {
      if (!state.filters.nations.has(p.nation || "")) return false;
    }
    if (omitFacet !== "feet" && state.filters.feet.size > 0) {
      if (!state.filters.feet.has(p.foot || "")) return false;
    }
    if (omitFacet !== "statuses" && state.filters.statuses.size > 0) {
      let anyStatus = false;
      for (const st of state.filters.statuses) {
        if (playerHasStatus(p, st)) {
          anyStatus = true;
          break;
        }
      }
      if (!anyStatus) return false;
    }
    return true;
  }

  function closeSearchSuggestions() {
    els.searchSuggestions.hidden = true;
    els.search.setAttribute("aria-expanded", "false");
    els.search.removeAttribute("aria-activedescendant");
  }

  function renderSearchSuggestions() {
    closeSearchSuggestions();
    const query = normalizeSearchText(els.search.value);
    const dataset = activeDataset();
    if (!query || !dataset || document.activeElement !== els.search) return;

    const index = query.length >= 2 ? ensurePlayerIndex() : null;
    const visiblePlayers = new Set(state.filtered.map((player) => player.uid));
    const visibleClubs = new Set(state.filtered.map(clubNameOf));
    const candidates = index?.entries || dataset.players.map((player) => playerLookupEntry(player, [dataset.position], true));
    const names = candidates.filter((entry) => entry.nameKey.includes(query));
    const wordStart = ` ${query}`;
    const matchRank = (name) => (name === query ? 0 : name.startsWith(query) || name.includes(wordStart) ? 1 : 2);
    names.sort((a, b) => matchRank(a.nameKey) - matchRank(b.nameKey) ||
      Number(visiblePlayers.has(b.player.uid)) - Number(visiblePlayers.has(a.player.uid)) ||
      collator.compare(playerName(a.player), playerName(b.player)));
    const clubs = new Map();
    for (const { club } of getClubCatalog(dataset).values()) {
      const nameKey = normalizeSearchText(club);
      if (nameKey.includes(query)) clubs.set(club, nameKey);
    }
    const suggestions = [
      ...names.slice(0, 5).map((entry) => ({ value: playerName(entry.player), detail: clubNameOf(entry.player), entry })),
      ...[...clubs].sort((a, b) => matchRank(a[1]) - matchRank(b[1]) ||
        Number(visibleClubs.has(b[0])) - Number(visibleClubs.has(a[0])) || a[1].length - b[1].length ||
        collator.compare(a[0], b[0]))
        .slice(0, 4).map(([value]) => ({ value, detail: "Club" })),
    ];
    state.searchOptions = suggestions;
    if (!suggestions.length) return;

    els.searchSuggestions.innerHTML = suggestions.map(({ value, detail }, index) => `
      <li id="search-suggestion-${index}" role="option" aria-selected="false" data-index="${index}" data-value="${escapeHtml(value)}">
        <span>${escapeHtml(value)}</span><small>${escapeHtml(detail)}</small>
      </li>
    `).join("");
    const gridBottom = els.search.closest(".filter-grid").getBoundingClientRect().bottom;
    const searchBottom = els.search.getBoundingClientRect().bottom;
    els.searchSuggestions.style.maxBlockSize = `min(20rem, ${gridBottom - searchBottom}px)`;
    els.searchSuggestions.hidden = false;
    els.search.setAttribute("aria-expanded", "true");
  }

  function selectSearchSuggestion(option) {
    const selection = state.searchOptions[Number(option.dataset.index)];
    if (!selection) return;
    els.search.value = selection.value;
    refreshView();
    closeSearchSuggestions();
    if (selection.entry) openLookupProfile(selection.entry);
  }

  async function openLookupProfile({ player, groups, hasStats }) {
    const request = ++state.profileRequest;
    const season = state.season;
    const group = groups.includes(state.pos) ? state.pos : groups[0];
    const dataset = hasStats && group ? await loadPosition(group, season).catch(() => null) : null;
    if (request !== state.profileRequest || season !== state.season || els.playerDialog.open) return;
    const scoutingRow = dataset?.players.find((row) => row.uid === player.uid);
    openPlayerDialog(scoutingRow || player, scoutingRow ? dataset : null, season);
  }

  function wireSearchSuggestions() {
    els.search.addEventListener("input", refreshView);
    els.search.addEventListener("focus", renderSearchSuggestions);
    els.search.addEventListener("blur", closeSearchSuggestions);
    window.addEventListener("resize", () => {
      if (!els.searchSuggestions.hidden) renderSearchSuggestions();
    });
    els.searchSuggestions.addEventListener("mousedown", (event) => event.preventDefault());
    els.searchSuggestions.addEventListener("click", (event) => {
      const option = event.target.closest("[role='option']");
      if (option) selectSearchSuggestion(option);
    });
    els.search.addEventListener("keydown", (event) => {
      if (event.isComposing) return;
      if (event.key === "ArrowDown" || event.key === "ArrowUp") {
        if (els.searchSuggestions.hidden) renderSearchSuggestions();
        if (els.searchSuggestions.hidden) return;
        event.preventDefault();
        const options = [...els.searchSuggestions.children];
        const current = options.findIndex((option) => option.getAttribute("aria-selected") === "true");
        const step = event.key === "ArrowDown" ? 1 : -1;
        const next = current < 0 && step < 0 ? options.length - 1 : (current + step + options.length) % options.length;
        options[current]?.setAttribute("aria-selected", "false");
        options[next].setAttribute("aria-selected", "true");
        els.search.setAttribute("aria-activedescendant", options[next].id);
        options[next].scrollIntoView({ block: "nearest" });
      } else if (!els.searchSuggestions.hidden && event.key === "Escape") {
        event.preventDefault();
        closeSearchSuggestions();
      } else if (!els.searchSuggestions.hidden && event.key === "Enter") {
        const option = els.searchSuggestions.querySelector('[aria-selected="true"]');
        if (option) {
          event.preventDefault();
          selectSearchSuggestion(option);
        }
      }
    });
  }

  function getClubCatalog(dataset) {
    const cached = state.clubCatalogs.get(dataset);
    if (cached) return cached;
    const catalog = state.meta?.season === dataset.season ? state.meta?.club_catalog || [] : [];
    const map = new Map();
    for (const p of [...dataset.players, ...catalog]) {
      const key = clubKeyOf(p);
      if (!map.has(key)) {
        map.set(key, {
          key,
          club: clubNameOf(p),
          club_img_id: p.club_img_id || p.club_uid || "",
          league: p.league || "Free Agent",
        });
      }
    }
    state.clubCatalogs.set(dataset, map);
    return map;
  }

  function pruneClubsBySelectedLeagues(dataset) {
    if (state.filters.clubs.size === 0 || state.filters.leagues.size === 0) return;
    const clubMap = getClubCatalog(dataset);
    for (const cKey of [...state.filters.clubs]) {
      const info = clubMap.get(cKey);
      if (!info || !state.filters.leagues.has(info.league)) {
        state.filters.clubs.delete(cKey);
      }
    }
  }

  function updateTriggerButton(facetName, dataset) {
    const cfg = FACETS[facetName];
    const selected = state.filters[facetName];
    const labelEl = cfg.trigger.querySelector(".trigger-label");
    const badgeEl = cfg.trigger.querySelector(".trigger-badge");

    if (selected.size === 0) {
      labelEl.textContent = cfg.defaultText;
      badgeEl.hidden = true;
    } else if (selected.size === 1) {
      const only = [...selected][0];
      let text = only || "Unknown";
      if (facetName === "clubs" && dataset) {
        text = getClubCatalog(dataset).get(only)?.club || only;
      }
      labelEl.textContent = text;
      badgeEl.textContent = "1";
      badgeEl.hidden = false;
    } else {
      labelEl.textContent = `${selected.size} selected`;
      badgeEl.textContent = String(selected.size);
      badgeEl.hidden = false;
    }
  }

  function renderFacetOptions(facetName, dataset) {
    const cfg = FACETS[facetName];
    updateTriggerButton(facetName, dataset);
    if (facetName === "clubs" && els.clubsScopeHint) {
      els.clubsScopeHint.textContent =
        state.filters.leagues.size > 0
          ? `${state.filters.leagues.size} league${state.filters.leagues.size > 1 ? "s" : ""} selected`
          : "All leagues";
    }
    if (!cfg.popover.matches(":popover-open")) return;

    const selected = state.filters[facetName];
    const scalar = readScalarFilters();
    const searchInput = cfg.popover.querySelector(".popover-search");
    const query = normalizeSearchText(searchInput?.value);

    const pool = dataset.players.filter((p) => matchesPlayer(p, scalar, facetName));
    const counts = new Map();
    const metaMap = new Map();

    if (facetName === "leagues") {
      for (const club of getClubCatalog(dataset).values()) counts.set(club.league, 0);
      for (const p of pool) {
        const val = p.league || "Free Agent";
        counts.set(val, (counts.get(val) || 0) + 1);
      }
      for (const val of selected) {
        if (!counts.has(val)) counts.set(val, 0);
      }
    } else if (facetName === "clubs") {
      const clubCatalog = getClubCatalog(dataset);
      for (const [key, info] of clubCatalog.entries()) {
        if (state.filters.leagues.size > 0 && !state.filters.leagues.has(info.league)) continue;
        counts.set(key, 0);
        metaMap.set(key, info);
      }
      for (const p of pool) {
        const key = clubKeyOf(p);
        if (counts.has(key)) counts.set(key, counts.get(key) + 1);
      }
    } else if (facetName === "positions") {
      for (const tok of POSITION_TOKENS) counts.set(tok, 0);
      for (const p of pool) {
        const seen = new Set(parsePlayerPositions(p.positions));
        for (const tok of seen) {
          counts.set(tok, (counts.get(tok) || 0) + 1);
        }
      }
    } else if (facetName === "nations") {
      for (const p of pool) {
        const val = p.nation || "";
        counts.set(val, (counts.get(val) || 0) + 1);
      }
      for (const val of selected) {
        if (!counts.has(val)) counts.set(val, 0);
      }
    } else if (facetName === "feet") {
      for (const f of FOOT_OPTIONS) counts.set(f, 0);
      for (const p of pool) {
        if (p.foot) counts.set(p.foot, (counts.get(p.foot) || 0) + 1);
      }
    } else if (facetName === "statuses") {
      for (const s of STATUS_OPTIONS) counts.set(s, 0);
      for (const p of pool) {
        for (const s of STATUS_OPTIONS) {
          if (playerHasStatus(p, s)) counts.set(s, (counts.get(s) || 0) + 1);
        }
      }
    }

    let entries = [...counts.entries()].map(([value, count]) => {
      const info = metaMap.get(value);
      const label =
        facetName === "clubs"
          ? info?.club || value
          : facetName === "nations"
            ? value || "Unknown"
            : value;
      const sub = facetName === "clubs" ? info?.league || "" : "";
      const imgId = facetName === "clubs" ? info?.club_img_id || "" : "";
      return { value, label, sub, imgId, count, isSelected: selected.has(value) };
    });

    if (query) {
      entries = entries.filter(
        (e) => normalizeSearchText(e.label).includes(query) || normalizeSearchText(e.sub).includes(query)
      );
    }

    if (facetName === "positions") {
      const order = new Map(POSITION_TOKENS.map((t, i) => [t, i]));
      entries.sort((a, b) => (order.get(a.value) ?? 99) - (order.get(b.value) ?? 99));
    } else if (facetName === "feet" || facetName === "statuses") {
      // Preserve fixed option order
    } else {
      entries.sort((a, b) => {
        if (a.isSelected !== b.isSelected) return a.isSelected ? -1 : 1;
        if (b.count !== a.count) return b.count - a.count;
        return collator.compare(a.label, b.label);
      });
    }

    const renderLimit = facetName === "clubs" ? state.clubOptionLimit : entries.length;
    if (facetName === "clubs") {
      els.clubListFooter.hidden = entries.length <= renderLimit;
      els.clubListCount.textContent = `${Math.min(renderLimit, entries.length).toLocaleString()} of ${entries.length.toLocaleString()} clubs`;
    }
    if (!entries.length) {
      cfg.listbox.innerHTML = `<div class="popover-empty">No matching options</div>`;
    } else {
      cfg.listbox.innerHTML = entries
        .slice(0, renderLimit)
        .map((e) => {
          const logo =
            facetName === "clubs"
              ? `<img class="opt-logo" src="${clubImgUrl(e.imgId, e.label)}" alt="" width="20" height="20" loading="lazy" decoding="async">`
              : "";
          const subHtml = e.sub ? `<span class="opt-sub">${escapeHtml(e.sub)}</span>` : "";
          return `
            <button type="button" class="popover-option" role="option" data-value="${escapeHtml(e.value)}" aria-selected="${e.isSelected}">
              <span class="opt-main">
                <span class="opt-check" aria-hidden="true">${e.isSelected ? "✓" : ""}</span>
                ${logo}
                <span class="opt-text">
                  <span class="opt-label">${escapeHtml(e.label)}</span>
                  ${subHtml}
                </span>
              </span>
              <span class="opt-count">${e.count.toLocaleString()}</span>
            </button>
          `;
        })
        .join("");
    }
  }

  function renderAllPopovers(dataset) {
    for (const facetName of Object.keys(FACETS)) {
      renderFacetOptions(facetName, dataset);
    }
  }

  function renderActiveFilterChips(dataset) {
    const chips = [];
    const scalar = readScalarFilters();

    if (scalar.search) {
      chips.push({ type: "search", label: `Search: "${els.search.value.trim()}"` });
    }
    for (const val of state.filters.leagues) {
      chips.push({ type: "facet", facet: "leagues", value: val, label: `League: ${val}` });
    }
    const clubMap = dataset ? getClubCatalog(dataset) : new Map();
    for (const val of state.filters.clubs) {
      const info = clubMap.get(val);
      const name = info ? `${info.club} (${info.league})` : val;
      chips.push({ type: "facet", facet: "clubs", value: val, label: `Club: ${name}` });
    }
    for (const val of state.filters.positions) {
      chips.push({ type: "facet", facet: "positions", value: val, label: `Pos: ${val}` });
    }
    for (const val of state.filters.nations) {
      chips.push({ type: "facet", facet: "nations", value: val, label: `Nation: ${val || "Unknown"}` });
    }
    for (const val of state.filters.feet) {
      chips.push({ type: "facet", facet: "feet", value: val, label: `Foot: ${val}` });
    }
    for (const val of state.filters.statuses) {
      chips.push({ type: "facet", facet: "statuses", value: val, label: `Status: ${val}` });
    }

    if (els.minMins.value !== DEFAULT_FILTERS.minMins) {
      chips.push({ type: "scalar", id: "minMins", label: `Min Mins: ${els.minMins.value}+` });
    }
    for (const { id, label, prefix, suffix, value } of scalar.minimums) {
      chips.push({ type: "scalar", id, label: `${label}: ≥ ${prefix}${value.toLocaleString()}${suffix}` });
    }
    if (els.maxAge.value !== DEFAULT_FILTERS.maxAge) {
      chips.push({
        type: "scalar",
        id: "maxAge",
        label: els.maxAge.value === "99" ? "Max Age: Any" : `Max Age: ≤ ${els.maxAge.value}`,
      });
    }
    if (els.maxVal.value !== DEFAULT_FILTERS.maxVal) {
      chips.push({
        type: "scalar",
        id: "maxVal",
        label: els.maxVal.value === "999999999" ? "Max Value: Any" : `Max Value: ≤ ${formatMoney(els.maxVal.value)}`,
      });
    }
    if (els.maxWage.value !== DEFAULT_FILTERS.maxWage) {
      chips.push({ type: "scalar", id: "maxWage", label: `Max Wage: ≤ ${formatMoney(els.maxWage.value)}/wk` });
    }
    if (els.contract.value !== DEFAULT_FILTERS.contract) {
      const txt = els.contract.selectedOptions[0]?.textContent || els.contract.value;
      chips.push({ type: "scalar", id: "contract", label: `Contract: ${txt}` });
    }
    if (els.minRep.value !== DEFAULT_FILTERS.minRep) {
      chips.push({
        type: "scalar",
        id: "minRep",
        label: els.minRep.value === "0" ? "Min Rep: All" : `Min Rep: ${els.minRep.value}+`,
      });
    }
    if (els.dynamicPct.checked !== DEFAULT_FILTERS.dynamicPct) {
      chips.push({ type: "scalar", id: "dynamicPct", label: "Global percentiles" });
    }
    if (els.includeHull.checked !== DEFAULT_FILTERS.includeHull) {
      chips.push({ type: "scalar", id: "includeHull", label: "Exclude managed club" });
    }

    if (!chips.length) {
      els.activeFiltersBar.hidden = true;
      els.activeFiltersChips.innerHTML = "";
      return;
    }

    els.activeFiltersBar.hidden = false;
    els.activeFiltersChips.innerHTML = chips
      .map((c, idx) => {
        return `<button type="button" class="chip-btn" data-chip-idx="${idx}" aria-label="Remove ${escapeHtml(
          c.label
        )} filter"><span>${escapeHtml(c.label)}</span><span class="chip-x" aria-hidden="true">×</span></button>`;
      })
      .join("");

    els.activeFiltersChips.querySelectorAll(".chip-btn").forEach((btn) => {
      const chip = chips[Number(btn.dataset.chipIdx)];
      if (!chip) return;
      btn.addEventListener("click", () => {
        if (chip.type === "search") {
          els.search.value = "";
        } else if (chip.type === "facet") {
          state.filters[chip.facet].delete(chip.value);
          if (chip.facet === "leagues") pruneClubsBySelectedLeagues(dataset);
        } else if (chip.type === "scalar") {
          if (chip.id === "dynamicPct") els.dynamicPct.checked = DEFAULT_FILTERS.dynamicPct;
          else if (chip.id === "includeHull") els.includeHull.checked = DEFAULT_FILTERS.includeHull;
          else els[chip.id].value = DEFAULT_FILTERS[chip.id];
        }
        refreshView();
      });
    });
  }

  function resetAllFilters() {
    els.search.value = "";
    for (const key of Object.keys(state.filters)) {
      state.filters[key].clear();
    }
    for (const cfg of Object.values(FACETS)) {
      const input = cfg.popover.querySelector(".popover-search");
      if (input) input.value = "";
    }
    for (const [id, value] of Object.entries(DEFAULT_FILTERS)) {
      if (typeof value === "boolean") els[id].checked = value;
      else els[id].value = value;
    }
    refreshView();
    showToast("All filters reset");
  }

  // ---- Popover Anchor Fallback Positioning & Keyboard Navigation ----

  function positionPopoverFallback(popover, trigger) {
    if (CSS.supports("position-area: block-end")) return;
    if (!trigger) return;
    const rect = trigger.getBoundingClientRect();
    const popRect = popover.getBoundingClientRect();
    const popW = popRect.width || 280;
    const popH = popRect.height || 300;

    let left = rect.left;
    if (popover.id === "column-chooser-popover") {
      left = rect.right - popW;
    }
    left = Math.max(8, Math.min(window.innerWidth - popW - 8, left));

    let top = rect.bottom + 4;
    if (top + popH + 8 > window.innerHeight && rect.top > popH + 8) {
      top = rect.top - popH - 4;
    }
    top = Math.max(8, Math.min(window.innerHeight - popH - 8, top));

    popover.style.left = `${left}px`;
    popover.style.top = `${top}px`;
  }

  function wirePopoverBehaviors() {
    const allPopovers = [
      ...Object.values(FACETS).map((f) => ({ popover: f.popover, trigger: f.trigger, facet: f })),
      { popover: els.columnChooserPopover, trigger: els.btnColumnChooser, facet: null },
    ];

    for (const { popover, trigger, facet } of allPopovers) {
      popover.addEventListener("toggle", (ev) => {
        const isOpen = ev.newState === "open";
        trigger.setAttribute("aria-expanded", String(isOpen));
        if (isOpen) {
          if (popover === els.columnChooserPopover) {
            renderColumnChooser();
          } else if (facet) {
            const ds = activeDataset();
            if (ds) {
              const name = popover.dataset.facet;
              const input = popover.querySelector(".popover-search");
              if (input) input.value = "";
              if (name === "clubs") state.clubOptionLimit = CLUB_PAGE_SIZE;
              renderFacetOptions(name, ds);
            }
          }
          requestAnimationFrame(() => {
            positionPopoverFallback(popover, trigger);
            const searchEl = popover.querySelector(".popover-search");
            if (searchEl) searchEl.focus();
          });
        }
      });

      if (facet) {
        const searchEl = popover.querySelector(".popover-search");
        if (searchEl) {
          searchEl.addEventListener("input", () => {
            const ds = activeDataset();
            const name = popover.dataset.facet;
            if (name === "clubs") state.clubOptionLimit = CLUB_PAGE_SIZE;
            if (ds) renderFacetOptions(name, ds);
          });
        }

        const clearBtn = popover.querySelector('[data-action="clear-facet"]');
        if (clearBtn) {
          clearBtn.addEventListener("click", () => {
            const name = popover.dataset.facet;
            state.filters[name].clear();
            if (searchEl) searchEl.value = "";
            refreshView();
          });
        }

        facet.listbox.addEventListener("click", (ev) => {
          const opt = ev.target.closest('[role="option"]');
          if (!opt) return;
          const name = popover.dataset.facet;
          const val = opt.dataset.value ?? "";
          if (state.filters[name].has(val)) {
            state.filters[name].delete(val);
          } else {
            state.filters[name].add(val);
          }
          if (name === "leagues") {
            const ds = activeDataset();
            if (ds) pruneClubsBySelectedLeagues(ds);
          }
          refreshView();
          const refreshed = facet.listbox.querySelector(`[role="option"][data-value="${CSS.escape(val)}"]`);
          refreshed?.focus();
        });

        facet.listbox.addEventListener("keydown", (ev) => {
          const opts = [...facet.listbox.querySelectorAll('[role="option"]')];
          if (!opts.length) return;
          const idx = opts.indexOf(document.activeElement);
          if (ev.key === "ArrowDown") {
            ev.preventDefault();
            opts[Math.min(opts.length - 1, idx + 1)].focus();
          } else if (ev.key === "ArrowUp") {
            ev.preventDefault();
            opts[Math.max(0, idx <= 0 ? 0 : idx - 1)].focus();
          } else if (ev.key === "Home") {
            ev.preventDefault();
            opts[0].focus();
          } else if (ev.key === "End") {
            ev.preventDefault();
            opts[opts.length - 1].focus();
          } else if (ev.key === " " || ev.key === "Enter") {
            if (idx >= 0) {
              ev.preventDefault();
              opts[idx].click();
            }
          }
        });
      }
    }

    const repositionOpen = () => {
      if (CSS.supports("position-area: block-end")) return;
      for (const { popover, trigger } of allPopovers) {
        if (popover.matches(":popover-open")) {
          positionPopoverFallback(popover, trigger);
        }
      }
    };
    window.addEventListener("resize", repositionOpen);
    window.addEventListener("scroll", repositionOpen, { passive: true });
  }

  // ---- Pool Scoring & Filtering ----

  function computePoolRows(dataset) {
    const scalar = readScalarFilters();
    const baseline = getBaselinePool(dataset, scalar.minMins, scalar.minRep, scalar.dynamicPct);
    const catalog = getMetricCatalog(dataset);

    const cfg = state.scoreConfig || buildScoreConfigFromRole(dataset, "overall");
    const method = cfg.method || "percentile";
    const enabledItems = cfg.metrics.filter((m) => m.enabled);
    const cfgByKey = new Map(cfg.metrics.map((m) => [m.key, m]));

    const pctKeys = new Set(dataset.metrics.map((m) => m.key));
    for (const item of enabledItems) pctKeys.add(item.key);

    const dists = new Map();
    for (const k of pctKeys) {
      dists.set(k, getMetricDist(dataset, baseline, k));
    }

    let totalWeight = 0;
    for (const item of enabledItems) totalWeight += item.weight;

    const out = [];
    for (const p of dataset.players) {
      if (!matchesPlayer(p, scalar)) continue;

      const activePcts = {};
      const rawScores = new Map();
      for (const k of pctKeys) {
        const catMeta = catalog.byKey.get(k);
        const defaultHigher = catMeta?.higher_is_better ?? true;
        const higher = cfgByKey.get(k)?.higher_is_better ?? defaultHigher;
        const raw = scoreMetric(p[k], method, higher, dists.get(k), p[`pct_${k}`], defaultHigher);
        rawScores.set(k, raw);
        activePcts[k] = Math.round(raw);
      }

      let activeScore = 0;
      if (totalWeight > 0) {
        let weightedSum = 0;
        for (const item of enabledItems) {
          weightedSum += (rawScores.get(item.key) ?? 50) * item.weight;
        }
        activeScore = Math.round((weightedSum / totalWeight) * 10) / 10;
      }

      out.push({
        ...p,
        active_pcts: activePcts,
        active_score: activeScore,
      });
    }

    return { rows: out, baseline };
  }

  // ---- Customize Role Score <dialog> (F12) ----

  function renderScoreDialog() {
    const dataset = activeDataset();
    if (!dataset || !state.scoreConfig) return;

    const catalog = getMetricCatalog(dataset);
    const cfg = state.scoreConfig;
    const method = cfg.method || "percentile";
    els.scoreMethod.value = method;
    els.scoreMethodHint.textContent = METHOD_HINTS[method] || "";
    els.scorePresetPos.textContent = dataset.position;
    els.scoreDialogSubtitle.textContent = `${POS_LABELS[dataset.position]} · ${catalog.list.length} metrics available`;

    // Populate preset select
    const presets = getPosPresets(dataset.position);
    els.scorePresetSelect.innerHTML = [
      `<option value="">— Select saved preset —</option>`,
      ...presets.map((pr) => `<option value="${escapeHtml(pr.id)}">${escapeHtml(pr.name)}</option>`),
    ].join("");
    els.scorePresetSelect.value = cfg.presetId && presets.some((p) => p.id === cfg.presetId) ? cfg.presetId : "";
    const activePreset = presets.find((p) => p.id === els.scorePresetSelect.value);
    els.scoreRenamePresetBtn.disabled = !activePreset;
    els.scoreDeletePresetBtn.disabled = !activePreset;
    if (activePreset && document.activeElement !== els.scorePresetName) {
      els.scorePresetName.value = activePreset.name;
    }

    // Category filter options (preserve selection)
    const prevCat = els.scoreCategoryFilter.value || "all";
    const categories = ["Position Defaults", ...new Set(catalog.list.map((m) => m.category).filter((c) => c !== "Position Defaults"))];
    els.scoreCategoryFilter.innerHTML = [
      `<option value="all">All Categories (${catalog.list.length})</option>`,
      ...categories.map((c) => `<option value="${escapeHtml(c)}">${escapeHtml(c)}</option>`),
    ].join("");
    if ([...els.scoreCategoryFilter.options].some((o) => o.value === prevCat)) {
      els.scoreCategoryFilter.value = prevCat;
    }

    const enabledItems = cfg.metrics.filter((m) => m.enabled);
    const totalWeight = enabledItems.reduce((s, m) => s + m.weight, 0);
    els.scoreTotalWeight.textContent = `Enabled: ${enabledItems.length} · Total weight: ${totalWeight.toFixed(1)}`;

    const query = els.scoreMetricSearch.value.trim().toLowerCase();
    const catFilter = els.scoreCategoryFilter.value;
    const enabledOnly = els.scoreEnabledOnly.checked;

    const cfgByKey = new Map(cfg.metrics.map((m) => [m.key, m]));
    const orderedGroups = [];
    const seenKeys = new Set();

    const defaultGroupItems = [];
    for (const m of dataset.metrics || []) {
      const catMeta = catalog.byKey.get(m.key);
      if (!catMeta || seenKeys.has(m.key)) continue;
      seenKeys.add(m.key);
      defaultGroupItems.push(catMeta);
    }
    orderedGroups.push({ title: "Position Defaults", items: defaultGroupItems });

    const byCat = new Map();
    for (const catMeta of catalog.list) {
      if (seenKeys.has(catMeta.key)) continue;
      seenKeys.add(catMeta.key);
      if (!byCat.has(catMeta.category)) byCat.set(catMeta.category, []);
      byCat.get(catMeta.category).push(catMeta);
    }
    for (const [catName, items] of byCat.entries()) {
      orderedGroups.push({ title: catName, items });
    }

    const html = [];
    for (const grp of orderedGroups) {
      if (catFilter !== "all" && grp.title !== catFilter) continue;
      const visibleItems = grp.items.filter((catMeta) => {
        const cfgItem = cfgByKey.get(catMeta.key);
        if (!cfgItem) return false;
        if (enabledOnly && !cfgItem.enabled) return false;
        if (query && !catMeta.label.toLowerCase().includes(query) && !catMeta.key.toLowerCase().includes(query)) {
          return false;
        }
        return true;
      });
      if (!visibleItems.length) continue;

      html.push(`<div class="score-group-header">${escapeHtml(grp.title)}</div>`);
      for (const catMeta of visibleItems) {
        const cfgItem = cfgByKey.get(catMeta.key);
        const share =
          cfgItem.enabled && totalWeight > 0 ? ((cfgItem.weight / totalWeight) * 100).toFixed(1) : "0.0";
        const isDefault = catalog.defaultKeys.has(catMeta.key);
        html.push(`
          <div class="score-metric-row ${cfgItem.enabled ? "" : "is-disabled"}" data-key="${escapeHtml(catMeta.key)}">
            <input type="checkbox" class="score-enable-cb" ${cfgItem.enabled ? "checked" : ""} aria-label="Enable ${escapeHtml(catMeta.label)}">
            <div class="score-metric-name">
              <span>${escapeHtml(catMeta.label)}</span>
              ${isDefault ? `<span class="score-default-tag">Default</span>` : ""}
            </div>
            <button type="button" class="score-dir-btn" aria-pressed="${cfgItem.higher_is_better}" title="Toggle scoring direction">
              ${cfgItem.higher_is_better ? "Higher ↑" : "Lower ↓"}
            </button>
            <div class="score-weight-controls">
              <input type="range" class="score-weight-slider" min="0" max="5" step="0.5" value="${cfgItem.weight}" ${cfgItem.enabled ? "" : "disabled"} aria-label="${escapeHtml(catMeta.label)} weight slider">
              <input type="number" class="score-weight-num" min="0" max="5" step="0.1" value="${cfgItem.weight}" ${cfgItem.enabled ? "" : "disabled"} aria-label="${escapeHtml(catMeta.label)} weight value">
              <span class="score-share-badge">${share}%</span>
            </div>
          </div>
        `);
      }
    }

    els.scoreMetricsList.innerHTML = html.length
      ? html.join("")
      : `<div class="popover-empty">No metrics match your filter.</div>`;

    renderScorePreview(dataset);
  }

  function renderScorePreview(dataset) {
    const { rows } = computePoolRows(dataset);
    const pool = rows.length ? rows : dataset.players.map((p) => ({ ...p, active_score: 0 }));
    const sorted = [...pool].sort((a, b) => b.active_score - a.active_score).slice(0, 5);
    els.scorePreviewNote.textContent = rows.length
      ? `Top 5 of ${rows.length.toLocaleString()} matching players`
      : `Filtered pool empty — showing dataset sample`;

    els.scorePreviewList.innerHTML = sorted
      .map(
        (p, idx) => `
        <div class="score-preview-item">
          <div class="score-preview-meta">
            <div class="score-preview-name">#${idx + 1} ${escapeHtml(playerName(p))}</div>
            <div class="score-preview-sub">${escapeHtml(clubNameOf(p))} · Age ${p.age ?? "?"} · ${p.minutes}m</div>
          </div>
          <span class="pct-pill pct-elite">${Number(p.active_score ?? 0).toFixed(1)}</span>
        </div>
      `
      )
      .join("");
  }

  function updateScoreSharesInPlace(dataset) {
    const cfg = state.scoreConfig;
    const enabledItems = cfg.metrics.filter((m) => m.enabled);
    const totalWeight = enabledItems.reduce((s, m) => s + m.weight, 0);
    els.scoreTotalWeight.textContent = `Enabled: ${enabledItems.length} · Total weight: ${totalWeight.toFixed(1)}`;
    const cfgByKey = new Map(cfg.metrics.map((m) => [m.key, m]));
    els.scoreMetricsList.querySelectorAll(".score-metric-row").forEach((row) => {
      const item = cfgByKey.get(row.dataset.key);
      const badge = row.querySelector(".score-share-badge");
      if (item && badge) {
        const share = item.enabled && totalWeight > 0 ? ((item.weight / totalWeight) * 100).toFixed(1) : "0.0";
        badge.textContent = `${share}%`;
      }
    });
    renderScorePreview(dataset);
  }

  function markScoreCustomDraft() {
    const dataset = activeDataset();
    if (!dataset || !state.scoreConfig) return;
    state.scoreConfig.roleSlug = "__custom_draft__";
    state.scoreConfig.presetId = null;
    refreshRoleSelectOptions(dataset, "__custom_draft__");
    els.scorePresetSelect.value = "";
    els.scoreRenamePresetBtn.disabled = true;
    els.scoreDeletePresetBtn.disabled = true;
  }

  function scheduleBackgroundRefresh(immediate = false) {
    clearTimeout(state.scoreSyncTimer);
    if (state.scoreSyncRaf) cancelAnimationFrame(state.scoreSyncRaf);
    if (immediate) {
      refreshView();
      return;
    }
    state.scoreSyncTimer = setTimeout(() => {
      state.scoreSyncRaf = requestAnimationFrame(() => {
        refreshView();
      });
    }, 60);
  }

  function wireScoreDialogEvents() {
    enableLightDismissFallback(els.scoreDialog);

    els.btnCustomizeScore.addEventListener("click", () => {
      renderScoreDialog();
      els.scoreDialog.showModal();
    });

    els.scoreCloseBtn.addEventListener("click", () => {
      els.scoreDialog.close();
    });

    els.scoreResetBtn.addEventListener("click", () => {
      const dataset = activeDataset();
      if (!dataset) return;
      const baseRole = state.scoreConfig?.roleSlug?.startsWith("custom:")
        ? state.scoreConfig.roleSlug
        : dataset.roles?.[state.scoreConfig?.roleSlug]
          ? state.scoreConfig.roleSlug
          : "overall";
      state.scoreConfig = buildScoreConfigFromRole(dataset, baseRole, "percentile");
      refreshRoleSelectOptions(dataset, state.scoreConfig.roleSlug);
      renderScoreDialog();
      scheduleBackgroundRefresh(true);
      showToast("Role score reset");
    });

    els.scoreMethod.addEventListener("change", () => {
      if (!state.scoreConfig) return;
      state.scoreConfig.method = els.scoreMethod.value;
      els.scoreMethodHint.textContent = METHOD_HINTS[state.scoreConfig.method] || "";
      if (state.scoreConfig.roleSlug !== "__custom_draft__" && !state.scoreConfig.roleSlug.startsWith("custom:")) {
        // Keep built-in role selected or mark draft? Preserving method for built-in role is clean and intuitive
      }
      const dataset = activeDataset();
      if (dataset) renderScorePreview(dataset);
      scheduleBackgroundRefresh(true);
    });

    els.scoreMetricSearch.addEventListener("input", renderScoreDialog);
    els.scoreCategoryFilter.addEventListener("change", renderScoreDialog);
    els.scoreEnabledOnly.addEventListener("change", renderScoreDialog);

    els.scoreMetricsList.addEventListener("click", (ev) => {
      const row = ev.target.closest(".score-metric-row");
      if (!row || !state.scoreConfig) return;
      const item = state.scoreConfig.metrics.find((m) => m.key === row.dataset.key);
      if (!item) return;

      const dirBtn = ev.target.closest(".score-dir-btn");
      if (dirBtn) {
        item.higher_is_better = !item.higher_is_better;
        dirBtn.setAttribute("aria-pressed", String(item.higher_is_better));
        dirBtn.textContent = item.higher_is_better ? "Higher ↑" : "Lower ↓";
        markScoreCustomDraft();
        const dataset = activeDataset();
        if (dataset) renderScorePreview(dataset);
        scheduleBackgroundRefresh(true);
      }
    });

    els.scoreMetricsList.addEventListener("change", (ev) => {
      const row = ev.target.closest(".score-metric-row");
      if (!row || !state.scoreConfig) return;
      const item = state.scoreConfig.metrics.find((m) => m.key === row.dataset.key);
      const dataset = activeDataset();
      if (!item || !dataset) return;

      if (ev.target.classList.contains("score-enable-cb")) {
        item.enabled = ev.target.checked;
        row.classList.toggle("is-disabled", !item.enabled);
        const slider = row.querySelector(".score-weight-slider");
        const num = row.querySelector(".score-weight-num");
        if (slider) slider.disabled = !item.enabled;
        if (num) num.disabled = !item.enabled;
        markScoreCustomDraft();
        updateScoreSharesInPlace(dataset);
        scheduleBackgroundRefresh(true);
      } else if (ev.target.classList.contains("score-weight-num") || ev.target.classList.contains("score-weight-slider")) {
        const val = Math.max(0, Math.min(5, Number(ev.target.value) || 0));
        item.weight = val;
        const slider = row.querySelector(".score-weight-slider");
        const num = row.querySelector(".score-weight-num");
        if (slider) slider.value = String(val);
        if (num) num.value = String(val);
        markScoreCustomDraft();
        updateScoreSharesInPlace(dataset);
        scheduleBackgroundRefresh(true);
      }
    });

    els.scoreMetricsList.addEventListener("input", (ev) => {
      if (!ev.target.classList.contains("score-weight-slider")) return;
      const row = ev.target.closest(".score-metric-row");
      if (!row || !state.scoreConfig) return;
      const item = state.scoreConfig.metrics.find((m) => m.key === row.dataset.key);
      const dataset = activeDataset();
      if (!item || !dataset) return;

      const val = Math.max(0, Math.min(5, Number(ev.target.value) || 0));
      item.weight = val;
      const num = row.querySelector(".score-weight-num");
      if (num) num.value = String(val);
      markScoreCustomDraft();
      updateScoreSharesInPlace(dataset);
      scheduleBackgroundRefresh(false);
    });

    els.scorePresetSelect.addEventListener("change", () => {
      const dataset = activeDataset();
      if (!dataset) return;
      const id = els.scorePresetSelect.value;
      if (!id) {
        els.scoreRenamePresetBtn.disabled = true;
        els.scoreDeletePresetBtn.disabled = true;
        return;
      }
      state.scoreConfig = buildScoreConfigFromRole(dataset, `custom:${id}`);
      refreshRoleSelectOptions(dataset, `custom:${id}`);
      renderScoreDialog();
      scheduleBackgroundRefresh(true);
    });

    els.scoreSavePresetBtn.addEventListener("click", () => {
      const dataset = activeDataset();
      if (!dataset || !state.scoreConfig) return;
      const pos = dataset.position;
      const existing = getPosPresets(pos);
      const rawName = els.scorePresetName.value.trim() || `Custom ${pos} ${existing.length + 1}`;
      const id = `p_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`;
      const enabledMetrics = state.scoreConfig.metrics
        .filter((m) => m.enabled)
        .map((m) => ({ key: m.key, weight: m.weight, higher_is_better: m.higher_is_better }));
      if (!enabledMetrics.length) {
        showToast("Enable at least one metric to save a preset");
        return;
      }
      const newPreset = {
        id,
        name: rawName,
        method: state.scoreConfig.method || "percentile",
        metrics: enabledMetrics,
      };
      if (!state.presets[pos]) state.presets[pos] = [];
      state.presets[pos].push(newPreset);
      savePresets();
      state.scoreConfig = buildScoreConfigFromRole(dataset, `custom:${id}`);
      refreshRoleSelectOptions(dataset, `custom:${id}`);
      renderScoreDialog();
      scheduleBackgroundRefresh(true);
      showToast(`Saved preset "${rawName}"`);
    });

    els.scoreRenamePresetBtn.addEventListener("click", () => {
      const dataset = activeDataset();
      if (!dataset) return;
      const id = els.scorePresetSelect.value;
      const newName = els.scorePresetName.value.trim();
      if (!id || !newName) {
        showToast("Enter a preset name to rename");
        return;
      }
      const preset = getPosPresets(dataset.position).find((p) => p.id === id);
      if (!preset) return;
      preset.name = newName;
      savePresets();
      refreshRoleSelectOptions(dataset, `custom:${id}`);
      renderScoreDialog();
      showToast(`Renamed preset to "${newName}"`);
    });

    els.scoreDeletePresetBtn.addEventListener("click", () => {
      const dataset = activeDataset();
      if (!dataset) return;
      const id = els.scorePresetSelect.value;
      if (!id) return;
      const list = getPosPresets(dataset.position);
      const target = list.find((p) => p.id === id);
      state.presets[dataset.position] = list.filter((p) => p.id !== id);
      savePresets();
      els.scorePresetName.value = "";
      state.scoreConfig = buildScoreConfigFromRole(dataset, "overall", state.scoreConfig?.method);
      refreshRoleSelectOptions(dataset, "overall");
      renderScoreDialog();
      scheduleBackgroundRefresh(true);
      if (target) showToast(`Deleted preset "${target.name}"`);
    });
  }

  // ---- ECharts Scatter Plot (F13) ----

  function ensureScatterChart() {
    if (state.scatterChart || !window.echarts || !els.scatterChart) return;
    state.scatterChart = window.echarts.init(els.scatterChart, null, { renderer: "canvas" });
    state.scatterChart.on("click", (params) => {
      const player = params?.data?.player;
      const ds = activeDataset();
      if (player && ds) openPlayerDialog(player, ds);
    });
    if ("ResizeObserver" in window) {
      state.scatterResizeObs = new ResizeObserver(() => {
        if (state.scatterResizeRaf) cancelAnimationFrame(state.scatterResizeRaf);
        state.scatterResizeRaf = requestAnimationFrame(() => {
          state.scatterChart?.resize();
        });
      });
      state.scatterResizeObs.observe(els.scatterChart);
    }
  }

  function renderScatter(dataset) {
    ensureScatterChart();
    if (!state.scatterChart) return;

    const catalog = getMetricCatalog(dataset);
    const xKey = els.scatterX.value;
    const yKey = els.scatterY.value;
    const xMeta = catalog.byKey.get(xKey) || dataset.metrics[0];
    const yMeta = catalog.byKey.get(yKey) || dataset.metrics[1];

    const theme = getThemeColors();
    const benchUid = els.benchmark.value;

    const others = [];
    const hull = [];
    let sumX = 0;
    let sumY = 0;
    let minX = Infinity;
    let maxX = -Infinity;
    let minY = Infinity;
    let maxY = -Infinity;

    for (const p of state.filtered) {
      const x = Number(p[xKey]) || 0;
      const y = Number(p[yKey]) || 0;
      sumX += x;
      sumY += y;
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;

      const isBench = p.uid === benchUid;
      const pt = {
        value: [x, y],
        player: p,
        isBench,
      };
      if (p.is_hull) {
        pt.itemStyle = isBench
          ? { borderColor: theme.text, borderWidth: 2.5 }
          : { borderColor: theme.surface, borderWidth: 1.5 };
        hull.push(pt);
      } else {
        others.push(pt);
      }
    }

    const totalCount = others.length + hull.length;
    const avgX = totalCount ? sumX / totalCount : 0;
    const avgY = totalCount ? sumY / totalCount : 0;
    if (!totalCount) {
      minX = 0;
      maxX = 1;
      minY = 0;
      maxY = 1;
    }

    const spanX = maxX - minX || 1;
    const spanY = maxY - minY || 1;
    const padMinX = minX - spanX * 0.04;
    const padMaxX = maxX + spanX * 0.04;
    const padMinY = minY - spanY * 0.04;
    const padMaxY = maxY + spanY * 0.04;

    const xStart = xMeta.higher_is_better ? avgX : padMinX;
    const xEnd = xMeta.higher_is_better ? padMaxX : avgX;
    const yStart = yMeta.higher_is_better ? avgY : padMinY;
    const yEnd = yMeta.higher_is_better ? padMaxY : avgY;

    const markLine = totalCount
      ? {
          silent: true,
          symbol: ["none", "none"],
          lineStyle: { color: theme.muted, type: "dashed", width: 1.2 },
          label: {
            color: theme.muted,
            fontSize: 10,
            formatter: (param) =>
              param.data.xAxis !== undefined
                ? `Avg ${formatStat(xKey, avgX)}`
                : `Avg ${formatStat(yKey, avgY)}`,
          },
          data: [{ xAxis: avgX }, { yAxis: avgY }],
        }
      : undefined;

    const markArea = totalCount
      ? {
          silent: true,
          itemStyle: { color: theme.quadrantFill },
          label: {
            show: true,
            position: "insideTopRight",
            color: theme.accent,
            fontSize: 10,
            fontWeight: 700,
          },
          data: [[{ name: "Elite Quadrant", coord: [xStart, yStart] }, { coord: [xEnd, yEnd] }]],
        }
      : undefined;

    const attachMarksToFirst = others.length > 0;
    const clubLabel = state.meta?.club_short_name || "Managed Club";

    const option = {
      animationDuration: 220,
      grid: { left: 60, right: 28, top: 44, bottom: 48 },
      legend: {
        top: 8,
        left: 14,
        textStyle: { color: theme.text, fontSize: 12 },
      },
      toolbox: {
        right: 12,
        top: 6,
        iconStyle: { borderColor: theme.muted },
        feature: {
          dataZoom: { title: { zoom: "Box Zoom", back: "Undo Zoom" } },
          restore: { title: "Reset Zoom" },
        },
      },
      dataZoom: [
        { type: "inside", xAxisIndex: 0, filterMode: "none" },
        { type: "inside", yAxisIndex: 0, filterMode: "none" },
      ],
      tooltip: {
        trigger: "item",
        confine: true,
        backgroundColor: theme.surface,
        borderColor: theme.border,
        borderWidth: 1,
        textStyle: { color: theme.text, fontSize: 12 },
        formatter: (params) => {
          const p = params?.data?.player;
          if (!p) return "";
          const name = escapeHtml(playerName(p));
          const club = escapeHtml(clubNameOf(p));
          return `
            <div class="scatter-tt">
              <div class="scatter-tt-head">
                <img class="scatter-tt-avatar" src="${personImgUrl(p)}" alt="">
                <div>
                  <strong>${name}</strong> (Age ${escapeHtml(p.age ?? "?")})<br>
                  <span class="scatter-tt-club">
                    <img class="scatter-tt-crest" src="${clubImgUrl(p.club_img_id || p.club_uid, clubNameOf(p))}" alt="">
                    ${club} · ${escapeHtml(p.league || "")}
                  </span>
                </div>
              </div>
              <div>
                ${escapeHtml(xMeta.label)}: <strong>${formatStat(xKey, p[xKey])}</strong><br>
                ${escapeHtml(yMeta.label)}: <strong>${formatStat(yKey, p[yKey])}</strong>
              </div>
              <div>Value: ${formatMoney(p.value)} · Score: <strong>${Number(p.active_score ?? 0).toFixed(1)}</strong></div>
            </div>
          `;
        },
      },
      xAxis: {
        type: "value",
        name: xMeta.label,
        nameLocation: "middle",
        nameGap: 28,
        nameTextStyle: { color: theme.text, fontWeight: 700, fontSize: 12 },
        axisLabel: { color: theme.muted, fontSize: 11, formatter: (v) => formatStat(xKey, v) },
        splitLine: { lineStyle: { color: theme.gridLine } },
        scale: true,
      },
      yAxis: {
        type: "value",
        name: yMeta.label,
        nameLocation: "middle",
        nameGap: 44,
        nameTextStyle: { color: theme.text, fontWeight: 700, fontSize: 12 },
        axisLabel: { color: theme.muted, fontSize: 11, formatter: (v) => formatStat(yKey, v) },
        splitLine: { lineStyle: { color: theme.gridLine } },
        scale: true,
      },
      series: [
        {
          name: "Target Pool",
          type: "scatter",
          large: true,
          largeThreshold: 2000,
          progressive: 0,
          symbolSize: 8,
          itemStyle: { color: theme.poolDot, opacity: 0.9 },
          // ECharts emphasis can make a hovered point miss the next click.
          emphasis: { disabled: true },
          z: 2,
          data: others,
          markLine: attachMarksToFirst ? markLine : undefined,
          markArea: attachMarksToFirst ? markArea : undefined,
        },
        {
          name: clubLabel,
          type: "scatter",
          large: false,
          emphasis: { disabled: true },
          symbol: "diamond",
          symbolSize: (val, params) => (params?.data?.isBench ? 15 : 12),
          itemStyle: { color: theme.accent, opacity: 1 },
          label: {
            show: true,
            position: "right",
            formatter: (params) => playerName(params?.data?.player),
            color: theme.accent,
            fontWeight: 700,
            fontSize: 11,
          },
          labelLayout: { hideOverlap: true },
          z: 6,
          data: hull,
          markLine: !attachMarksToFirst && hull.length ? markLine : undefined,
          markArea: !attachMarksToFirst && hull.length ? markArea : undefined,
        },
      ],
    };

    state.scatterChart.setOption(option, { notMerge: true });
  }

  // ---- ECharts Profile Radar & Progression (F14) ----

  function renderRadar(player, comparePlayer, dataset, baseline, clubLabel) {
    if (!window.echarts || !els.radarChart) return;
    if (!state.radarChart) {
      state.radarChart = window.echarts.init(els.radarChart, null, { renderer: "canvas" });
    }
    state.radarChart.resize();

    const theme = getThemeColors();
    const metrics = dataset.metrics || [];
    const indicators = metrics.map((m) => ({
      name: m.label.replace(" / 90", ""),
      min: 0,
      max: 100,
    }));

    const playerValues = metrics.map((m) => getPlayerMetricPct(player, m.key, dataset, baseline));
    const seriesData = [
      {
        value: playerValues,
        name: playerName(player),
        symbol: "circle",
        areaStyle: { color: theme.accent, opacity: 0.28 },
        lineStyle: { color: theme.accent, width: 2.5 },
        itemStyle: { color: theme.accent },
      },
    ];

    if (comparePlayer) {
      const cmpValues = metrics.map((m) => getPlayerMetricPct(comparePlayer, m.key, dataset, baseline));
      seriesData.push({
        value: cmpValues,
        name: `${playerName(comparePlayer)} (${clubLabel})`,
        symbol: "diamond",
        areaStyle: { color: theme.compare, opacity: 0.2 },
        lineStyle: { color: theme.compare, width: 2.5, type: "dashed" },
        itemStyle: { color: theme.compare },
      });
    }

    state.radarChart.setOption(
      {
        animationDuration: 200,
        tooltip: {
          trigger: "item",
          confine: true,
          backgroundColor: theme.surface,
          borderColor: theme.border,
          textStyle: { color: theme.text, fontSize: 12 },
        },
        legend: {
          bottom: 4,
          textStyle: { color: theme.text, fontSize: 11 },
        },
        radar: {
          radius: "62%",
          center: ["50%", "47%"],
          indicator: indicators,
          splitNumber: 5,
          axisName: { color: theme.text, fontSize: 10, fontWeight: 600 },
          splitLine: { lineStyle: { color: theme.gridLine } },
          splitArea: { areaStyle: { color: ["transparent"] } },
          axisLine: { lineStyle: { color: theme.gridLine } },
        },
        series: [
          {
            type: "radar",
            symbolSize: 5,
            data: seriesData,
          },
        ],
      },
      { notMerge: true }
    );
  }

  async function renderPlayerProgression(player, position, season, openToken) {
    if (state.seasons.length < 2) {
      els.progressionChart.hidden = true;
      els.dialogProgressionEmpty.hidden = false;
      els.dialogProgressionEmpty.textContent = `One season available (${season || "current"}).`;
      return;
    }

    els.progressionChart.hidden = true;
    els.dialogProgressionEmpty.hidden = false;
    els.dialogProgressionEmpty.textContent = "Loading past seasons...";

    const history = [];
    for (const entry of state.seasons) {
      try {
        const ds = await loadPosition(position, entry.season);
        const match = ds.players.find((p) => p.uid === player.uid);
        if (match) history.push({ season: entry.season, row: match });
      } catch {
        // Skip unavailable season
      }
    }

    if (!els.playerDialog.open || state.dialogOpenToken !== openToken) return;

    history.sort((a, b) => collator.compare(a.season, b.season));
    if (history.length < 2) {
      els.progressionChart.hidden = true;
      els.dialogProgressionEmpty.hidden = false;
      els.dialogProgressionEmpty.textContent = history.length ? "One season available for this player." : "No archived progression data.";
      return;
    }

    els.dialogProgressionEmpty.hidden = true;
    els.progressionChart.hidden = false;

    if (!window.echarts) return;
    if (!state.progressionChart) {
      state.progressionChart = window.echarts.init(els.progressionChart, null, { renderer: "canvas" });
    }
    state.progressionChart.resize();

    const theme = getThemeColors();
    const isGk = position === "GK";
    const m1Key = isGk ? "xg_prevented_p90" : "npxg_p90";
    const m1Label = isGk ? "xG Prevented / 90" : "np-xG / 90";
    const m2Key = isGk ? "goals_allowed_p90" : "xa_p90";
    const m2Label = isGk ? "Goals Allowed / 90" : "xA / 90";

    const xLabels = history.map((h) => h.season);

    state.progressionChart.setOption(
      {
        animationDuration: 200,
        grid: { left: 44, right: 44, top: 32, bottom: 28 },
        legend: {
          top: 2,
          textStyle: { color: theme.text, fontSize: 11 },
        },
        tooltip: {
          trigger: "axis",
          confine: true,
          backgroundColor: theme.surface,
          borderColor: theme.border,
          textStyle: { color: theme.text, fontSize: 12 },
          formatter: (items) => {
            if (!items?.length) return "";
            const idx = items[0].dataIndex;
            const item = history[idx];
            const r = item.row;
            return `
              <strong>${escapeHtml(item.season)}</strong> (${escapeHtml(clubNameOf(r))})<br>
              Mins: ${r.minutes} · Avg Rating: <strong>${Number(r.avg_rating || 0).toFixed(2)}</strong><br>
              ${escapeHtml(m1Label)}: ${formatStat(m1Key, r[m1Key])} · ${escapeHtml(m2Label)}: ${formatStat(m2Key, r[m2Key])}<br>
              Overall Score: <strong>${Number(r.score_overall || 0).toFixed(1)}</strong>
            `;
          },
        },
        xAxis: {
          type: "category",
          data: xLabels,
          axisLabel: { color: theme.muted, fontSize: 11 },
          axisLine: { lineStyle: { color: theme.border } },
        },
        yAxis: [
          {
            type: "value",
            name: "Per-90",
            nameTextStyle: { color: theme.muted, fontSize: 10 },
            axisLabel: { color: theme.muted, fontSize: 10 },
            splitLine: { lineStyle: { color: theme.gridLine } },
          },
          {
            type: "value",
            name: "Score",
            min: 0,
            max: 100,
            nameTextStyle: { color: theme.muted, fontSize: 10 },
            axisLabel: { color: theme.muted, fontSize: 10 },
            splitLine: { show: false },
          },
        ],
        series: [
          {
            name: m1Label,
            type: "line",
            yAxisIndex: 0,
            smooth: true,
            symbolSize: 7,
            itemStyle: { color: theme.accent },
            data: history.map((h) => Number(h.row[m1Key]) || 0),
          },
          {
            name: m2Label,
            type: "line",
            yAxisIndex: 0,
            smooth: true,
            symbolSize: 7,
            itemStyle: { color: theme.compare },
            data: history.map((h) => Number(h.row[m2Key]) || 0),
          },
          {
            name: "Overall Score",
            type: "line",
            yAxisIndex: 1,
            smooth: true,
            symbolSize: 7,
            lineStyle: { type: "dashed" },
            itemStyle: { color: "#16a34a" },
            data: history.map((h) => Number(h.row.score_overall) || 0),
          },
        ],
      },
      { notMerge: true }
    );
  }

  function renderProfileFacts(element, facts) {
    element.innerHTML = facts.map(([label, value]) =>
      `<div><dt>${escapeHtml(label)}</dt><dd>${escapeHtml(value ?? "—")}</dd></div>`
    ).join("");
  }

  function openPlayerDialog(player, dataset, season = state.season) {
    state.activeProfile = { player, dataset, season };
    state.dialogOpenToken += 1;
    const openToken = state.dialogOpenToken;

    els.dialogPlayerImg.src = personImgUrl(player);
    els.dialogPlayerImg.alt = playerName(player);
    els.dialogClubImg.src = clubImgUrl(player.club_img_id || player.club_uid, clubNameOf(player));
    els.dialogClubImg.alt = clubNameOf(player);
    els.dialogName.textContent = playerName(player);
    els.dialogCopyName.disabled = !player.name;
    els.dialogMeta.textContent = [clubNameOf(player), player.league].filter(Boolean).join(" · ");
    renderProfileFacts(els.dialogProfileFacts, [
      ["Age", player.age],
      ["Nationality", player.nation || "—"],
      ["Height", player.height_cm > 0 ? `${player.height_cm} cm` : "—"],
      ["Preferred Foot", player.foot || "—"],
      ["Natural Positions", parsePlayerPositions(player.positions).join(", ") || "—"],
      ["Transfer Value", formatMoney(player.value)],
      ["Weekly Wage", formatMoney(player.wage)],
      ["Contract Ends", player.contract_end || "—"],
      ...(player.on_loan ? [["On Loan From", player.loan_parent || "—"]] : []),
    ]);

    const seasonLabel = season || state.meta?.season;
    els.dialogSeasonHeading.textContent = seasonLabel ? `League Season Stats · ${seasonLabel}` : "League Season Stats";
    const seasonStats = [
      ["apps", "Appearances"], ["starts", "Starts"], ["minutes", "Minutes"],
      ["goals", "Goals"], ["assists", "Assists"], ["avg_rating", "Average Rating"],
    ];
    if (dataset?.position === "GK") {
      seasonStats.push(["save_pct", "Save %"], ["clean_sheet_pct", "Clean Sheet %"]);
    }
    const hasSeasonStats = player.minutes != null;
    els.dialogSeasonEmpty.hidden = hasSeasonStats;
    els.dialogSeasonStats.hidden = !hasSeasonStats;
    renderProfileFacts(els.dialogSeasonStats, seasonStats.map(([key, label]) => [
      label, formatStat(key, player[key]),
    ]));

    const isSaved = Boolean(state.shortlist[player.uid]);
    els.dialogShortlistBtn.textContent = isSaved ? "Remove from Shortlist" : "Add to Shortlist";
    els.dialogRadarPanel.hidden = !dataset;
    els.dialogProfileMetrics.hidden = !dataset;
    if (!dataset) {
      els.playerDialog.showModal();
      return;
    }

    const hullPool = dataset.players.filter((p) => p.is_hull && p.uid !== player.uid);
    const managedSquad = season === state.season ? state.meta?.hull_squad : null;
    const hullOther = (managedSquad || []).filter(
      (p) => p.uid !== player.uid && !hullPool.some((h) => h.uid === p.uid)
    );
    els.dialogCompareSelect.innerHTML = [
      `<option value="">No comparison</option>`,
      ...hullPool.map(
        (h) => `<option value="${escapeHtml(h.uid)}">${escapeHtml(playerName(h))} (${escapeHtml(h.positions)}, ${h.minutes}m)</option>`
      ),
      ...hullOther.map(
        (h) => `<option value="${escapeHtml(h.uid)}">${escapeHtml(playerName(h))} (${escapeHtml(h.positions)}, ${h.minutes}m)</option>`
      ),
    ].join("");

    const benchUid = els.benchmark.value;
    if (benchUid && benchUid !== player.uid) {
      els.dialogCompareSelect.value = benchUid;
    }

    const scalar = readScalarFilters();
    const baseline = getBaselinePool(dataset, scalar.minMins, scalar.minRep, scalar.dynamicPct);

    const drawCompare = () => {
      const cid = els.dialogCompareSelect.value;
      const cmp = hullPool.find((h) => h.uid === cid) || hullOther.find((h) => h.uid === cid) || null;
      const clubLabel = season === state.season ? state.meta?.club_short_name || "Club" : clubNameOf(cmp);
      renderRadar(player, cmp, dataset, baseline, clubLabel);
    };
    els.dialogCompareSelect.onchange = drawCompare;

    els.dialogStatsList.innerHTML = (dataset.metrics || [])
      .map((m) => {
        const pct = getPlayerMetricPct(player, m.key, dataset, baseline);
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

    els.progressionChart.hidden = true;
    els.dialogProgressionEmpty.hidden = true;
    els.playerDialog.showModal();

    requestAnimationFrame(() => {
      if (!els.playerDialog.open || state.dialogOpenToken !== openToken) return;
      drawCompare();
      renderPlayerProgression(player, dataset.position, season, openToken);
    });
  }

  // ---- Tabulator Table & Column Chooser (F15) ----

  function toggleRowShortlist(player, position = state.pos, season = state.season) {
    const uid = player.uid;
    const name = playerName(player);
    if (state.shortlist[uid]) {
      delete state.shortlist[uid];
      saveShortlist();
      showToast(`Removed ${name} from shortlist`);
      return false;
    }
    state.shortlist[uid] = {
      uid,
      name: player.name ?? "",
      club: clubNameOf(player),
      age: player.age,
      positions: player.positions,
      minutes: player.minutes,
      value: player.value,
      wage: player.wage,
      contract_end: player.contract_end,
      pos_group: position,
      season,
      ...(position ? {} : { profile: player }),
    };
    saveShortlist();
    showToast(`Added ${name} to shortlist`);
    return true;
  }

  function buildTabulatorColumns(dataset) {
    const pos = dataset.position;
    const savedCols = state.colPrefs?.[pos] || {};
    const catalog = getMetricCatalog(dataset);
    const clubTag = state.meta?.club_short_name || "CLUB";

    const enabledExtraMetrics = (state.scoreConfig?.metrics || [])
      .filter((m) => m.enabled && !catalog.defaultKeys.has(m.key))
      .map((m) => catalog.byKey.get(m.key))
      .filter(Boolean);

    const isVisible = (field, defaultVis) =>
      Object.prototype.hasOwnProperty.call(savedCols, field) ? Boolean(savedCols[field]) : defaultVis;

    const cols = [
      {
        title: "Player",
        field: "name",
        frozen: true,
        width: 245,
        minWidth: 190,
        hozAlign: "left",
        headerHozAlign: "left",
        sorter: "string",
        sorterParams: { alignEmptyValues: "bottom" },
        formatter: (cell) => {
          const p = cell.getRow().getData();
          const isSaved = Boolean(state.shortlist[p.uid]);
          const badge = p.is_hull ? `<span class="hull-badge">${escapeHtml(clubTag)}</span>` : "";
          return `
            <div class="tab-player-cell">
              <button type="button" class="row-star-btn ${isSaved ? "is-saved" : ""}" data-uid="${escapeHtml(
            p.uid
          )}" aria-pressed="${isSaved}" aria-label="${isSaved ? "Remove from shortlist" : "Add to shortlist"}">${
            isSaved ? "★" : "☆"
          }</button>
              <img class="tab-avatar" src="${personImgUrl(p)}" alt="" width="26" height="26" loading="lazy" decoding="async">
              <button type="button" class="player-link">${escapeHtml(playerName(p))}</button>
              ${badge}
            </div>
          `;
        },
        cellClick: (e, cell) => {
          const starBtn = e.target.closest(".row-star-btn");
          if (starBtn) {
            e.stopPropagation();
            const row = cell.getRow();
            toggleRowShortlist(row.getData());
            row.reformat();
          }
        },
      },
      {
        title: "Club",
        field: "club",
        width: 195,
        minWidth: 140,
        hozAlign: "left",
        headerHozAlign: "left",
        sorter: "string",
        sorterParams: { alignEmptyValues: "bottom" },
        visible: isVisible("club", true),
        formatter: (cell) => {
          const p = cell.getRow().getData();
          const cName = clubNameOf(p);
          return `
            <div class="tab-club-cell">
              <img class="tab-crest" src="${clubImgUrl(p.club_img_id || p.club_uid, cName)}" alt="" width="20" height="20" loading="lazy" decoding="async">
              <div class="tab-club-text">
                <span class="tab-club-name">${escapeHtml(cName)}</span>
                <span class="tab-club-league">${escapeHtml(p.league || "")}</span>
              </div>
            </div>
          `;
        },
      },
      {
        title: "Age",
        field: "age",
        width: 68,
        sorter: "number",
        visible: isVisible("age", true),
        formatter: (cell) => (cell.getValue() ?? "—"),
      },
      {
        title: "Pos",
        field: "positions",
        width: 96,
        hozAlign: "left",
        headerHozAlign: "left",
        sorter: "string",
        visible: isVisible("positions", true),
      },
      {
        title: "Nation",
        field: "nation",
        width: 112,
        hozAlign: "left",
        headerHozAlign: "left",
        sorter: "string",
        visible: isVisible("nation", false),
        formatter: (cell) => escapeHtml(cell.getValue() || "Unknown"),
      },
      {
        title: "Foot",
        field: "foot",
        width: 78,
        hozAlign: "left",
        headerHozAlign: "left",
        sorter: "string",
        visible: isVisible("foot", true),
      },
      {
        title: "League",
        field: "league",
        width: 150,
        hozAlign: "left",
        headerHozAlign: "left",
        sorter: "string",
        visible: isVisible("league", false),
      },
      {
        title: "Mins",
        field: "minutes",
        width: 78,
        sorter: "number",
        visible: isVisible("minutes", true),
      },
      {
        title: "Value",
        field: "value",
        width: 92,
        sorter: "number",
        visible: isVisible("value", true),
        formatter: (cell) => formatMoney(cell.getValue()),
      },
      {
        title: "Wage/wk",
        field: "wage",
        width: 92,
        sorter: "number",
        visible: isVisible("wage", true),
        formatter: (cell) => {
          const v = cell.getValue();
          return v ? formatMoney(v) : "—";
        },
      },
      {
        title: "Contract",
        field: "contract_end",
        width: 102,
        hozAlign: "left",
        headerHozAlign: "left",
        sorter: "string",
        visible: isVisible("contract_end", true),
        formatter: (cell) => escapeHtml(cell.getValue() || "—"),
      },
      {
        title: "Role Score",
        field: "active_score",
        width: 100,
        sorter: "number",
        cssClass: "score-cell",
        visible: isVisible("active_score", true),
        formatter: (cell) => Number(cell.getValue() ?? 0).toFixed(1),
      },
    ];

    const metricSeen = new Set();
    const metricColDefs = [];
    for (const m of dataset.metrics || []) {
      metricSeen.add(m.key);
      metricColDefs.push({ meta: m, defaultVis: true });
    }
    for (const m of enabledExtraMetrics) {
      if (metricSeen.has(m.key)) continue;
      metricSeen.add(m.key);
      metricColDefs.push({ meta: m, defaultVis: true });
    }
    if (!metricSeen.has("avg_rating") && catalog.byKey.has("avg_rating")) {
      metricSeen.add("avg_rating");
      metricColDefs.push({ meta: catalog.byKey.get("avg_rating"), defaultVis: false });
    }

    for (const { meta, defaultVis } of metricColDefs) {
      cols.push({
        title: meta.label,
        field: meta.key,
        width: 118,
        sorter: "number",
        sorterParams: { alignEmptyValues: "bottom" },
        visible: isVisible(meta.key, defaultVis),
        formatter: (cell) => {
          const p = cell.getRow().getData();
          const val = p[meta.key];
          const pct = p.active_pcts?.[meta.key];
          const pctHtml =
            pct !== undefined ? ` <span class="pct-pill ${pctClass(pct)}">${pct}</span>` : "";
          return `<span class="metric-cell-wrap">${formatStat(meta.key, val)}${pctHtml}</span>`;
        },
      });
    }

    return { cols, colSig: metricColDefs.map((c) => c.meta.key).join("|") };
  }

  async function initOrUpdateTable(dataset, rows) {
    if (!window.Tabulator) return;
    const seq = ++state.tableUpdateSeq;
    const { cols, colSig } = buildTabulatorColumns(dataset);

    if (!state.tabulatorTable) {
      const table = new window.Tabulator(els.scoutingTable, {
        data: rows,
        index: "uid",
        height: "min(640px, 72vh)",
        renderVertical: "virtual",
        renderVerticalBuffer: 120,
        rowHeight: 46,
        layout: "fitDataFill",
        sortMode: "local",
        columnHeaderSortMulti: true,
        headerSortClickElement: "header",
        placeholder: "No matching players found.",
        columnDefaults: {
          resizable: true,
          headerSortStartingDir: "desc",
          hozAlign: "right",
          headerHozAlign: "right",
          sorterParams: { alignEmptyValues: "bottom" },
        },
        initialSort: [{ column: "active_score", dir: "desc" }],
        rowFormatter: (row) => {
          const el = row.getElement();
          el.classList.toggle("is-hull", Boolean(row.getData().is_hull));
        },
        columns: cols,
      });

      state.tabulatorTable = table;
      state.lastTablePos = dataset.position;
      state.lastTableColSig = colSig;

      state.tabulatorBuiltPromise = table.initialized
        ? Promise.resolve()
        : new Promise((resolve) => {
            table.on("tableBuilt", () => {
              state.tabulatorBuilt = true;
              resolve();
            });
          });

      table.on("rowClick", (e, row) => {
        if (e.target.closest(".row-star-btn")) return;
        const ds = activeDataset();
        if (ds) openPlayerDialog(row.getData(), ds);
      });

      table.on("dataSorted", (sorters) => {
        if (!sorters?.length) return;
        const desc = sorters.map((s) => `${s.field} ${s.dir}`).join(", ");
        els.sortStatus.textContent = `Sorted by ${desc}, ${state.filtered.length} rows`;
      });

      await state.tabulatorBuiltPromise;
    } else {
      await state.tabulatorBuiltPromise;
      if (seq !== state.tableUpdateSeq) return;

      const posChanged = state.lastTablePos !== dataset.position;
      const sigChanged = state.lastTableColSig !== colSig;
      if (posChanged || sigChanged) {
        state.lastTablePos = dataset.position;
        state.lastTableColSig = colSig;
        await tableSetColumnsAndData(cols, rows, posChanged);
      } else {
        await state.tabulatorTable.replaceData(rows);
      }
    }

    if (seq === state.tableUpdateSeq) {
      els.tableCaption.textContent = `${POS_LABELS[dataset.position]} — Showing all ${rows.length.toLocaleString()} matching players`;
    }
  }

  async function tableSetColumnsAndData(cols, rows, resetSort) {
    const table = state.tabulatorTable;
    if (!table) return;
    table.setColumns(cols);
    await table.replaceData(rows);
    if (resetSort) {
      table.setSort([{ column: "active_score", dir: "desc" }]);
    }
  }

  function renderColumnChooser() {
    const table = state.tabulatorTable;
    const dataset = activeDataset();
    if (!table || !dataset) return;
    const pos = dataset.position;

    const cols = table.getColumns().filter((c) => c.getField() && c.getField() !== "name");
    els.columnChooserPopover.innerHTML = `
      <div class="popover-actions">
        <span class="popover-hint">Visible Columns (${pos})</span>
        <button type="button" class="btn-link" id="btn-reset-cols">Reset Defaults</button>
      </div>
      <div class="column-chooser-list">
        ${cols
          .map((c) => {
            const def = c.getDefinition();
            const field = c.getField();
            const visible = c.isVisible();
            return `
              <label class="column-chooser-item">
                <input type="checkbox" data-col-field="${escapeHtml(field)}" ${visible ? "checked" : ""}>
                <span>${escapeHtml(def.title || field)}</span>
              </label>
            `;
          })
          .join("")}
      </div>
    `;

    els.columnChooserPopover.querySelectorAll("input[data-col-field]").forEach((cb) => {
      cb.addEventListener("change", () => {
        const field = cb.dataset.colField;
        if (!state.colPrefs[pos]) state.colPrefs[pos] = {};
        state.colPrefs[pos][field] = cb.checked;
        saveColPrefs();
        if (cb.checked) table.showColumn(field);
        else table.hideColumn(field);
      });
    });

    const resetBtn = document.getElementById("btn-reset-cols");
    if (resetBtn) {
      resetBtn.addEventListener("click", () => {
        delete state.colPrefs[pos];
        saveColPrefs();
        const { cols: defaultCols } = buildTabulatorColumns(dataset);
        table.setColumns(defaultCols);
        renderColumnChooser();
        showToast("Table columns reset to default");
      });
    }
  }

  // ---- View Refresh & CSV Export ----

  function renderSquadProfiles() {
    const dataset = activeDataset();
    if (!dataset) return;
    const hasLocation = state.filters.leagues.size || state.filters.clubs.size;
    const showSquad = !state.filtered.length && hasLocation && !dataset.players.some((p) => matchesLocation(p));
    els.tableCountNote.textContent = state.filtered.length
      ? "Hold Shift + click column headers for multi-column sort"
      : showSquad
        ? "No players in the selected clubs or leagues have enough league minutes for scouting in this position."
        : "No players match the current scouting filters.";
    els.squadResults.hidden = !showSquad || !state.meta.has_player_search;
    if (els.squadResults.hidden) return;

    const index = ensurePlayerIndex();
    const query = normalizeSearchText(els.search.value);
    state.squadEntries = (index.entries || []).filter(({ player, groups }) =>
      groups.includes(dataset.position) && matchesLocation(player) && matchesSearch(player, query));
    state.squadEntries.sort((a, b) => collator.compare(clubNameOf(a.player), clubNameOf(b.player)) ||
      collator.compare(playerName(a.player), playerName(b.player)));
    renderSquadRows();
    if (!index.entries) {
      els.squadStatus.textContent = index.failed ? "Player profiles could not load." : "Loading player profiles…";
    }
  }

  function renderSquadRows() {
    const entries = state.squadEntries;
    const count = Math.min(entries.length, state.squadLimit);
    els.squadStatus.textContent = entries.length
      ? `${count.toLocaleString()} of ${entries.length.toLocaleString()} players in this position. Scouting limits apply to the stats table.`
      : "No squad profiles match this position and search.";
    els.squadPlayers.innerHTML = entries.slice(0, count).map(({ player }, index) => `
      <button type="button" class="player-link" data-index="${index}">
        ${escapeHtml(playerName(player))}
        <small class="subtitle">${escapeHtml(clubNameOf(player))} · ${escapeHtml(parsePlayerPositions(player.positions).join(", "))}</small>
      </button>
    `).join("");
    els.btnMoreSquad.hidden = entries.length <= count;
  }

  function refreshView() {
    const dataset = activeDataset();
    if (!dataset) return;

    const { rows, baseline } = computePoolRows(dataset);
    rows.sort((a, b) => b.active_score - a.active_score);
    state.filtered = rows;
    state.squadLimit = SQUAD_PAGE_SIZE;

    const pctMode = !baseline.isGlobal
      ? `Dynamic percentiles vs ${baseline.peerCount.toLocaleString()} peers (mins ≥ ${els.minMins.value}, rep ≥ ${els.minRep.value})`
      : `Global ≥${dataset.baseline_minutes || 900}m percentiles`;
    const clubLabel = state.meta?.club_short_name || "Managed Club";
    els.poolSummary.textContent = `${rows.length.toLocaleString()} targets matched · ${pctMode} · ${clubLabel} highlighted in amber`;

    renderAllPopovers(dataset);
    renderActiveFilterChips(dataset);
    renderSearchSuggestions();
    renderSquadProfiles();
    renderScatter(dataset);
    return initOrUpdateTable(dataset, rows);
  }

  function downloadCsv(rows, filename, dataset) {
    if (!rows.length) return;
    const cols = [
      "name",
      "club",
      "league",
      "nation",
      "foot",
      "age",
      "positions",
      "minutes",
      "apps",
      "value",
      "wage",
      "contract_end",
      "avg_rating",
      "active_score",
      ...(dataset.metrics || []).map((m) => m.key),
    ];
    const escapeCsv = (v) => {
      const s = String(v ?? "");
      return s.includes(",") || s.includes('"') ? `"${s.replaceAll('"', '""')}"` : s;
    };
    const lines = [cols.join(","), ...rows.map((r) => cols.map((c) => escapeCsv(r[c])).join(","))];
    const blob = new Blob([lines.join("\n")], { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    a.click();
    URL.revokeObjectURL(url);
    showToast(`Exported ${rows.length} rows to CSV`);
  }

  function filteredShortlist() {
    const position = els.shortlistPosition.value;
    const saved = Object.values(state.shortlist);
    return position ? saved.filter((player) => parsePlayerPositions(player.positions).includes(position)) : saved;
  }

  function renderShortlist() {
    const saved = Object.values(state.shortlist);
    const positions = [...new Set(saved.flatMap((player) => parsePlayerPositions(player.positions)))].sort(collator.compare);
    const selected = els.shortlistPosition.value;
    els.shortlistPosition.replaceChildren(new Option("All Positions", ""), ...positions.map((position) => new Option(position)));
    els.shortlistPosition.value = positions.includes(selected) ? selected : "";
    els.shortlistPosition.disabled = !positions.length;

    const items = filteredShortlist();
    els.btnExportShortlist.disabled = !items.length;
    els.btnClearShortlist.disabled = !saved.length;
    els.shortlistBody.innerHTML = items.length ? items.map((player) => `
      <div class="shortlist-item" data-uid="${escapeHtml(player.uid)}">
        <div>
          <button type="button" class="player-link" data-action="profile">${escapeHtml(playerName(player))}</button>
          · ${escapeHtml(clubNameOf(player))} · Age ${escapeHtml(player.age ?? "?")}
          · ${escapeHtml(parsePlayerPositions(player.positions).join(", ") || "—")}
          <div class="subtitle">Mins ${escapeHtml(player.minutes ?? "—")} · Value ${formatMoney(player.value)} · Wage ${
            player.wage == null ? "—" : `${formatMoney(player.wage)}/wk`
          } · Contract ${escapeHtml(player.contract_end || "—")}</div>
        </div>
        <div class="dialog-head-actions">
          <button type="button" class="btn secondary" data-action="copy-name" ${player.name ? "" : "disabled"}>Copy Name</button>
          <button type="button" class="btn secondary remove-shortlist-btn" data-action="remove">Remove</button>
        </div>
      </div>
    `).join("") : '<p class="subtitle">No players shortlisted yet. Select the star next to a player to add them.</p>';
  }

  async function openShortlistedPlayer(saved, button) {
    if (saved.profile) {
      openPlayerDialog(saved.profile, null, saved.season);
      return;
    }
    button.disabled = true;
    const seasons = new Set([state.season, saved.season ?? state.season, ...state.seasons.map((entry) => entry.season)]);
    try {
      for (const season of seasons) {
        const dataset = await loadPosition(saved.pos_group, season).catch(() => null);
        if (!els.shortlistDialog.open || !button.isConnected || els.playerDialog.open) return;
        const player = dataset?.players.find((row) => row.uid === saved.uid);
        if (player) {
          button.disabled = false;
          openPlayerDialog(player, dataset, season);
          return;
        }
      }
      showToast("No archived profile found for this player");
    } finally {
      button.disabled = false;
    }
  }

  async function selectPosition(pos, focusTab = false) {
    const request = ++state.positionRequest;
    const season = state.season;
    state.pos = pos;
    els.tablist.setAttribute("aria-busy", "true");
    els.role.disabled = true;
    els.btnCustomizeScore.disabled = true;
    for (const tab of els.tabs) {
      const selected = tab.dataset.pos === pos;
      tab.setAttribute("aria-selected", String(selected));
      tab.tabIndex = selected ? 0 : -1;
      if (selected) {
        tab.scrollIntoView({ block: "nearest", inline: "nearest" });
        if (focusTab) tab.focus();
      }
    }
    try {
      const dataset = await loadPosition(pos, season);
      if (request !== state.positionRequest || season !== state.season) return;
      populatePositionControls(dataset);
      pruneClubsBySelectedLeagues(dataset);
      await refreshView();
    } finally {
      if (request === state.positionRequest) {
        els.tablist.removeAttribute("aria-busy");
        els.role.disabled = false;
        els.btnCustomizeScore.disabled = false;
      }
    }
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

    wireSearchSuggestions();
    for (const { id } of MIN_FILTERS) els[id].addEventListener("input", refreshView);
    [
      els.minMins,
      els.maxAge,
      els.maxVal,
      els.maxWage,
      els.contract,
      els.minRep,
      els.benchmark,
      els.dynamicPct,
      els.includeHull,
    ].forEach((el) => el.addEventListener("change", refreshView));

    els.role.addEventListener("change", () => {
      const dataset = activeDataset();
      if (!dataset) return;
      const val = els.role.value;
      if (val === "__custom_draft__") return;
      state.scoreConfig = buildScoreConfigFromRole(
        dataset,
        val,
        val.startsWith("custom:") ? null : state.scoreConfig?.method || "percentile"
      );
      refreshView();
    });

    [els.scatterX, els.scatterY].forEach((el) => {
      el.addEventListener("change", () => {
        const dataset = activeDataset();
        if (dataset) renderScatter(dataset);
      });
    });

    els.btnExportScatter.addEventListener("click", () => {
      if (!state.scatterChart) return;
      const theme = getThemeColors();
      const dataUrl = state.scatterChart.getDataURL({
        type: "png",
        pixelRatio: 2,
        backgroundColor: theme.surface,
      });
      const a = document.createElement("a");
      a.href = dataUrl;
      a.download = `moneyball_scatter_${state.pos}.png`;
      a.click();
      showToast("Scatter PNG exported");
    });

    els.btnResetFilters.addEventListener("click", resetAllFilters);
    els.squadPlayers.addEventListener("click", (event) => {
      const index = event.target.closest("[data-index]")?.dataset.index;
      const entry = state.squadEntries[Number(index)];
      if (entry) openLookupProfile(entry);
    });
    els.btnMoreSquad.addEventListener("click", () => {
      const firstNewIndex = state.squadLimit;
      state.squadLimit += SQUAD_PAGE_SIZE;
      renderSquadRows();
      els.squadPlayers.children[firstNewIndex]?.focus();
    });
    els.btnMoreClubs.addEventListener("click", () => {
      const dataset = activeDataset();
      if (!dataset) return;
      const firstNewIndex = state.clubOptionLimit;
      state.clubOptionLimit += CLUB_PAGE_SIZE;
      renderFacetOptions("clubs", dataset);
      FACETS.clubs.listbox.children[firstNewIndex]?.focus();
    });

    wirePopoverBehaviors();
    wireScoreDialogEvents();

    // Global "/" search shortcut
    document.addEventListener("keydown", (ev) => {
      if (ev.key !== "/" || ev.metaKey || ev.ctrlKey || ev.altKey) return;
      if (document.querySelector("dialog[open]")) return;
      const target = ev.target;
      if (target && target.closest("input, textarea, select, [contenteditable='true']")) return;
      ev.preventDefault();
      els.search.focus();
      els.search.select();
    });

    // Dialog cleanup & light dismiss
    enableLightDismissFallback(els.playerDialog);
    enableLightDismissFallback(els.shortlistDialog);
    els.dialogCloseBtn.addEventListener("click", () => els.playerDialog.close());
    els.shortlistCloseBtn.addEventListener("click", () => els.shortlistDialog.close());

    els.playerDialog.addEventListener("close", () => {
      state.dialogOpenToken += 1;
      state.activeProfile = null;
      if (state.radarChart) {
        state.radarChart.dispose();
        state.radarChart = null;
      }
      if (state.progressionChart) {
        state.progressionChart.dispose();
        state.progressionChart = null;
      }
    });

    els.dialogCopyName.addEventListener("click", () => {
      const player = state.activeProfile?.player;
      if (player?.name) copyPlayerName(player);
    });
    els.dialogShortlistBtn.addEventListener("click", () => {
      const profile = state.activeProfile;
      if (!profile) return;
      const { player, dataset, season } = profile;
      const saved = toggleRowShortlist(player, dataset?.position || "", season);
      els.dialogShortlistBtn.textContent = saved ? "Remove from Shortlist" : "Add to Shortlist";
      state.tabulatorTable?.getRow(player.uid)?.reformat?.();
      if (els.shortlistDialog.open) renderShortlist();
    });

    els.seasonSelect.addEventListener("change", async () => {
      const season = els.seasonSelect.value || null;
      state.season = season;
      state.playerIndex = null;
      await loadMeta(season);
      if (season === state.season) await selectPosition(state.pos);
    });

    els.btnRefreshSave.addEventListener("click", () => {
      refreshFromSave(els.saveSelect.value || null);
    });

    els.btnShortlistView.addEventListener("click", () => {
      renderShortlist();
      els.shortlistDialog.showModal();
    });
    els.shortlistPosition.addEventListener("change", renderShortlist);
    els.shortlistBody.addEventListener("click", (event) => {
      const button = event.target.closest("button[data-action]");
      if (!button) return;
      const player = state.shortlist[button.closest("[data-uid]")?.dataset.uid];
      if (!player) return;
      if (button.dataset.action === "profile") openShortlistedPlayer(player, button);
      else if (button.dataset.action === "copy-name") copyPlayerName(player);
      else if (button.dataset.action === "remove") {
        delete state.shortlist[player.uid];
        saveShortlist();
        renderShortlist();
        state.tabulatorTable?.getRow(player.uid)?.reformat?.();
      }
    });
    els.btnClearShortlist.addEventListener("click", () => {
      state.shortlist = {};
      saveShortlist();
      renderShortlist();
      state.tabulatorTable?.getRows().forEach((r) => r.reformat());
      showToast("Shortlist cleared");
    });

    els.btnExportCsv.addEventListener("click", () => {
      const dataset = activeDataset();
      if (!dataset) return;
      const exportRows = state.tabulatorTable ? state.tabulatorTable.getData("active") : state.filtered;
      downloadCsv(exportRows, `moneyball_scout_${state.pos}.csv`, dataset);
    });

    els.btnExportShortlist.addEventListener("click", () => {
      const items = filteredShortlist();
      if (!items.length) return;
      const cols = ["name", "club", "age", "positions", "pos_group", "minutes", "value", "wage", "contract_end"];
      const lines = [
        cols.join(","),
        ...items.map((r) => cols.map((c) => `"${String(r[c] ?? "").replaceAll('"', '""')}"`).join(",")),
      ];
      const blob = new Blob([lines.join("\n")], { type: "text/csv;charset=utf-8" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = "moneyball_shortlist.csv";
      a.click();
      URL.revokeObjectURL(url);
      showToast("Shortlist CSV exported");
    });

    // Sync theme on OS light/dark change
    const mq = window.matchMedia("(prefers-color-scheme: dark)");
    mq.addEventListener("change", () => {
      const dataset = activeDataset();
      if (!dataset) return;
      renderScatter(dataset);
      if (els.playerDialog.open && state.activeProfile?.dataset) {
        els.dialogCompareSelect.onchange();
        if (!els.progressionChart.hidden) {
          const { player, dataset: profileDataset, season } = state.activeProfile;
          renderPlayerProgression(player, profileDataset.position, season, state.dialogOpenToken);
        }
      }
      state.tabulatorTable?.redraw(true);
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
        .map((s) => `<option value="${escapeHtml(s.path)}">${escapeHtml(s.name)} (${escapeHtml(s.modified)})</option>`)
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
      showToast("Save refreshed");
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
