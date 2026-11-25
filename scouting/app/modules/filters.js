import {
  CLUB_PAGE_SIZE,
  DEFAULT_FILTERS,
  FOOT_OPTIONS,
  MIN_FILTERS,
  POSITION_TOKENS,
  STATUS_OPTIONS,
  collator,
} from "./constants.js";
import { activeDataset, els, FACETS, saveLastView, saveSavedViews, seasonEndYear, state } from "./state.js";
import { buildScoreConfigFromRole, datasetHasClubReputation, getMetricCatalog, refreshRoleSelectOptions } from "./scoring.js";
import {
  clubImgUrl,
  clubKeyOf,
  clubNameOf,
  escapeHtml,
  formatMoney,
  normalizeSearchText,
  parsePlayerPositions,
  showToast,
} from "./utils.js";

export function playerHasStatus(p, status) {
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

export function readScalarFilters() {
  return {
    minimums: MIN_FILTERS.flatMap((filter) => {
      const input = els[filter.id];
      if (!input || input.value === "") return [];
      const value = input.tagName === "SELECT"
        ? Number(input.value)
        : input.validity.valid ? input.valueAsNumber : NaN;
      return Number.isFinite(value) ? [{ ...filter, value }] : [];
    }),
    minMins: Number(els.minMins.value),
    minRep: Number(els.minRep.value),
    hasRep: datasetHasClubReputation(activeDataset()),
    maxAge: Number(els.maxAge.value),
    maxVal: Number(els.maxVal.value),
    maxWage: Number(els.maxWage.value),
    contractFilter: els.contract.value || "all",
    search: normalizeSearchText(els.search.value),
    dynamicPct: els.dynamicPct.checked,
    includeHull: els.includeHull.checked,
  };
}

export function matchesSearch(player, query) {
  if (!query) return true;
  return normalizeSearchText(`${player.name ?? ""} ${player.club ?? ""} ${player.positions ?? ""} ${player.league ?? ""} ${player.nation ?? ""}`).includes(query);
}

export function matchesLocation(player, omitFacet = null) {
  const { leagues, clubs } = state.filters;
  return (omitFacet === "leagues" || !leagues.size || leagues.has(player.league || "Free Agent")) &&
    (omitFacet === "clubs" || !clubs.size || clubs.has(clubKeyOf(player)));
}

export function matchesPlayer(p, scalar, omitFacet = null) {
  if (!scalar.includeHull && p.is_hull) return false;
  if (!p.is_hull && p.minutes < scalar.minMins) return false;
  if (p.is_hull && p.minutes < 300) return false;
  if (scalar.hasRep && !p.is_hull && p.club_rep < scalar.minRep) return false;
  if (!p.is_hull && scalar.minimums.some(({ field, value }) => !Number.isFinite(p[field]) || p[field] < value)) {
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

export function getClubCatalog(dataset) {
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

export function pruneClubsBySelectedLeagues(dataset) {
  if (state.filters.clubs.size === 0 || state.filters.leagues.size === 0) return;
  const clubMap = getClubCatalog(dataset);
  for (const cKey of [...state.filters.clubs]) {
    const info = clubMap.get(cKey);
    if (!info || !state.filters.leagues.has(info.league)) {
      state.filters.clubs.delete(cKey);
    }
  }
}

export function updateTriggerButton(facetName, dataset) {
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

export function renderFacetOptions(facetName, dataset) {
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
  } else if (facetName !== "feet" && facetName !== "statuses") {
    let snapOrder = state.popoverOrderSnapshots.get(facetName);
    if (!snapOrder) {
      entries.sort((a, b) => {
        if (a.isSelected !== b.isSelected) return a.isSelected ? -1 : 1;
        if (b.count !== a.count) return b.count - a.count;
        return collator.compare(a.label, b.label);
      });
      snapOrder = new Map(entries.map((e, idx) => [e.value, idx]));
      state.popoverOrderSnapshots.set(facetName, snapOrder);
    } else {
      entries.sort((a, b) => {
        const ia = snapOrder.get(a.value);
        const ib = snapOrder.get(b.value);
        if (ia !== undefined && ib !== undefined) return ia - ib;
        if (ia !== undefined) return -1;
        if (ib !== undefined) return 1;
        if (b.count !== a.count) return b.count - a.count;
        return collator.compare(a.label, b.label);
      });
    }
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

export function renderAllPopovers(dataset) {
  for (const facetName of Object.keys(FACETS)) {
    renderFacetOptions(facetName, dataset);
  }
}

export function getFilterRangeConflicts() {
  const conflicts = [];
  const minAge = els.minAge.value === "" ? NaN : els.minAge.valueAsNumber;
  const maxAge = Number(els.maxAge.value);
  if (Number.isFinite(minAge) && maxAge < 99 && minAge > maxAge) {
    conflicts.push(`Min Age (${minAge}) > Max Age (${maxAge})`);
  }
  const minVal = els.minVal.value === "" ? NaN : Number(els.minVal.value);
  const maxVal = Number(els.maxVal.value);
  if (Number.isFinite(minVal) && maxVal < 999999999 && minVal > maxVal) {
    conflicts.push(`Min Value (${formatMoney(minVal)}) > Max Value (${formatMoney(maxVal)})`);
  }
  const minWage = els.minWage.value === "" ? NaN : Number(els.minWage.value);
  const maxWage = Number(els.maxWage.value);
  if (Number.isFinite(minWage) && maxWage < 999999999 && minWage > maxWage) {
    conflicts.push(`Min Wage (${formatMoney(minWage)}/wk) > Max Wage (${formatMoney(maxWage)}/wk)`);
  }
  return conflicts;
}

export function describeActiveDefaultCaps() {
  const caps = [];
  if (els.minMins.value !== "0") caps.push(`Mins ≥ ${els.minMins.value}`);
  if (els.maxAge.value !== "99") caps.push(`Age ≤ ${els.maxAge.value}`);
  if (els.maxVal.value !== "999999999") caps.push(`Value ≤ ${formatMoney(els.maxVal.value)}`);
  if (els.maxWage.value !== "999999999") caps.push(`Wage ≤ ${formatMoney(els.maxWage.value)}/wk`);
  if (els.minRep.value !== "0") caps.push(`Rep ≥ ${Number(els.minRep.value).toLocaleString()}`);
  return caps;
}

export function updateFilterMetaAndWarnings(chipCount = 0) {
  const conflicts = getFilterRangeConflicts();
  if (els.filterWarning) {
    if (conflicts.length) {
      els.filterWarning.textContent = `Filter conflict: ${conflicts.join(" · ")}. Adjust min/max bounds to see players.`;
      els.filterWarning.hidden = false;
    } else {
      els.filterWarning.textContent = "";
      els.filterWarning.hidden = true;
    }
  }
  if (els.filterToggleMeta) {
    const caps = describeActiveDefaultCaps();
    els.filterToggleMeta.textContent = chipCount > 0
      ? `${chipCount} custom filter${chipCount > 1 ? "s" : ""} active`
      : caps.length ? `Defaults: ${caps.join(" · ")}` : "All players";
  }
  if (els.btnClearDefaults) {
    const hasRestrictedDefaults =
      els.maxAge.value === DEFAULT_FILTERS.maxAge ||
      els.maxVal.value === DEFAULT_FILTERS.maxVal ||
      els.minRep.value === DEFAULT_FILTERS.minRep;
    els.btnClearDefaults.hidden = !hasRestrictedDefaults;
  }
}

export function clearDefaultCaps(onRefresh) {
  els.maxAge.value = "99";
  els.maxVal.value = "999999999";
  els.minRep.value = "0";
  onRefresh();
  showToast("Default age, value, and reputation caps cleared");
}

export function captureViewSnapshot() {
  const facets = {};
  for (const key of Object.keys(state.filters)) {
    facets[key] = [...state.filters[key]];
  }
  const scalars = {};
  for (const key of Object.keys(DEFAULT_FILTERS)) {
    const el = els[key];
    if (!el) continue;
    scalars[key] = typeof DEFAULT_FILTERS[key] === "boolean" ? el.checked : el.value;
  }
  const roleVal = els.role.value || "overall";
  const customScore =
    roleVal === "__custom_draft__" && state.scoreConfig
      ? {
          method: state.scoreConfig.method || "percentile",
          metrics: state.scoreConfig.metrics
            .filter((m) => m.enabled)
            .map((m) => ({ key: m.key, weight: m.weight, higher_is_better: m.higher_is_better })),
        }
      : null;
  const sorters = state.tabulatorTable
    ? state.tabulatorTable
        .getSorters()
        .filter((s) => s.field)
        .map((s) => ({ column: s.field, dir: s.dir }))
    : [];
  return {
    pos: state.pos,
    search: els.search.value,
    facets,
    scalars,
    role: roleVal,
    scoreMethod: state.scoreConfig?.method || "percentile",
    customScore,
    sort: sorters,
    benchmark: els.benchmark?.value ?? "",
    scatterX: els.scatterX.value,
    scatterY: els.scatterY.value,
  };
}

export function isNonDefaultView(snap) {
  if (!snap) return false;
  if (snap.pos && snap.pos !== "ST") return true;
  if (snap.search) return true;
  if (Object.values(snap.facets || {}).some((arr) => Array.isArray(arr) && arr.length > 0)) return true;
  for (const [k, defVal] of Object.entries(DEFAULT_FILTERS)) {
    if (snap.scalars?.[k] !== undefined && snap.scalars[k] !== defVal) return true;
  }
  return false;
}

export function persistLastViewSnapshot() {
  const snap = captureViewSnapshot();
  if (isNonDefaultView(snap)) saveLastView(snap);
}

export function renderSavedViewsSelect(selectedId = "") {
  if (!els.savedViewSelect) return;
  const views = Array.isArray(state.savedViews) ? state.savedViews : [];
  els.savedViewSelect.innerHTML = [
    `<option value="">— Saved Views —</option>`,
    ...views.map((v) => `<option value="${escapeHtml(v.id)}">${escapeHtml(v.name)} (${escapeHtml(v.pos || "ST")})</option>`),
  ].join("");
  els.savedViewSelect.value = selectedId && views.some((v) => v.id === selectedId) ? selectedId : "";
  if (els.btnDeleteView) els.btnDeleteView.disabled = !els.savedViewSelect.value;
}

export async function applyViewSnapshot(snap, selectPositionFn, refreshFn) {
  if (!snap) return;
  els.search.value = snap.search || "";
  for (const key of Object.keys(state.filters)) {
    state.filters[key].clear();
    for (const val of snap.facets?.[key] || []) {
      state.filters[key].add(val);
    }
  }
  for (const [id, defVal] of Object.entries(DEFAULT_FILTERS)) {
    const el = els[id];
    if (!el) continue;
    const val = snap.scalars?.[id] ?? defVal;
    if (typeof defVal === "boolean") el.checked = Boolean(val);
    else el.value = String(val);
  }
  const targetPos = snap.pos || state.pos;
  if (targetPos !== state.pos && selectPositionFn) {
    await selectPositionFn(targetPos);
  }
  const dataset = activeDataset();
  if (dataset && snap.role === "__custom_draft__" && snap.customScore?.metrics?.length) {
    const catalog = getMetricCatalog(dataset);
    const savedMap = new Map(snap.customScore.metrics.map((m) => [m.key, m]));
    state.scoreConfig = {
      pos: dataset.position,
      roleSlug: "__custom_draft__",
      presetId: null,
      method: snap.customScore.method || snap.scoreMethod || "percentile",
      metrics: catalog.list.map((cat) => {
        const saved = savedMap.get(cat.key);
        return {
          key: cat.key,
          weight: saved ? Math.max(0, Math.min(5, Number(saved.weight) || 0)) : 1,
          higher_is_better: saved ? Boolean(saved.higher_is_better) : cat.higher_is_better,
          enabled: Boolean(saved),
        };
      }),
    };
    state.customDrafts[dataset.position] = state.scoreConfig;
    refreshRoleSelectOptions(dataset, "__custom_draft__");
  } else if (snap.role && [...els.role.options].some((o) => o.value === snap.role)) {
    if (dataset) {
      delete state.customDrafts[dataset.position];
      state.scoreConfig = buildScoreConfigFromRole(
        dataset,
        snap.role,
        snap.role.startsWith("custom:") ? null : snap.scoreMethod || "percentile"
      );
      refreshRoleSelectOptions(dataset, state.scoreConfig.roleSlug);
    } else {
      els.role.value = snap.role;
    }
  }
  if (snap.benchmark !== undefined && els.benchmark && [...els.benchmark.options].some((o) => o.value === snap.benchmark)) {
    els.benchmark.value = snap.benchmark;
  }
  if (snap.scatterX && [...els.scatterX.options].some((o) => o.value === snap.scatterX)) {
    els.scatterX.value = snap.scatterX;
  }
  if (snap.scatterY && [...els.scatterY.options].some((o) => o.value === snap.scatterY)) {
    els.scatterY.value = snap.scatterY;
  }
  await refreshFn();
  if (Array.isArray(snap.sort) && snap.sort.length && state.tabulatorTable) {
    try {
      state.tabulatorTable.setSort(snap.sort);
    } catch {
      // Ignore unknown columns on sort restore
    }
  }
}

export function renderActiveFilterChips(dataset, onRefresh) {
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
      relaxed: els.maxAge.value === "99",
      label: els.maxAge.value === "99" ? "No Age Cap" : `Max Age: ≤ ${els.maxAge.value}`,
    });
  }
  if (els.maxVal.value !== DEFAULT_FILTERS.maxVal) {
    chips.push({
      type: "scalar",
      id: "maxVal",
      relaxed: els.maxVal.value === "999999999",
      label: els.maxVal.value === "999999999" ? "No Value Cap" : `Max Value: ≤ ${formatMoney(els.maxVal.value)}`,
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
      relaxed: els.minRep.value === "0",
      label: els.minRep.value === "0" ? "All Reputations" : `Min Rep: ${els.minRep.value}+`,
    });
  }
  if (els.dynamicPct.checked !== DEFAULT_FILTERS.dynamicPct) {
    chips.push({ type: "scalar", id: "dynamicPct", label: "Global percentiles" });
  }
  if (els.includeHull.checked !== DEFAULT_FILTERS.includeHull) {
    chips.push({ type: "scalar", id: "includeHull", label: "Exclude managed club" });
  }

  updateFilterMetaAndWarnings(chips.length);

  if (!chips.length) {
    els.activeFiltersBar.hidden = true;
    els.activeFiltersChips.innerHTML = "";
    return;
  }

  els.activeFiltersBar.hidden = false;
  els.activeFiltersChips.innerHTML = chips
    .map((c, idx) => {
      const cls = c.relaxed ? "chip-btn is-relaxed" : "chip-btn";
      return `<button type="button" class="${cls}" data-chip-idx="${idx}" aria-label="Remove ${escapeHtml(
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
      onRefresh();
    });
  });
}

export function saveCurrentView(showToastFn = showToast) {
  const views = Array.isArray(state.savedViews) ? state.savedViews : [];
  const roleLabel = els.role?.selectedOptions?.[0]?.textContent?.trim() || "Overall";
  const snap = captureViewSnapshot();
  const scope = snap.facets.leagues?.length === 1 ? snap.facets.leagues[0] : state.pos;
  const customName = els.viewNameInput?.value.trim() || "";
  const name = customName || `${scope} · ${roleLabel} (#${views.length + 1})`;
  if (els.viewNameInput && customName) els.viewNameInput.value = "";
  const id = `v_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`;
  const entry = { id, name, ...snap };
  state.savedViews = [...views, entry];
  saveSavedViews();
  renderSavedViewsSelect(id);
  showToastFn(`Saved view "${name}"`);
}

export function resetAllFilters(onRefresh) {
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
  onRefresh();
  showToast("All filters reset");
}

export function positionPopoverFallback(popover, trigger) {
  if (CSS.supports("position-area: block-end")) return;
  if (!trigger) return;
  const rect = trigger.getBoundingClientRect();
  const popRect = popover.getBoundingClientRect();
  const popW = popRect.width || 280;
  const popH = popRect.height || 300;

  let left = rect.left;
  if (popover.id === "column-chooser-popover" || popover.id === "pop-saved-views") {
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

export function wirePopoverBehaviors({ onRefresh, onOpenColumnChooser }) {
  const allPopovers = [
    ...Object.values(FACETS).map((f) => ({ popover: f.popover, trigger: f.trigger, facet: f })),
    { popover: els.columnChooserPopover, trigger: els.btnColumnChooser, facet: null },
    ...(els.popSavedViews && els.btnViewsMenu
      ? [{ popover: els.popSavedViews, trigger: els.btnViewsMenu, facet: null }]
      : []),
  ];

  for (const { popover, trigger, facet } of allPopovers) {
    popover.addEventListener("toggle", (ev) => {
      const isOpen = ev.newState === "open";
      trigger.setAttribute("aria-expanded", String(isOpen));
      if (!isOpen && facet) {
        state.popoverOrderSnapshots.delete(popover.dataset.facet);
        return;
      }
      if (isOpen) {
        if (popover === els.columnChooserPopover) {
          onOpenColumnChooser();
        } else if (facet) {
          const ds = activeDataset();
          if (ds) {
            const name = popover.dataset.facet;
            state.popoverOrderSnapshots.delete(name);
            const input = popover.querySelector(".popover-search");
            if (input) input.value = "";
            if (name === "clubs") state.clubOptionLimit = CLUB_PAGE_SIZE;
            renderFacetOptions(name, ds);
          }
        }
        requestAnimationFrame(() => {
          positionPopoverFallback(popover, trigger);
          const searchEl = popover.querySelector(".popover-search, .view-name-input");
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
          onRefresh();
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
        onRefresh();
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
