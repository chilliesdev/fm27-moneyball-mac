import {
  CLUB_PAGE_SIZE,
  COLS_KEY,
  LAST_VIEW_KEY,
  LEGACY_SHORTLIST_KEY,
  PRESETS_KEY,
  SAVED_VIEWS_KEY,
  SHORTLIST_KEY,
  SQUAD_PAGE_SIZE,
  UI_PREFS_KEY,
} from "./constants.js";

export function loadJsonStorage(key, fallback) {
  try {
    const raw = localStorage.getItem(key);
    return raw ? JSON.parse(raw) : fallback;
  } catch {
    return fallback;
  }
}

export function saveJsonStorage(key, value) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // Ignore storage quota errors
  }
}

function loadShortlistWithMigration() {
  const current = loadJsonStorage(SHORTLIST_KEY, null);
  if (current && typeof current === "object") return current;
  const legacy = loadJsonStorage(LEGACY_SHORTLIST_KEY, null);
  if (legacy && typeof legacy === "object") {
    saveJsonStorage(SHORTLIST_KEY, legacy);
    return legacy;
  }
  return {};
}

export const state = {
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
  repCoverageCache: new WeakMap(),
  shortlist: loadShortlistWithMigration(),
  presets: loadJsonStorage(PRESETS_KEY, {}),
  colPrefs: loadJsonStorage(COLS_KEY, {}),
  uiPrefs: loadJsonStorage(UI_PREFS_KEY, { hidePctPills: false, tableExpanded: false }),
  savedViews: loadJsonStorage(SAVED_VIEWS_KEY, []),
  lastView: loadJsonStorage(LAST_VIEW_KEY, null),
  customDrafts: {},
  scoreDialogDirty: false,
  scoreDialogSnapshot: null,
  selectedCompareUids: new Set(),
  shortlistCompareUids: new Set(),
  popoverOrderSnapshots: new Map(),
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
  pinnedCompare: null,
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

export const els = {
  clubCrest: document.getElementById("club-crest"),
  clubTitle: document.getElementById("club-title"),
  saveMeta: document.getElementById("save-meta"),
  seasonSelect: document.getElementById("f-season"),
  saveSelect: document.getElementById("f-save"),
  btnRefreshSave: document.getElementById("btn-refresh-save"),
  refreshBanner: document.getElementById("refresh-banner"),
  refreshBannerText: document.getElementById("refresh-banner-text"),
  tablist: document.getElementById("position-tablist"),
  tabs: [...document.querySelectorAll('#position-tablist [role="tab"]')],
  search: document.getElementById("f-search"),
  btnClearSearch: document.getElementById("btn-clear-search"),
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
  filterGrid: document.getElementById("filter-grid"),
  btnToggleFilters: document.getElementById("btn-toggle-filters"),
  filterToggleMeta: document.getElementById("filter-toggle-meta"),
  btnClearDefaults: document.getElementById("btn-clear-defaults"),
  filterWarning: document.getElementById("filter-warning"),
  savedViewSelect: document.getElementById("f-saved-view"),
  btnViewsMenu: document.getElementById("btn-views-menu"),
  popSavedViews: document.getElementById("pop-saved-views"),
  viewNameInput: document.getElementById("f-view-name"),
  btnSaveView: document.getElementById("btn-save-view"),
  btnDeleteView: document.getElementById("btn-delete-view"),
  btnRestoreView: document.getElementById("btn-restore-view"),
  activeFiltersBar: document.getElementById("active-filters-bar"),
  activeFiltersChips: document.getElementById("active-filters-chips"),
  btnResetFilters: document.getElementById("btn-reset-filters"),
  poolSummary: document.getElementById("pool-summary"),
  btnToggleScatter: document.getElementById("btn-toggle-scatter"),
  scatterBody: document.getElementById("scatter-body"),
  scatterPreset: document.getElementById("scatter-preset"),
  scatterX: document.getElementById("scatter-x"),
  btnSwapAxes: document.getElementById("btn-swap-axes"),
  scatterY: document.getElementById("scatter-y"),
  btnExportScatter: document.getElementById("btn-export-scatter"),
  scatterChart: document.getElementById("scatter-chart"),
  tableCaption: document.getElementById("table-caption"),
  tableCountNote: document.getElementById("table-count-note"),
  squadResults: document.getElementById("squad-results"),
  squadStatus: document.getElementById("squad-status"),
  squadPlayers: document.getElementById("squad-players"),
  btnMoreSquad: document.getElementById("btn-more-squad"),
  btnCompareSelected: document.getElementById("btn-compare-selected"),
  compareSelectedCount: document.getElementById("compare-selected-count"),
  btnTogglePcts: document.getElementById("btn-toggle-pcts"),
  btnExpandTable: document.getElementById("btn-expand-table"),
  btnColumnChooser: document.getElementById("btn-column-chooser"),
  columnChooserPopover: document.getElementById("column-chooser-popover"),
  scoutingTable: document.getElementById("scouting-table"),
  sortStatus: document.getElementById("sort-status"),
  shortlistCount: document.getElementById("shortlist-count"),
  btnShortlistView: document.getElementById("btn-shortlist-view"),
  btnExportCsv: document.getElementById("btn-export-csv"),
  btnThemeToggle: document.getElementById("btn-theme-toggle"),
  playerDialog: document.getElementById("player-dialog"),
  dialogPlayerImg: document.getElementById("dialog-player-img"),
  dialogClubImg: document.getElementById("dialog-club-img"),
  dialogName: document.getElementById("dialog-player-name"),
  dialogScorePill: document.getElementById("dialog-score-pill"),
  dialogMeta: document.getElementById("dialog-player-meta"),
  dialogCopyName: document.getElementById("dialog-copy-name"),
  dialogPinCompare: document.getElementById("dialog-pin-compare"),
  dialogRowPos: document.getElementById("dialog-row-pos"),
  dialogPrevPlayer: document.getElementById("dialog-prev-player"),
  dialogNextPlayer: document.getElementById("dialog-next-player"),
  dialogShortlistBtn: document.getElementById("dialog-shortlist-btn"),
  dialogCloseBtn: document.getElementById("dialog-close-btn"),
  dialogCompareSelect: document.getElementById("dialog-compare-select"),
  dialogCompareSearch: document.getElementById("dialog-compare-search"),
  radarChart: document.getElementById("radar-chart"),
  dialogProfileFacts: document.getElementById("dialog-profile-facts"),
  dialogRolesSection: document.getElementById("dialog-roles-section"),
  dialogRoleScores: document.getElementById("dialog-role-scores"),
  dialogSeasonHeading: document.getElementById("dialog-season-heading"),
  dialogSeasonEmpty: document.getElementById("dialog-season-empty"),
  dialogSeasonStats: document.getElementById("dialog-season-stats"),
  dialogRadarPanel: document.getElementById("dialog-radar-panel"),
  dialogProfileMetrics: document.getElementById("dialog-profile-metrics"),
  dialogCompareLegend: document.getElementById("dialog-compare-legend"),
  dialogStatsList: document.getElementById("dialog-stats-list"),
  dialogProgressionMetric: document.getElementById("dialog-progression-metric"),
  dialogProgressionEmpty: document.getElementById("dialog-progression-empty"),
  progressionChart: document.getElementById("progression-chart"),
  scoreDialog: document.getElementById("score-dialog"),
  scoreUnsavedBadge: document.getElementById("score-unsaved-badge"),
  scoreDialogSubtitle: document.getElementById("score-dialog-subtitle"),
  scoreResetBtn: document.getElementById("score-reset-btn"),
  scoreCancelBtn: document.getElementById("score-cancel-btn"),
  scoreCloseBtn: document.getElementById("score-close-btn"),
  scoreMethod: document.getElementById("score-method"),
  scoreMethodHint: document.getElementById("score-method-hint"),
  scorePresetPos: document.getElementById("score-preset-pos"),
  scorePresetSelect: document.getElementById("score-preset-select"),
  scorePresetName: document.getElementById("score-preset-name"),
  scoreSavePresetBtn: document.getElementById("score-save-preset-btn"),
  scoreUpdatePresetBtn: document.getElementById("score-update-preset-btn"),
  scoreRenamePresetBtn: document.getElementById("score-rename-preset-btn"),
  scoreDeletePresetBtn: document.getElementById("score-delete-preset-btn"),
  scoreMetricSearch: document.getElementById("score-metric-search"),
  scoreCategoryFilter: document.getElementById("score-category-filter"),
  scoreEnabledOnly: document.getElementById("score-enabled-only"),
  scoreDefaultsBtn: document.getElementById("score-defaults-btn"),
  scoreEqualizeBtn: document.getElementById("score-equalize-btn"),
  scoreClearMetricsBtn: document.getElementById("score-clear-metrics-btn"),
  scoreTotalWeight: document.getElementById("score-total-weight"),
  scoreMetricsList: document.getElementById("score-metrics-list"),
  scorePreviewNote: document.getElementById("score-preview-note"),
  scorePreviewList: document.getElementById("score-preview-list"),
  shortlistDialog: document.getElementById("shortlist-dialog"),
  shortlistBody: document.getElementById("shortlist-body"),
  shortlistSearch: document.getElementById("shortlist-search"),
  shortlistPosition: document.getElementById("shortlist-position"),
  shortlistSort: document.getElementById("shortlist-sort"),
  shortlistCloseBtn: document.getElementById("shortlist-close-btn"),
  btnShortlistCompare: document.getElementById("btn-shortlist-compare"),
  btnExportShortlist: document.getElementById("btn-export-shortlist"),
  btnClearShortlist: document.getElementById("btn-clear-shortlist"),
  toastRegion: document.getElementById("toast-region"),
};

export const FACETS = {
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

export function saveShortlist() {
  saveJsonStorage(SHORTLIST_KEY, state.shortlist);
  els.shortlistCount.textContent = String(Object.keys(state.shortlist).length);
}

export function savePresets() {
  saveJsonStorage(PRESETS_KEY, state.presets);
}

export function saveColPrefs() {
  saveJsonStorage(COLS_KEY, state.colPrefs);
}

export function saveUiPrefs() {
  saveJsonStorage(UI_PREFS_KEY, state.uiPrefs);
}

export function saveSavedViews() {
  saveJsonStorage(SAVED_VIEWS_KEY, state.savedViews);
}

export function saveLastView(view) {
  state.lastView = view;
  saveJsonStorage(LAST_VIEW_KEY, view);
}

export function activeDataset() {
  return state.cache.get(`${state.season || "latest"}:${state.pos}`);
}

export function seasonEndYear() {
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
