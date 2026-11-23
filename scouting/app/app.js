import {
  CLUB_PAGE_SIZE,
  MIN_FILTERS,
  POS_LABELS,
  SQUAD_PAGE_SIZE,
  collator,
} from "./modules/constants.js";
import {
  FACETS,
  activeDataset,
  els,
  saveShortlist,
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
  getClubCatalog,
  matchesLocation,
  matchesPlayer,
  matchesSearch,
  readScalarFilters,
  renderActiveFilterChips,
  renderAllPopovers,
  renderFacetOptions,
  resetAllFilters,
  wirePopoverBehaviors,
} from "./modules/filters.js";
import {
  populateScatterAxes,
  renderPlayerProgression,
  renderScatter,
} from "./modules/charts.js";
import {
  filteredShortlist,
  openPlayerDialog,
  openShortlistedPlayer,
  renderShortlist,
  toggleRowShortlist,
} from "./modules/profile.js";
import { initOrUpdateTable, renderColumnChooser } from "./modules/table.js";
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
  populateContractOptions();
}

function populatePositionControls(dataset) {
  const samePosition = state.scoreConfig?.pos === dataset.position;
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
  openDialog(scoutingRow || player, scoutingRow ? dataset : null, season);
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

  const { rows, baseline } = computePoolRows(dataset, readScalarFilters(), matchesPlayer);
  rows.sort((a, b) => b.active_score - a.active_score);
  state.filtered = rows;
  state.squadLimit = SQUAD_PAGE_SIZE;

  const repNote = datasetHasClubReputation(dataset) ? `rep ≥ ${els.minRep.value}` : "rep n/a";
  const pctMode = !baseline.isGlobal
    ? `Dynamic percentiles vs ${baseline.peerCount.toLocaleString()} peers (mins ≥ ${els.minMins.value}, ${repNote})`
    : `Global ≥${dataset.baseline_minutes || 900}m percentiles`;
  const clubLabel = state.meta?.club_short_name || "Managed Club";
  els.poolSummary.textContent = `${rows.length.toLocaleString()} targets matched · ${pctMode} · ${clubLabel} highlighted in amber`;

  renderAllPopovers(dataset);
  renderActiveFilterChips(dataset, refreshView);
  renderSearchSuggestions();
  renderSquadProfiles();
  renderScatter(dataset, openDialog);
  return initOrUpdateTable(dataset, rows, openDialog);
}

async function selectPosition(pos, focusTab = false) {
  const request = ++state.positionRequest;
  state.pos = pos;
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
      if (dataset) renderScatter(dataset, openDialog);
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

  wirePopoverBehaviors({ onRefresh: refreshView, onOpenColumnChooser: renderColumnChooser });
  wireScoreDialogEvents(refreshView);

  document.addEventListener("keydown", (ev) => {
    if (ev.key !== "/" || ev.metaKey || ev.ctrlKey || ev.altKey) return;
    if (document.querySelector("dialog[open]")) return;
    const target = ev.target;
    if (target && target.closest("input, textarea, select, [contenteditable='true']")) return;
    ev.preventDefault();
    els.search.focus();
    els.search.select();
  });

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
    if (button.dataset.action === "profile") openShortlistedPlayer(player, button, loadPosition);
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

  const mq = window.matchMedia("(prefers-color-scheme: dark)");
  mq.addEventListener("change", () => {
    const dataset = activeDataset();
    if (!dataset) return;
    renderScatter(dataset, openDialog);
    if (els.playerDialog.open && state.activeProfile?.dataset) {
      els.dialogCompareSelect.onchange();
      if (!els.progressionChart.hidden) {
        const { player, dataset: profileDataset, season } = state.activeProfile;
        renderPlayerProgression(player, profileDataset.position, season, state.dialogOpenToken, loadPosition);
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
