import { collator } from "./constants.js";
import { els, saveShortlist, state } from "./state.js";
import { getProfileDisplayMetrics, renderPlayerProgression, renderRadar } from "./charts.js";
import { readScalarFilters } from "./filters.js";
import { getBaselinePool, getPlayerMetricPct } from "./scoring.js";
import {
  clubImgUrl,
  clubNameOf,
  escapeHtml,
  formatMoney,
  formatPlayerValue,
  formatStat,
  normalizeSearchText,
  parsePlayerPositions,
  pctClass,
  personImgUrl,
  playerName,
  showToast,
} from "./utils.js";

function renderProfileFacts(element, facts) {
  element.innerHTML = facts
    .map(([label, value]) => `<div><dt>${escapeHtml(label)}</dt><dd>${escapeHtml(value ?? "—")}</dd></div>`)
    .join("");
}

function getOrderedTableRows() {
  if (state.tabulatorTable) {
    try {
      const rows = state.tabulatorTable.getData("active");
      if (Array.isArray(rows) && rows.length) return rows;
    } catch {
      // Fallback to state.filtered
    }
  }
  return state.filtered || [];
}

function updatePrevNextButtons(player, dataset) {
  if (!els.dialogPrevPlayer || !els.dialogNextPlayer) return;
  const rows = dataset ? getOrderedTableRows() : [];
  const idx = rows.findIndex((r) => r.uid === player.uid);
  const canStep = Boolean(dataset) && idx >= 0 && rows.length > 1;
  els.dialogPrevPlayer.disabled = !canStep || idx <= 0;
  els.dialogNextPlayer.disabled = !canStep || idx >= rows.length - 1;
  if (els.dialogRowPos) {
    if (Boolean(dataset) && idx >= 0) {
      els.dialogRowPos.textContent = `${idx + 1} / ${rows.length}`;
      els.dialogRowPos.hidden = false;
    } else {
      els.dialogRowPos.textContent = "";
      els.dialogRowPos.hidden = true;
    }
  }
}

export function stepPlayerDialog(delta, loadPositionFn) {
  const active = state.activeProfile;
  if (!active?.dataset) return;
  const rows = getOrderedTableRows();
  const idx = rows.findIndex((r) => r.uid === active.player.uid);
  const next = rows[idx + delta];
  if (!next) return;
  openPlayerDialog(next, active.dataset, active.season, loadPositionFn, { preserveCompare: true });
}

export function openPlayerDialog(player, dataset, season = state.season, loadPositionFn, options = {}) {
  const prevCompare =
    options?.compareUid !== undefined
      ? options.compareUid
      : options?.preserveCompare
        ? els.dialogCompareSelect?.value
        : undefined;
  state.activeProfile = { player, dataset, season };
  state.dialogOpenToken += 1;
  const openToken = state.dialogOpenToken;
  updatePrevNextButtons(player, dataset);
  const dialogBody = els.playerDialog?.querySelector(".dialog-body");
  if (dialogBody) dialogBody.scrollTop = 0;

  els.dialogPlayerImg.src = personImgUrl(player);
  els.dialogPlayerImg.alt = playerName(player);
  els.dialogClubImg.src = clubImgUrl(player.club_img_id || player.club_uid, clubNameOf(player));
  els.dialogClubImg.alt = clubNameOf(player);
  els.dialogName.textContent = playerName(player);
  els.dialogCopyName.disabled = !player.name;
  els.dialogMeta.textContent = [clubNameOf(player), player.league].filter(Boolean).join(" · ");

  if (els.dialogScorePill) {
    const rawScore = player.active_score ?? player.score_overall;
    if (dataset && rawScore != null && Number.isFinite(Number(rawScore))) {
      const numScore = Number(rawScore);
      els.dialogScorePill.textContent = `Score ${numScore.toFixed(1)}`;
      els.dialogScorePill.className = `pct-pill ${pctClass(Math.round(numScore))}`;
      els.dialogScorePill.hidden = false;
    } else {
      els.dialogScorePill.hidden = true;
    }
  }

  const accomplishedList = parsePlayerPositions(player.accomplished);
  renderProfileFacts(els.dialogProfileFacts, [
    ["Age", player.age],
    ["Nationality", player.nation || "—"],
    ["Height", player.height_cm > 0 ? `${player.height_cm} cm` : "—"],
    ["Preferred Foot", player.foot || "—"],
    ["Natural Positions", parsePlayerPositions(player.positions).join(", ") || "—"],
    ...(accomplishedList.length ? [["Accomplished", accomplishedList.join(", ")]] : []),
    ["Transfer Value", formatPlayerValue(player)],
    ["Weekly Wage", formatMoney(player.wage)],
    ["Contract Ends", player.contract_end || "—"],
    ...(player.on_loan ? [["On Loan From", player.loan_parent || "—"]] : []),
  ]);

  if (els.dialogRolesSection && els.dialogRoleScores) {
    const roleEntries = [];
    if (dataset && player.score_overall != null) {
      roleEntries.push(["Overall", Number(player.score_overall)]);
    }
    for (const [slug, info] of Object.entries(dataset?.roles || {})) {
      const val = player[`score_${slug}`];
      if (val != null && Number.isFinite(Number(val))) {
        roleEntries.push([info.label, Number(val)]);
      }
    }
    if (roleEntries.length) {
      roleEntries.sort((a, b) => b[1] - a[1]);
      els.dialogRolesSection.hidden = false;
      renderProfileFacts(
        els.dialogRoleScores,
        roleEntries.map(([label, score]) => [label, score.toFixed(1)])
      );
    } else {
      els.dialogRolesSection.hidden = true;
    }
  }

  const seasonLabel = season || state.meta?.season;
  els.dialogSeasonHeading.textContent = seasonLabel ? `League Season Stats · ${seasonLabel}` : "League Season Stats";
  const seasonStats = [
    ["apps", "Appearances"],
    ["starts", "Starts"],
    ["minutes", "Minutes"],
    ["goals", "Goals"],
    ["assists", "Assists"],
    ["avg_rating", "Average Rating"],
  ];
  if (dataset?.position === "GK") {
    seasonStats.push(["save_pct", "Save %"], ["clean_sheet_pct", "Clean Sheet %"]);
  }
  const hasSeasonStats = player.minutes != null;
  els.dialogSeasonEmpty.hidden = hasSeasonStats;
  els.dialogSeasonStats.hidden = !hasSeasonStats;
  renderProfileFacts(
    els.dialogSeasonStats,
    seasonStats.map(([key, label]) => [label, formatStat(key, player[key])])
  );

  const isSaved = Boolean(state.shortlist[player.uid]);
  els.dialogShortlistBtn.textContent = isSaved ? "Remove from Shortlist" : "Add to Shortlist";
  if (els.dialogPinCompare) {
    const isPinned = state.pinnedCompare?.uid === player.uid;
    els.dialogPinCompare.textContent = isPinned ? "Unpin Compare" : "Pin Compare";
    els.dialogPinCompare.setAttribute("aria-pressed", String(isPinned));
    els.dialogPinCompare.hidden = !dataset;
  }
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
  const seenCompareUids = new Set([player.uid, ...hullPool.map((h) => h.uid), ...hullOther.map((h) => h.uid)]);
  const pinnedCmp =
    state.pinnedCompare &&
    state.pinnedCompare.position === dataset.position &&
    !seenCompareUids.has(state.pinnedCompare.player.uid)
      ? state.pinnedCompare.player
      : null;
  if (pinnedCmp) seenCompareUids.add(pinnedCmp.uid);
  const shortlistCompare = dataset.players.filter((p) => {
    if (seenCompareUids.has(p.uid) || !state.shortlist[p.uid]) return false;
    seenCompareUids.add(p.uid);
    return true;
  });
  const extraCompare = (options?.extraComparePlayers || []).filter((p) => {
    if (!p || seenCompareUids.has(p.uid)) return false;
    seenCompareUids.add(p.uid);
    return true;
  });

  if (els.dialogCompareSearch) els.dialogCompareSearch.value = "";

  const rebuildCompareOptions = (searchQuery = "") => {
    const q = normalizeSearchText(searchQuery);
    const searchMatches = q
      ? dataset.players
          .filter(
            (p) =>
              p.uid !== player.uid &&
              normalizeSearchText(`${playerName(p)} ${clubNameOf(p)}`).includes(q)
          )
          .slice(0, 25)
      : [];

    const curVal = els.dialogCompareSelect.value;
    const fmtOpt = (p, showClub = true) =>
      `<option value="${escapeHtml(p.uid)}">${escapeHtml(playerName(p))} (${escapeHtml(
        showClub ? clubNameOf(p) : p.positions
      )}, ${p.minutes}m)</option>`;

    els.dialogCompareSelect.innerHTML = [
      `<option value="">No comparison</option>`,
      ...hullPool.map((h) => fmtOpt(h, false)),
      ...(hullOther.length
        ? [`<optgroup label="Managed Squad (Other Pos)">${hullOther.map((h) => fmtOpt(h, false)).join("")}</optgroup>`]
        : []),
      ...(pinnedCmp ? [`<optgroup label="Pinned">${fmtOpt(pinnedCmp)}</optgroup>`] : []),
      ...(extraCompare.length
        ? [`<optgroup label="Selected">${extraCompare.map((e) => fmtOpt(e)).join("")}</optgroup>`]
        : []),
      ...(shortlistCompare.length
        ? [`<optgroup label="Shortlisted">${shortlistCompare.map((s) => fmtOpt(s)).join("")}</optgroup>`]
        : []),
      ...(searchMatches.length
        ? [`<optgroup label="Search Matches">${searchMatches.map((m) => fmtOpt(m)).join("")}</optgroup>`]
        : []),
    ].join("");

    if (searchMatches.length && q) {
      els.dialogCompareSelect.value = searchMatches[0].uid;
    } else if (curVal && [...els.dialogCompareSelect.options].some((o) => o.value === curVal)) {
      els.dialogCompareSelect.value = curVal;
    }
  };

  rebuildCompareOptions("");

  const benchUid = els.benchmark.value;
  if (
    prevCompare !== undefined &&
    prevCompare !== player.uid &&
    (prevCompare === "" || [...els.dialogCompareSelect.options].some((o) => o.value === prevCompare))
  ) {
    els.dialogCompareSelect.value = prevCompare;
  } else if (pinnedCmp) {
    els.dialogCompareSelect.value = pinnedCmp.uid;
  } else if (benchUid && benchUid !== player.uid && [...els.dialogCompareSelect.options].some((o) => o.value === benchUid)) {
    els.dialogCompareSelect.value = benchUid;
  }

  const scalar = readScalarFilters();
  const baseline = getBaselinePool(dataset, scalar.minMins, scalar.minRep, scalar.dynamicPct);
  const displayMetrics = getProfileDisplayMetrics(dataset);
  const playerByUid = new Map(dataset.players.map((p) => [p.uid, p]));
  for (const h of hullOther) {
    if (!playerByUid.has(h.uid)) playerByUid.set(h.uid, h);
  }

  const renderMetricRows = (cmp) => {
    if (els.dialogCompareLegend) {
      if (cmp) {
        els.dialogCompareLegend.textContent = `vs ${playerName(cmp)}`;
        els.dialogCompareLegend.hidden = false;
      } else {
        els.dialogCompareLegend.hidden = true;
      }
    }
    els.dialogStatsList.innerHTML = displayMetrics
      .map((m) => {
        const pct = getPlayerMetricPct(player, m.key, dataset, baseline);
        const cmpHtml = cmp
          ? (() => {
              const cmpPct = getPlayerMetricPct(cmp, m.key, dataset, baseline);
              return `<span class="stat-cmp-val">vs ${formatStat(m.key, cmp[m.key])} <span class="pct-pill ${pctClass(cmpPct)}">${cmpPct}</span></span>`;
            })()
          : "";
        return `
          <div class="stat-row">
            <span>${escapeHtml(m.label)}</span>
            <div class="stat-vals">
              <strong>${formatStat(m.key, player[m.key])}</strong>
              <span class="pct-pill ${pctClass(pct)}">${pct}</span>
              ${cmpHtml}
            </div>
            <div class="stat-bar-wrap"><div class="stat-bar-fill ${pctClass(pct)}" style="width:${pct}%"></div></div>
          </div>
        `;
      })
      .join("");
  };

  const drawCompare = () => {
    const cid = els.dialogCompareSelect.value;
    const cmp = cid ? playerByUid.get(cid) || null : null;
    const clubLabel = cmp?.is_hull && season === state.season ? state.meta?.club_short_name || "Club" : clubNameOf(cmp);
    renderRadar(player, cmp, dataset, baseline, clubLabel);
    renderMetricRows(cmp);
  };
  els.dialogCompareSelect.onchange = drawCompare;
  if (els.dialogCompareSearch) {
    els.dialogCompareSearch.oninput = () => {
      rebuildCompareOptions(els.dialogCompareSearch.value);
      drawCompare();
    };
  }

  renderMetricRows(null);
  els.progressionChart.hidden = true;
  if (els.dialogProgressionMetric) {
    els.dialogProgressionMetric.value = "";
    els.dialogProgressionMetric.hidden = true;
  }
  els.dialogProgressionEmpty.hidden = true;
  els.playerDialog.showModal();

  requestAnimationFrame(() => {
    if (!els.playerDialog.open || state.dialogOpenToken !== openToken) return;
    drawCompare();
    renderPlayerProgression(player, dataset.position, season, openToken, loadPositionFn);
  });
}

export function toggleRowShortlist(player, position = state.pos, season = state.season) {
  const uid = player.uid;
  const name = playerName(player);
  if (state.shortlist[uid]) {
    delete state.shortlist[uid];
    state.shortlistCompareUids.delete(uid);
    saveShortlist();
    window.dispatchEvent(new Event("moneyball:shortlist-changed"));
    showToast(`Removed ${name} from shortlist`);
    return false;
  }
  state.shortlist[uid] = {
    uid,
    name: player.name ?? "",
    img_id: player.img_id ?? "",
    club_uid: player.club_uid ?? "",
    club_img_id: player.club_img_id ?? "",
    club: clubNameOf(player),
    league: player.league ?? "",
    nation: player.nation ?? "",
    foot: player.foot ?? "",
    age: player.age,
    positions: player.positions,
    minutes: player.minutes,
    avg_rating: player.avg_rating,
    active_score: player.active_score,
    value: player.value,
    value_state: player.value_state,
    wage: player.wage,
    contract_end: player.contract_end,
    pos_group: position,
    season,
    note: "",
    added_at: Date.now(),
    ...(position ? {} : { profile: player }),
  };
  saveShortlist();
  window.dispatchEvent(new Event("moneyball:shortlist-changed"));
  showToast(`Added ${name} to shortlist`);
  return true;
}

function enrichShortlistEntry(entry) {
  const filteredMatch = state.filtered?.find((r) => r.uid === entry.uid);
  const cachedDs = entry.pos_group ? state.cache.get(`${state.season || "latest"}:${entry.pos_group}`) : null;
  const cachedMatch = filteredMatch || cachedDs?.players?.find((p) => p.uid === entry.uid);
  if (!cachedMatch) return entry;
  return {
    ...entry,
    img_id: cachedMatch.img_id ?? entry.img_id,
    club_uid: cachedMatch.club_uid ?? entry.club_uid,
    club_img_id: cachedMatch.club_img_id ?? entry.club_img_id,
    club: clubNameOf(cachedMatch),
    league: cachedMatch.league ?? entry.league,
    age: cachedMatch.age ?? entry.age,
    minutes: cachedMatch.minutes ?? entry.minutes,
    avg_rating: cachedMatch.avg_rating ?? entry.avg_rating,
    active_score: filteredMatch?.active_score ?? cachedMatch.score_overall ?? entry.active_score,
    value: cachedMatch.value ?? entry.value,
    value_state: cachedMatch.value_state ?? entry.value_state,
    wage: cachedMatch.wage ?? entry.wage,
    contract_end: cachedMatch.contract_end ?? entry.contract_end,
  };
}

export function filteredShortlist() {
  const position = els.shortlistPosition.value;
  const sortBy = els.shortlistSort?.value || "added";
  const query = normalizeSearchText(els.shortlistSearch?.value);
  const saved = Object.values(state.shortlist).map(enrichShortlistEntry);
  const list = saved.filter((player) => {
    if (position && !parsePlayerPositions(player.positions).includes(position)) return false;
    if (query) {
      const hay = normalizeSearchText(`${player.name ?? ""} ${player.club ?? ""} ${player.league ?? ""} ${player.note ?? ""}`);
      if (!hay.includes(query)) return false;
    }
    return true;
  });
  if (sortBy === "score") {
    list.sort((a, b) => (Number(b.active_score) || -1) - (Number(a.active_score) || -1) || collator.compare(playerName(a), playerName(b)));
  } else if (sortBy === "value") {
    list.sort((a, b) => {
      const av = Number.isFinite(Number(a.value)) && a.value != null ? Number(a.value) : Infinity;
      const bv = Number.isFinite(Number(b.value)) && b.value != null ? Number(b.value) : Infinity;
      return av - bv || collator.compare(playerName(a), playerName(b));
    });
  } else if (sortBy === "age") {
    list.sort((a, b) => (Number(a.age) || 999) - (Number(b.age) || 999) || collator.compare(playerName(a), playerName(b)));
  } else if (sortBy === "name") {
    list.sort((a, b) => collator.compare(playerName(a), playerName(b)));
  } else {
    list.sort((a, b) => (Number(b.added_at) || 0) - (Number(a.added_at) || 0));
  }
  return list;
}

export function updateShortlistCompareButton() {
  if (!els.btnShortlistCompare) return;
  const cnt = state.shortlistCompareUids.size;
  els.btnShortlistCompare.textContent = `Compare Selected (${cnt})`;
  els.btnShortlistCompare.hidden = cnt < 2;
}

export async function refreshShortlistDatasets(loadPositionFn) {
  if (!loadPositionFn) return;
  const groups = [...new Set(Object.values(state.shortlist).map((p) => p.pos_group).filter(Boolean))];
  let loadedAny = false;
  await Promise.all(
    groups.map(async (grp) => {
      const key = `${state.season || "latest"}:${grp}`;
      if (state.cache.has(key)) return;
      try {
        await loadPositionFn(grp, state.season);
        loadedAny = true;
      } catch {
        // Ignore unavailable position dataset
      }
    })
  );
  if (loadedAny && els.shortlistDialog?.open) renderShortlist();
}

export function renderShortlist() {
  const saved = Object.values(state.shortlist);
  const positions = [...new Set(saved.flatMap((player) => parsePlayerPositions(player.positions)))].sort(collator.compare);
  const selected = els.shortlistPosition.value;
  els.shortlistPosition.replaceChildren(new Option("All Positions", ""), ...positions.map((position) => new Option(position)));
  els.shortlistPosition.value = positions.includes(selected) ? selected : "";
  els.shortlistPosition.disabled = !positions.length;

  const items = filteredShortlist();
  els.btnExportShortlist.disabled = !items.length;
  els.btnClearShortlist.disabled = !saved.length;
  updateShortlistCompareButton();

  els.shortlistBody.innerHTML = items.length
    ? items
        .map((player) => {
          const scorePill =
            player.active_score != null && Number.isFinite(Number(player.active_score))
              ? `<span class="pct-pill ${pctClass(Math.round(Number(player.active_score)))}">${Number(player.active_score).toFixed(1)}</span>`
              : "";
          const isCmp = state.shortlistCompareUids.has(player.uid);
          const posTag = player.pos_group ? `<span class="score-default-tag">${escapeHtml(player.pos_group)}</span>` : "";
          return `
    <div class="shortlist-item" data-uid="${escapeHtml(player.uid)}">
      <div class="shortlist-item-check">
        <input type="checkbox" class="shortlist-compare-cb" data-uid="${escapeHtml(player.uid)}" ${
            isCmp ? "checked" : ""
          } ${player.pos_group ? "" : "disabled"} title="Select to compare" aria-label="Select ${escapeHtml(playerName(player))} to compare">
        <img class="tab-avatar" src="${personImgUrl(player)}" alt="" width="34" height="34" loading="lazy" decoding="async">
      </div>
      <div class="shortlist-item-main">
        <div class="shortlist-item-title">
          <button type="button" class="player-link" data-action="profile">${escapeHtml(playerName(player))}</button>
          ${scorePill}
          ${posTag}
          <img class="tab-crest" src="${clubImgUrl(player.club_img_id || player.club_uid, clubNameOf(player))}" alt="" width="16" height="16" loading="lazy" decoding="async">
          <span>${escapeHtml(clubNameOf(player))} · Age ${escapeHtml(player.age ?? "?")} · ${escapeHtml(parsePlayerPositions(player.positions).join(", ") || "—")}</span>
        </div>
        <div class="subtitle">Mins ${escapeHtml(player.minutes ?? "—")} · Value ${escapeHtml(formatPlayerValue(player))} · Wage ${
            player.wage == null ? "—" : `${formatMoney(player.wage)}/wk`
          } · Contract ${escapeHtml(player.contract_end || "—")}</div>
        <input type="text" class="shortlist-note-input" data-action="note" placeholder="Add scout note..." aria-label="Scout note for ${escapeHtml(playerName(player))}" value="${escapeHtml(player.note || "")}">
      </div>
      <div class="dialog-head-actions">
        <button type="button" class="btn secondary" data-action="copy-name" ${player.name ? "" : "disabled"}>Copy Name</button>
        <button type="button" class="btn secondary remove-shortlist-btn" data-action="remove">Remove</button>
      </div>
    </div>
  `;
        })
        .join("")
    : `<p class="subtitle">${
        saved.length
          ? "No shortlisted players match your search or position filter."
          : "No players shortlisted yet. Select the star next to a player to add them."
      }</p>`;
}

export async function openShortlistedPlayer(saved, button, loadPositionFn, options = {}) {
  if (saved.profile) {
    openPlayerDialog(saved.profile, null, saved.season, loadPositionFn, options);
    return;
  }
  if (button) button.disabled = true;
  const seasons = new Set([state.season, saved.season ?? state.season, ...state.seasons.map((entry) => entry.season)]);
  try {
    for (const season of seasons) {
      const dataset = await loadPositionFn(saved.pos_group, season).catch(() => null);
      if (button && (!els.shortlistDialog.open || !button.isConnected || els.playerDialog.open)) return;
      const player = dataset?.players.find((row) => row.uid === saved.uid);
      if (player) {
        if (button) button.disabled = false;
        openPlayerDialog(player, dataset, season, loadPositionFn, options);
        return;
      }
    }
    showToast("Player unavailable in the saved archive");
  } finally {
    if (button) button.disabled = false;
  }
}
