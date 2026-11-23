export const POS_LABELS = {
  ST: "Strikers",
  W: "Wingers / Wide",
  AM: "Attacking Midfielders",
  CM: "Central Midfielders",
  DM: "Defensive Midfielders",
  FB_WB: "Full-Backs / Wing-Backs",
  CB: "Centre-Backs",
  GK: "Goalkeepers",
};

export const DEFAULT_AXES = {
  ST: ["npxg_p90", "xa_p90"],
  W: ["npxg_p90", "xa_p90"],
  AM: ["npxg_p90", "xa_p90"],
  CM: ["prog_passes_p90", "tackles_cmp_p90"],
  DM: ["prog_passes_p90", "tackles_cmp_p90"],
  FB_WB: ["xa_p90", "tackles_cmp_p90"],
  CB: ["headers_won_pct", "prog_passes_p90"],
  GK: ["xg_prevented_p90", "save_pct"],
};

export const POSITION_TOKENS = [
  "ST", "AML", "AMR", "AMC", "ML", "MR", "MC", "DM", "DC", "DL", "DR", "WBL", "WBR", "GK",
];
export const FOOT_OPTIONS = ["Left", "Right", "Both"];
export const STATUS_OPTIONS = ["Expiring Soon", "On Loan", "Not On Loan", "Free Agent"];
export const CLUB_PAGE_SIZE = 250;
export const SQUAD_PAGE_SIZE = 24;

export const MIN_FILTERS = [
  { id: "minAge", label: "Min Age", field: "age", prefix: "", suffix: "" },
  { id: "minVal", label: "Min Transfer Value", field: "value", prefix: "£", suffix: "" },
  { id: "minWage", label: "Min Weekly Wage", field: "wage", prefix: "£", suffix: "/wk" },
];

export const DEFAULT_FILTERS = {
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

export const PROGRESSION_AXES = {
  ST: ["npxg_p90", "xa_p90"],
  W: ["npxg_p90", "xa_p90"],
  AM: ["npxg_p90", "xa_p90"],
  CM: ["prog_passes_p90", "tackles_cmp_p90"],
  DM: ["prog_passes_p90", "tackles_cmp_p90"],
  FB_WB: ["xa_p90", "tackles_cmp_p90"],
  CB: ["headers_won_pct", "prog_passes_p90"],
  GK: ["xg_prevented_p90", "goals_allowed_p90"],
};

export const SHORTLIST_KEY = "fm27_moneyball_shortlist_v1";
export const LEGACY_SHORTLIST_KEY = "hull_fm27_moneyball_shortlist_v1";
export const PRESETS_KEY = "fm27_moneyball_role_presets_v1";
export const COLS_KEY = "fm27_moneyball_cols_v1";
export const SAVED_VIEWS_KEY = "fm27_moneyball_saved_views_v1";
export const LAST_VIEW_KEY = "fm27_moneyball_last_view_v1";

export const METHOD_HINTS = {
  percentile: "Mid-rank percentile (0–100) within the active baseline pool.",
  zscore: "Standardized Z-score mapped ±3σ to 0–100 (50 = pool mean, clamped).",
  minmax: "Linear Min–Max normalization (0–100) within baseline pool bounds (clamped).",
};

export const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: "base" });
