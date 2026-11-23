import { collator } from "./constants.js";
import { els, saveShortlist, state } from "./state.js";
import { renderPlayerProgression, renderRadar } from "./charts.js";
import { readScalarFilters } from "./filters.js";
import { getBaselinePool, getPlayerMetricPct } from "./scoring.js";
import {
  clubImgUrl,
  clubNameOf,
  escapeHtml,
  formatMoney,
  formatStat,
  parsePlayerPositions,
  pctClass,
  personImgUrl,
  playerName,
  showToast,
} from "./utils.js";

function renderProfileFacts(element, facts) {
  element.innerHTML = facts.map(([label, value]) =>
    `<div><dt>${escapeHtml(label)}</dt><dd>${escapeHtml(value ?? "—")}</dd></div>`
  ).join("");
}

export function openPlayerDialog(player, dataset, season = state.season, loadPositionFn) {
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
    renderPlayerProgression(player, dataset.position, season, openToken, loadPositionFn);
  });
}

export function toggleRowShortlist(player, position = state.pos, season = state.season) {
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

export function filteredShortlist() {
  const position = els.shortlistPosition.value;
  const saved = Object.values(state.shortlist);
  return position ? saved.filter((player) => parsePlayerPositions(player.positions).includes(position)) : saved;
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

export async function openShortlistedPlayer(saved, button, loadPositionFn) {
  if (saved.profile) {
    openPlayerDialog(saved.profile, null, saved.season, loadPositionFn);
    return;
  }
  button.disabled = true;
  const seasons = new Set([state.season, saved.season ?? state.season, ...state.seasons.map((entry) => entry.season)]);
  try {
    for (const season of seasons) {
      const dataset = await loadPositionFn(saved.pos_group, season).catch(() => null);
      if (!els.shortlistDialog.open || !button.isConnected || els.playerDialog.open) return;
      const player = dataset?.players.find((row) => row.uid === saved.uid);
      if (player) {
        button.disabled = false;
        openPlayerDialog(player, dataset, season, loadPositionFn);
        return;
      }
    }
    showToast("Player unavailable in the saved archive");
  } finally {
    button.disabled = false;
  }
}
