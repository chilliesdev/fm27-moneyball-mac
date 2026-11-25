import {
  CLUB_PAGE_SIZE,
  MIN_FILTERS,
  POS_LABELS,
  SCATTER_PRESETS,
  SQUAD_PAGE_SIZE,
  collator,
} from "./modules/constants.js";
import {
  FACETS,
  activeDataset,
  els,
  saveSavedViews,
  saveShortlist,
  saveUiPrefs,
  seasonEndYear,
  state,
} from "./modules/state.js";
import {
  clubImgUrl,
  clubNameOf,
  copyPlayerName,
  downloadCsv,
  enableLightDismissFallback,
  escapeHtml,
  getThemeColors,
  isDarkColorScheme,
  normalizeSearchText,
  parsePlayerPositions,
  playerName,
  showToast,
} from "./modules/utils.js";
import {
  buildScoreConfigFromRole,
  computePoolRows,
  datasetHasClubReputation,
  refreshRoleSelectOptions,
} from "./modules/scoring.js";
import {
  applyViewSnapshot,
  clearDefaultCaps,
  describeActiveDefaultCaps,
  getClubCatalog,
  getFilterRangeConflicts,
  isNonDefaultView,
  matchesLocation,
  matchesPlayer,
  matchesSearch,
  persistLastViewSnapshot,
  readScalarFilters,
  renameSelectedView,
  renderActiveFilterChips,
  renderAllPopovers,
  renderFacetOptions,
  renderSavedViewsSelect,
  resetAllFilters,
  saveCurrentView,
  syncCustomBoundInputs,
  updateSelectedView,
  wirePopoverBehaviors,
} from "./modules/filters.js";
import {
  populateScatterAxes,
  renderPlayerProgression,
  renderScatter,
  resetScatterZoom,
  syncScatterPresetSelect,
} from "./modules/charts.js";
import {
  filteredShortlist,
  openPlayerDialog,
  openShortlistedPlayer,
  refreshShortlistDatasets,
  renderShortlist,
  stepPlayerDialog,
  toggleRowShortlist,
  updateShortlistCompareButton,
} from "./modules/profile.js";
import {
  getTableHeight,
  initOrUpdateTable,
  renderColumnChooser,
  updateCompareSelectedButton,
} from "./modules/table.js";
import { wireScoreDialogEvents } from "./modules/scoreDialog.js";

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

function openDialog(player, dataset, season = state.season) {
  openPlayerDialog(player, dataset, season, loadPosition);
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
  if (state.meta.save_path && els.saveSelect && [...els.saveSelect.options].some((o) => o.value === state.meta.save_path)) {
    els.saveSelect.value = state.meta.save_path;
  }
  populateContractOptions();
  updateTabCounts();
}

function updateTabCounts() {
  const counts = state.meta?.positions;
  if (!counts) return;
  for (const tab of els.tabs) {
    const pos = tab.dataset.pos;
    const info = counts[pos];
    const badge = tab.querySelector(".tab-count");
    if (!badge) continue;
    const n = info?.total_450;
    if (Number.isFinite(n) && n > 0) {
      badge.textContent = n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n);
      badge.hidden = false;
    } else {
      badge.hidden = true;
    }
  }
}

function populatePositionControls(dataset) {
  const samePosition = state.scoreConfig?.pos === dataset.position;
  const savedDraft = !samePosition ? state.customDrafts[dataset.position] : null;
  if (savedDraft) {
    state.scoreConfig = savedDraft;
    refreshRoleSelectOptions(dataset, "__custom_draft__");
  } else {
    const prevRole = els.role.value;
    const validPrev =
      prevRole === "overall" ||
      Boolean(dataset.roles?.[prevRole]) ||
      (prevRole.startsWith("custom:") && (state.presets?.[dataset.position] || []).some((p) => `custom:${p.id}` === prevRole));
    const initialRole = validPrev ? prevRole : "overall";

    state.scoreConfig = buildScoreConfigFromRole(
      dataset,
      initialRole,
      initialRole.startsWith("custom:") ? null : state.scoreConfig?.method || "percentile"
    );
    refreshRoleSelectOptions(dataset, state.scoreConfig.roleSlug);
  }
  populateScatterAxes(dataset, samePosition);

  const hadBenchmarkOptions = els.benchmark.options.length > 0;
  const prevBenchmark = els.benchmark.value;
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
        `<option value="${escapeHtml(p.uid)}">[${escapeHtml(clubTag)} · other pos] ${escapeHtml(playerName(p))} (${escapeHtml(
          p.positions
        )})</option>`
    ),
  ].join("");
  const hasPrevBenchmark = hadBenchmarkOptions && [...els.benchmark.options].some((o) => o.value === prevBenchmark);
  if (hasPrevBenchmark) {
    els.benchmark.value = prevBenchmark;
  } else if (hullInPos.length > 0) {
    els.benchmark.value = hullInPos[0].uid;
  }
}

function closeSearchSuggestions() {
  els.searchSuggestions.hidden = true;
  els.search.setAttribute("aria-expanded", "false");
  els.search.removeAttribute("aria-activedescendant");
}

function renderSearchSuggestions() {
  closeSearchSuggestions();
  if (els.btnClearSearch) els.btnClearSearch.hidden = !els.search.value;
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
  const loadingIndex = Boolean(index && !index.entries && !index.failed);
  if (!suggestions.length && !loadingIndex) return;

  const rowsHtml = suggestions.map(({ value, detail }, index) => `
    <li id="search-suggestion-${index}" role="option" aria-selected="false" data-index="${index}" data-value="${escapeHtml(value)}">
      <span>${escapeHtml(value)}</span><small>${escapeHtml(detail)}</small>
    </li>
  `);
  if (loadingIndex) {
    rowsHtml.push(`<li class="search-loading-note" aria-disabled="true"><small>Loading full player index…</small></li>`);
  }
  els.searchSuggestions.innerHTML = rowsHtml.join("");
  const gridBottom = els.search.closest(".filter-grid")?.getBoundingClientRect().bottom ?? window.innerHeight;
  const searchBottom = els.search.getBoundingClientRect().bottom;
  const inGridSpace = gridBottom - searchBottom;
  const avail = inGridSpace >= 120 ? inGridSpace : Math.max(140, window.innerHeight - searchBottom - 16);
  els.searchSuggestions.style.maxBlockSize = `min(20rem, ${avail}px)`;
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
  openDialog(scoutingRow || player, scoutingRow ? dataset : null, season);
}

function wireSearchSuggestions() {
  els.search.addEventListener("input", refreshView);
  els.btnClearSearch?.addEventListener("click", () => {
    els.search.value = "";
    refreshView();
    els.search.focus();
  });
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
    } else if (els.searchSuggestions.hidden && event.key === "Escape" && els.search.value) {
      event.preventDefault();
      els.search.value = "";
      refreshView();
    } else if (!els.searchSuggestions.hidden && event.key === "Enter") {
      const option = els.searchSuggestions.querySelector('[aria-selected="true"]');
      if (option) {
        event.preventDefault();
        selectSearchSuggestion(option);
      } else {
        closeSearchSuggestions();
      }
    }
  });
}

function renderSquadProfiles() {
  const dataset = activeDataset();
  if (!dataset) return;
  const hasLocation = state.filters.leagues.size || state.filters.clubs.size;
  const showSquad = !state.filtered.length && hasLocation && !dataset.players.some((p) => matchesLocation(p));
  const conflicts = getFilterRangeConflicts();
  const caps = describeActiveDefaultCaps();
  els.tableCountNote.textContent = state.filtered.length
    ? "Hold Shift + click column headers for multi-column sort"
    : conflicts.length
      ? `Conflicting bounds (${conflicts.join(" · ")}) — adjust min/max filters above.`
      : showSquad
        ? "No players in the selected clubs or leagues have enough league minutes for scouting in this position."
        : caps.length
          ? `No players match current filters (active caps: ${caps.join(", ")}). Try Reset Filters or relax bounds.`
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

  const { rows, baseline } = computePoolRows(dataset, readScalarFilters(), matchesPlayer);
  rows.sort((a, b) => b.active_score - a.active_score);
  state.filtered = rows;
  if (state.selectedCompareUids.size > 0) {
    const visibleUids = new Set(rows.map((r) => r.uid));
    let changed = false;
    for (const uid of [...state.selectedCompareUids]) {
      if (!visibleUids.has(uid)) {
        state.selectedCompareUids.delete(uid);
        changed = true;
      }
    }
    if (changed) updateCompareSelectedButton();
  }
  state.squadLimit = SQUAD_PAGE_SIZE;

  const repNote = datasetHasClubReputation(dataset) ? `rep ≥ ${els.minRep.value}` : "rep n/a";
  const pctMode = !baseline.isGlobal
    ? `Dynamic percentiles vs ${baseline.peerCount.toLocaleString()} peers (mins ≥ ${els.minMins.value}, ${repNote})`
    : `Global ≥${dataset.baseline_minutes || 900}m percentiles`;
  const clubLabel = state.meta?.club_short_name || "Managed Club";
  const hullCount = rows.reduce((acc, r) => acc + (r.is_hull ? 1 : 0), 0);
  const clubBreakdown = hullCount > 0 && els.includeHull.checked ? ` (incl. ${hullCount} ${clubLabel})` : "";
  els.poolSummary.textContent = `${rows.length.toLocaleString()} targets matched${clubBreakdown} · ${pctMode} · ${clubLabel} highlighted in amber`;

  renderAllPopovers(dataset);
  renderActiveFilterChips(dataset, refreshView);
  persistLastViewSnapshot();
  renderSearchSuggestions();
  renderSquadProfiles();
  renderScatter(dataset, openDialog);
  const eliteNote = Number.isFinite(state.lastScatterEliteCount)
    ? ` · ${state.lastScatterEliteCount.toLocaleString()} in Elite Quadrant`
    : "";
  els.poolSummary.textContent = `${rows.length.toLocaleString()} targets matched${clubBreakdown}${eliteNote} · ${pctMode} · ${clubLabel} highlighted in amber`;
  return initOrUpdateTable(dataset, rows, openDialog);
}

async function selectPosition(pos, focusTab = false) {
  const request = ++state.positionRequest;
  state.pos = pos;
  state.selectedCompareUids.clear();
  updateCompareSelectedButton();
  els.tabs.forEach((t) => {
    const active = t.dataset.pos === pos;
    t.setAttribute("aria-selected", String(active));
    t.tabIndex = active ? 0 : -1;
    if (active && focusTab) t.focus();
  });

  els.tablist.setAttribute("aria-busy", "true");
  els.role.disabled = true;
  els.btnCustomizeScore.disabled = true;
  try {
    const dataset = await loadPosition(pos, state.season);
    if (request !== state.positionRequest) return;
    populatePositionControls(dataset);
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
  for (const { id } of MIN_FILTERS) {
    els[id].addEventListener(els[id].tagName === "SELECT" ? "change" : "input", refreshView);
  }
  [
    els.minMins,
    els.contract,
    els.minRep,
    els.benchmark,
    els.dynamicPct,
    els.includeHull,
  ].forEach((el) => el.addEventListener("change", refreshView));

  [els.maxAge, els.maxVal, els.maxWage].forEach((el) => {
    el?.addEventListener("change", () => {
      syncCustomBoundInputs();
      if (el.value === "__custom__") {
        const customMap = {
          "f-max-age": els.maxAgeCustom,
          "f-max-val": els.maxValCustom,
          "f-max-wage": els.maxWageCustom,
        };
        customMap[el.id]?.focus();
      }
      refreshView();
    });
  });
  [els.maxAgeCustom, els.maxValCustom, els.maxWageCustom].forEach((el) => {
    el?.addEventListener("input", refreshView);
  });

  els.role.addEventListener("change", () => {
    const dataset = activeDataset();
    if (!dataset) return;
    const val = els.role.value;
    if (val === "__custom_draft__") return;
    delete state.customDrafts[dataset.position];
    state.scoreConfig = buildScoreConfigFromRole(
      dataset,
      val,
      val.startsWith("custom:") ? null : state.scoreConfig?.method || "percentile"
    );
    refreshView();
  });

  [els.scatterX, els.scatterY].forEach((el) => {
    el.addEventListener("change", () => {
      syncScatterPresetSelect(state.pos);
      if (els.scatterX.value && els.scatterX.value === els.scatterY.value) {
        showToast("X and Y axes are set to the same metric");
      }
      const dataset = activeDataset();
      if (dataset) renderScatter(dataset, openDialog);
      persistLastViewSnapshot();
    });
  });

  els.scatterPreset?.addEventListener("change", () => {
    const idx = els.scatterPreset.value;
    if (idx === "") return;
    const preset = (SCATTER_PRESETS[state.pos] || [])[Number(idx)];
    if (!preset) return;
    if ([...els.scatterX.options].some((o) => o.value === preset.x)) els.scatterX.value = preset.x;
    if ([...els.scatterY.options].some((o) => o.value === preset.y)) els.scatterY.value = preset.y;
    const dataset = activeDataset();
    if (dataset) renderScatter(dataset, openDialog);
    persistLastViewSnapshot();
  });

  els.btnSwapAxes?.addEventListener("click", () => {
    const prevX = els.scatterX.value;
    const prevY = els.scatterY.value;
    els.scatterX.value = prevY;
    els.scatterY.value = prevX;
    syncScatterPresetSelect(state.pos);
    const dataset = activeDataset();
    if (dataset) renderScatter(dataset, openDialog);
    persistLastViewSnapshot();
  });

  els.btnToggleFilters?.addEventListener("click", () => {
    const collapsed = !els.filterGrid.hidden;
    els.filterGrid.hidden = collapsed;
    els.btnToggleFilters.setAttribute("aria-expanded", String(!collapsed));
    els.btnToggleFilters.closest(".filters-header")?.classList.toggle("is-collapsed", collapsed);
  });

  els.btnClearDefaults?.addEventListener("click", () => clearDefaultCaps(refreshView));

  els.btnToggleScatter?.addEventListener("click", () => {
    const collapsed = !els.scatterBody.hidden;
    els.scatterBody.hidden = collapsed;
    els.btnToggleScatter.setAttribute("aria-expanded", String(!collapsed));
    els.btnToggleScatter.closest(".scatter-header")?.classList.toggle("is-collapsed", collapsed);
    if (!collapsed) requestAnimationFrame(() => state.scatterChart?.resize());
  });

  els.btnSaveView?.addEventListener("click", () => saveCurrentView(showToast));
  els.btnUpdateView?.addEventListener("click", () => updateSelectedView(showToast));
  els.btnRenameView?.addEventListener("click", () => renameSelectedView(showToast));

  els.savedViewSelect?.addEventListener("change", async () => {
    const id = els.savedViewSelect.value;
    const hasSel = Boolean(id);
    if (els.btnDeleteView) els.btnDeleteView.disabled = !hasSel;
    if (els.btnUpdateView) els.btnUpdateView.disabled = !hasSel;
    if (els.btnRenameView) els.btnRenameView.disabled = !hasSel;
    if (!id) {
      if (els.viewNameInput) els.viewNameInput.value = "";
      return;
    }
    const view = (state.savedViews || []).find((v) => v.id === id);
    if (view) {
      if (els.viewNameInput) els.viewNameInput.value = view.name;
      await applyViewSnapshot(view, selectPosition, refreshView);
      showToast(`Loaded view "${view.name}"`);
    }
  });

  els.btnDeleteView?.addEventListener("click", () => {
    const id = els.savedViewSelect?.value;
    if (!id) return;
    const views = state.savedViews || [];
    const targetIdx = views.findIndex((v) => v.id === id);
    const target = targetIdx >= 0 ? views[targetIdx] : null;
    state.savedViews = views.filter((v) => v.id !== id);
    saveSavedViews();
    renderSavedViewsSelect();
    if (target) {
      showToast(`Deleted view "${target.name}"`, {
        actionLabel: "Undo",
        onAction: () => {
          const cur = state.savedViews || [];
          if (!cur.some((v) => v.id === target.id)) {
            const restored = [...cur];
            restored.splice(Math.min(targetIdx, restored.length), 0, target);
            state.savedViews = restored;
            saveSavedViews();
          }
          renderSavedViewsSelect(target.id);
        },
      });
    }
  });

  els.btnRestoreView?.addEventListener("click", async () => {
    if (!state.lastView) return;
    els.btnRestoreView.hidden = true;
    await applyViewSnapshot(state.lastView, selectPosition, refreshView);
    showToast("Restored previous view");
  });

  els.btnResetZoom?.addEventListener("click", resetScatterZoom);

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

  els.btnResetFilters.addEventListener("click", () => resetAllFilters(refreshView));
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

  wirePopoverBehaviors({
    onRefresh: refreshView,
    onOpenColumnChooser: () => renderColumnChooser(refreshView),
  });
  wireScoreDialogEvents(refreshView, openDialog);

  if (els.btnTogglePcts) {
    const syncPctBtn = () => {
      const hidden = Boolean(state.uiPrefs?.hidePctPills);
      els.btnTogglePcts.setAttribute("aria-pressed", String(hidden));
      els.btnTogglePcts.textContent = hidden ? "Show %" : "Hide %";
    };
    syncPctBtn();
    els.btnTogglePcts.addEventListener("click", () => {
      state.uiPrefs.hidePctPills = !state.uiPrefs.hidePctPills;
      saveUiPrefs();
      syncPctBtn();
      const dataset = activeDataset();
      if (dataset) initOrUpdateTable(dataset, state.filtered, openDialog);
    });
  }

  if (els.btnExpandTable) {
    const syncExpandBtn = () => {
      const expanded = Boolean(state.uiPrefs?.tableExpanded);
      els.btnExpandTable.setAttribute("aria-pressed", String(expanded));
      els.btnExpandTable.textContent = expanded ? "Fixed Height" : "Expand Table";
    };
    syncExpandBtn();
    els.btnExpandTable.addEventListener("click", () => {
      state.uiPrefs.tableExpanded = !state.uiPrefs.tableExpanded;
      saveUiPrefs();
      syncExpandBtn();
      state.tabulatorTable?.setHeight?.(getTableHeight());
    });
  }

  els.btnCompareSelected?.addEventListener("click", () => {
    const dataset = activeDataset();
    if (!dataset) return;
    const picked = [...state.selectedCompareUids]
      .map((uid) => dataset.players.find((p) => p.uid === uid))
      .filter(Boolean);
    if (picked.length < 2) return;
    openPlayerDialog(picked[0], dataset, state.season, loadPosition, {
      compareUid: picked[1].uid,
      extraComparePlayers: picked.slice(1),
    });
  });

  els.btnClearCompare?.addEventListener("click", () => {
    if (!state.selectedCompareUids.size) return;
    state.selectedCompareUids.clear();
    updateCompareSelectedButton();
    state.tabulatorTable?.getRows().forEach((r) => r.reformat());
  });

  document.addEventListener("keydown", (ev) => {
    if (ev.metaKey || ev.ctrlKey || ev.altKey) return;
    const target = ev.target;
    const inEditable = target && target.closest("input, textarea, select, [contenteditable='true']");
    if (els.playerDialog.open) {
      if (!inEditable && ev.key === "ArrowLeft") {
        ev.preventDefault();
        stepPlayerDialog(-1, loadPosition);
      } else if (!inEditable && ev.key === "ArrowRight") {
        ev.preventDefault();
        stepPlayerDialog(1, loadPosition);
      }
      return;
    }
    if (document.querySelector("dialog[open]") || inEditable) return;
    if (ev.key === "/") {
      ev.preventDefault();
      els.search.focus();
      els.search.select();
    } else if (ev.key === "?") {
      ev.preventDefault();
      els.popShortcuts?.togglePopover?.();
    }
  });

  enableLightDismissFallback(els.playerDialog);
  enableLightDismissFallback(els.shortlistDialog);
  [els.playerDialog, els.shortlistDialog, els.scoreDialog].forEach((dlg) => {
    dlg?.addEventListener("close", () => {
      if (els.toastRegion && dlg.contains(els.toastRegion)) {
        const wasOpen = (() => {
          try {
            return els.toastRegion.matches(":popover-open");
          } catch {
            return false;
          }
        })();
        document.body.append(els.toastRegion);
        if (wasOpen && typeof els.toastRegion.showPopover === "function") {
          try {
            els.toastRegion.showPopover();
          } catch {
            // Ignore popover support differences
          }
        }
      }
    });
  });
  els.dialogCloseBtn.addEventListener("click", () => els.playerDialog.close());
  els.shortlistCloseBtn.addEventListener("click", () => els.shortlistDialog.close());

  els.playerDialog.addEventListener("close", () => {
    state.dialogOpenToken += 1;
    state.activeProfile = null;
    state.activeComparePlayers = [];
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
    if (player?.name) copyPlayerName(player, els.dialogCopyName);
  });
  els.dialogPinCompare?.addEventListener("click", () => {
    const profile = state.activeProfile;
    if (!profile?.dataset) return;
    const { player, dataset } = profile;
    if (state.pinnedCompare?.uid === player.uid) {
      state.pinnedCompare = null;
      els.dialogPinCompare.textContent = "Pin Compare";
      els.dialogPinCompare.setAttribute("aria-pressed", "false");
      showToast("Unpinned comparison player");
    } else {
      state.pinnedCompare = { uid: player.uid, position: dataset.position, player };
      els.dialogPinCompare.textContent = "Unpin Compare";
      els.dialogPinCompare.setAttribute("aria-pressed", "true");
      showToast(`Pinned ${playerName(player)} for radar comparison`);
    }
  });
  els.dialogPrevPlayer?.addEventListener("click", () => stepPlayerDialog(-1, loadPosition));
  els.dialogNextPlayer?.addEventListener("click", () => stepPlayerDialog(1, loadPosition));
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
  els.saveSelect.addEventListener("change", () => {
    if (els.saveSelect.value) refreshFromSave(els.saveSelect.value);
  });

  els.btnShortlistView.addEventListener("click", () => {
    renderShortlist();
    els.shortlistDialog.showModal();
    refreshShortlistDatasets(loadPosition);
  });
  els.shortlistSearch?.addEventListener("input", renderShortlist);
  els.shortlistPosition.addEventListener("change", renderShortlist);
  els.shortlistSort?.addEventListener("change", renderShortlist);
  els.shortlistBody.addEventListener("change", (event) => {
    const cb = event.target.closest(".shortlist-compare-cb");
    if (!cb) return;
    const uid = cb.dataset.uid;
    if (!uid) return;
    if (cb.checked) {
      if (state.shortlistCompareUids.size >= 4) {
        cb.checked = false;
        showToast("Select up to 4 players to compare");
        return;
      }
      state.shortlistCompareUids.add(uid);
    } else {
      state.shortlistCompareUids.delete(uid);
    }
    const firstUid = [...state.shortlistCompareUids][0];
    const lockedPos = firstUid ? state.shortlist[firstUid]?.pos_group || "" : "";
    els.shortlistBody.querySelectorAll(".shortlist-compare-cb").forEach((box) => {
      const boxUid = box.dataset.uid;
      const entry = boxUid ? state.shortlist[boxUid] : null;
      const posMismatch = Boolean(lockedPos && !box.checked && entry?.pos_group !== lockedPos);
      box.disabled = !entry?.pos_group || posMismatch;
      box.title = posMismatch ? `Only ${lockedPos} players can be compared together` : "Select to compare";
    });
    updateShortlistCompareButton();
  });
  els.btnShortlistClearCompare?.addEventListener("click", () => {
    if (!state.shortlistCompareUids.size) return;
    state.shortlistCompareUids.clear();
    renderShortlist();
  });
  els.btnShortlistCompare?.addEventListener("click", async () => {
    const picked = [...state.shortlistCompareUids]
      .map((uid) => state.shortlist[uid])
      .filter((p) => p && p.pos_group);
    if (picked.length < 2) return;
    const primary = picked[0];
    const samePos = picked.filter((p) => p.pos_group === primary.pos_group);
    if (samePos.length < 2) {
      showToast("Select players in the same position group to compare");
      return;
    }
    const dataset = await loadPosition(primary.pos_group, state.season).catch(() => null);
    if (!dataset) return;
    const primaryRow = dataset.players.find((r) => r.uid === primary.uid);
    const extraRows = samePos
      .slice(1)
      .map((s) => dataset.players.find((r) => r.uid === s.uid))
      .filter(Boolean);
    if (!primaryRow || !extraRows.length) {
      showToast("Selected players unavailable in current season");
      return;
    }
    els.shortlistDialog.close();
    openPlayerDialog(primaryRow, dataset, state.season, loadPosition, {
      compareUid: extraRows[0].uid,
      extraComparePlayers: extraRows,
    });
  });
  els.shortlistBody.addEventListener("input", (event) => {
    const noteInput = event.target.closest(".shortlist-note-input");
    if (!noteInput) return;
    const itemEl = noteInput.closest("[data-uid]");
    const uid = itemEl?.dataset.uid;
    if (!uid || !state.shortlist[uid]) return;
    state.shortlist[uid].note = noteInput.value;
    saveShortlist();
    state.tabulatorTable?.getRow(uid)?.reformat?.();
    const savedBadge = itemEl.querySelector(".shortlist-note-saved");
    if (savedBadge) {
      savedBadge.hidden = false;
      clearTimeout(savedBadge._timer);
      savedBadge._timer = setTimeout(() => {
        if (savedBadge.isConnected) savedBadge.hidden = true;
      }, 1500);
    }
  });
  els.shortlistBody.addEventListener("click", (event) => {
    const button = event.target.closest("button[data-action]");
    if (!button) return;
    const player = state.shortlist[button.closest("[data-uid]")?.dataset.uid];
    if (!player) return;
    if (button.dataset.action === "profile") openShortlistedPlayer(player, button, loadPosition);
    else if (button.dataset.action === "copy-name") copyPlayerName(player);
    else if (button.dataset.action === "remove") {
      delete state.shortlist[player.uid];
      saveShortlist();
      window.dispatchEvent(new Event("moneyball:shortlist-changed"));
      renderShortlist();
      state.tabulatorTable?.getRow(player.uid)?.reformat?.();
    }
  });
  els.btnClearShortlist.addEventListener("click", () => {
    const prev = { ...state.shortlist };
    const count = Object.keys(prev).length;
    if (!count) return;
    state.shortlist = {};
    saveShortlist();
    window.dispatchEvent(new Event("moneyball:shortlist-changed"));
    renderShortlist();
    state.tabulatorTable?.getRows().forEach((r) => r.reformat());
    showToast(`Cleared ${count} shortlisted player${count > 1 ? "s" : ""}`, {
      actionLabel: "Undo",
      onAction: () => {
        state.shortlist = { ...prev, ...state.shortlist };
        saveShortlist();
        window.dispatchEvent(new Event("moneyball:shortlist-changed"));
        if (els.shortlistDialog.open) renderShortlist();
        state.tabulatorTable?.getRows().forEach((r) => r.reformat());
      },
    });
  });

  let shortlistScatterRaf = null;
  window.addEventListener("moneyball:shortlist-changed", () => {
    if (shortlistScatterRaf) cancelAnimationFrame(shortlistScatterRaf);
    shortlistScatterRaf = requestAnimationFrame(() => {
      const dataset = activeDataset();
      if (dataset) renderScatter(dataset, openDialog);
    });
  });

  els.btnExportCsv.addEventListener("click", () => {
    const dataset = activeDataset();
    if (!dataset) return;
    const exportRows = state.tabulatorTable ? state.tabulatorTable.getData("active") : state.filtered;
    const visibleFields = state.tabulatorTable
      ? state.tabulatorTable
          .getColumns()
          .filter((c) => c.isVisible() && c.getField())
          .map((c) => c.getField())
      : null;
    downloadCsv(exportRows, `moneyball_scout_${state.pos}.csv`, dataset, visibleFields);
  });

  els.btnExportShortlist.addEventListener("click", () => {
    const items = filteredShortlist();
    if (!items.length) return;
    const cols = ["name", "club", "league", "nation", "foot", "age", "positions", "pos_group", "minutes", "avg_rating", "active_score", "value", "wage", "contract_end", "note"];
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

  const redrawTheme = () => {
    const dataset = activeDataset();
    if (!dataset) return;
    renderScatter(dataset, openDialog);
    if (els.playerDialog.open && state.activeProfile?.dataset) {
      els.dialogCompareSelect.onchange();
      if (!els.progressionChart.hidden) {
        const { player, dataset: profileDataset, season } = state.activeProfile;
        renderPlayerProgression(player, profileDataset.position, season, state.dialogOpenToken, loadPosition, state.activeComparePlayers || []);
      }
    }
    state.tabulatorTable?.redraw(true);
  };

  const COLOR_SCHEME_KEY = "fm27_moneyball_color_scheme";
  const mq = window.matchMedia("(prefers-color-scheme: dark)");
  mq.addEventListener("change", redrawTheme);

  const metaScheme = document.querySelector('meta[name="color-scheme"]');
  els.btnThemeToggle?.addEventListener("click", () => {
    const target = isDarkColorScheme() ? "light" : "dark";
    const systemScheme = mq.matches ? "dark" : "light";
    if (target === systemScheme) {
      try {
        localStorage.removeItem(COLOR_SCHEME_KEY);
      } catch {}
      if (metaScheme) metaScheme.content = "light dark";
    } else {
      try {
        localStorage.setItem(COLOR_SCHEME_KEY, target);
      } catch {}
      if (metaScheme) metaScheme.content = target;
    }
    redrawTheme();
  });

  window.addEventListener("storage", (ev) => {
    if (ev.key !== COLOR_SCHEME_KEY || !metaScheme) return;
    metaScheme.content = ev.newValue === "light" || ev.newValue === "dark" ? ev.newValue : "light dark";
    redrawTheme();
  });
}

function updateStaleSaveIndicator(isStale) {
  if (!els.btnRefreshSave) return;
  const stale = Boolean(isStale);
  els.btnRefreshSave.classList.toggle("is-pending", stale);
  els.btnRefreshSave.title = stale
    ? "Newer FM27 save detected on disk — click to refresh"
    : "Rebuild scouting data from selected FM27 save";
  if (!els.btnRefreshSave.disabled) {
    els.btnRefreshSave.textContent = stale ? "Refresh Save •" : "Refresh Save";
  }
}

function renderServerControls(status) {
  updateStaleSaveIndicator(status.newest_save_stale);
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
    const preferred = state.meta?.save_path && saves.some((s) => s.path === state.meta.save_path)
      ? state.meta.save_path
      : prevSave;
    if (preferred && saves.some((s) => s.path === preferred)) {
      els.saveSelect.value = preferred;
    }
  } else {
    els.saveSelect.innerHTML = `<option value="">No .fm saves found</option>`;
  }
}

async function pollBuildUntilDone(initialStatus) {
  let latest = initialStatus;
  const deadline = Date.now() + 300_000;
  while (latest.building) {
    if (Date.now() > deadline) {
      throw new Error("Timed out waiting for save build");
    }
    await new Promise((resolve) => setTimeout(resolve, 600));
    const res = await fetch("/api/status");
    if (!res.ok) throw new Error(`Status check failed (HTTP ${res.status})`);
    latest = await res.json();
  }
  if (latest.last_error) {
    throw new Error(latest.last_error);
  }
  return latest;
}

async function refreshFromSave(savePath = null, options = {}) {
  const background = Boolean(options?.background);
  els.btnRefreshSave.disabled = true;
  if (els.saveSelect) els.saveSelect.disabled = true;
  if (els.seasonSelect) els.seasonSelect.disabled = true;
  els.btnRefreshSave.classList.add("is-loading");
  const startedAt = Date.now();
  const updateRefreshLabel = () => {
    const secs = Math.floor((Date.now() - startedAt) / 1000);
    const msg = secs > 0 ? `Reading .fm save (${secs}s)...` : "Reading .fm save...";
    els.btnRefreshSave.textContent = msg;
    if (background && els.refreshBannerText) {
      els.refreshBannerText.textContent = `Refreshing FM27 save in background (${secs}s)…`;
    }
  };
  updateRefreshLabel();
  const timer = setInterval(updateRefreshLabel, 1000);
  if (background && els.refreshBanner) {
    els.refreshBanner.hidden = false;
  } else {
    els.poolSummary.textContent = "Reading current FM27 save and updating season archive...";
  }
  try {
    const res = await fetch("/api/refresh", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ save_path: savePath }),
    });
    let data = await res.json();
    if (!res.ok || data.error) {
      throw new Error(data.error || `HTTP ${res.status}`);
    }
    if (res.status === 202 || data.building) {
      data = await pollBuildUntilDone(data);
    }
    state.cache.clear();
    state.season = data.latest_season || state.season;
    renderServerControls(data);
    await loadMeta(state.season);
    await selectPosition(state.pos);
    showToast("Save refreshed");
    return true;
  } catch (err) {
    if (!background) {
      els.poolSummary.textContent = `Save refresh failed: ${err.message}`;
    }
    showToast(`Save refresh failed: ${err.message}`);
    return false;
  } finally {
    clearInterval(timer);
    if (els.refreshBanner) els.refreshBanner.hidden = true;
    els.btnRefreshSave.classList.remove("is-loading");
    els.btnRefreshSave.disabled = false;
    if (els.saveSelect) els.saveSelect.disabled = false;
    if (els.seasonSelect) els.seasonSelect.disabled = false;
    els.btnRefreshSave.textContent = els.btnRefreshSave.classList.contains("is-pending")
      ? "Refresh Save •"
      : "Refresh Save";
  }
}

let lastStatusPoll = 0;
function wireStaleSaveCheck() {
  const checkStatus = async () => {
    if (document.hidden || els.btnRefreshSave?.disabled) return;
    const now = Date.now();
    if (now - lastStatusPoll < 10_000) return;
    lastStatusPoll = now;
    try {
      const res = await fetch("/api/status");
      if (!res.ok) return;
      const status = await res.json();
      updateStaleSaveIndicator(status.newest_save_stale);
    } catch {
      // Static fallback
    }
  };
  window.addEventListener("focus", checkStatus);
  document.addEventListener("visibilitychange", () => {
    if (!document.hidden) checkStatus();
  });
}

async function init() {
  saveShortlist();
  renderSavedViewsSelect();
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
  } else {
    document.querySelectorAll(".server-only").forEach((el) => {
      el.hidden = true;
    });
  }
  wireStaleSaveCheck();

  const params = new URLSearchParams(window.location.search);
  const shouldAutoRefresh = params.get("auto_refresh") === "1" && serverStatus?.newest_save_stale;
  if (params.has("auto_refresh")) {
    params.delete("auto_refresh");
    const qs = params.toString();
    const cleanUrl = `${window.location.pathname}${qs ? `?${qs}` : ""}${window.location.hash}`;
    window.history.replaceState(null, "", cleanUrl);
  }

  if (els.btnRestoreView && state.lastView && isNonDefaultView(state.lastView) && !shouldAutoRefresh) {
    els.btnRestoreView.hidden = false;
  }

  await loadMeta(state.season);
  await selectPosition("ST");

  if (shouldAutoRefresh) {
    refreshFromSave(serverStatus.saves?.[0]?.path || null, { background: true });
  }
}

init().catch((err) => {
  els.poolSummary.textContent = `Error loading scouting data: ${err.message}`;
});
