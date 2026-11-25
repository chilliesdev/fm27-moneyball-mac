import { POS_LABELS } from "./constants.js";
import { activeDataset, els, saveColPrefs, seasonEndYear, state } from "./state.js";
import { toggleRowShortlist } from "./profile.js";
import { getMetricCatalog } from "./scoring.js";
import {
  clubImgUrl,
  clubNameOf,
  copyPlayerName,
  escapeHtml,
  formatMoney,
  formatPlayerValue,
  formatStat,
  normalizeSearchText,
  pctClass,
  personImgUrl,
  playerName,
  showToast,
} from "./utils.js";

const COPY_ICON_SVG = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>`;

export function updateCompareSelectedButton() {
  if (!els.btnCompareSelected || !els.compareSelectedCount) return;
  const count = state.selectedCompareUids.size;
  els.compareSelectedCount.textContent = String(count);
  els.btnCompareSelected.hidden = count < 2;
}

export function buildTabulatorColumns(dataset) {
  const pos = dataset.position;
  const savedCols = state.colPrefs?.[pos] || {};
  const catalog = getMetricCatalog(dataset);
  const clubTag = state.meta?.club_short_name || "CLUB";
  const endYr = seasonEndYear();
  const hidePcts = Boolean(state.uiPrefs?.hidePctPills);

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
      width: 280,
      minWidth: 215,
      hozAlign: "left",
      headerHozAlign: "left",
      sorter: "string",
      sorterParams: { alignEmptyValues: "bottom" },
      formatter: (cell) => {
        const p = cell.getRow().getData();
        const isSaved = Boolean(state.shortlist[p.uid]);
        const isCompared = state.selectedCompareUids.has(p.uid);
        const badge = p.is_hull ? `<span class="hull-badge">${escapeHtml(clubTag)}</span>` : "";
        return `
          <div class="tab-player-cell">
            <input type="checkbox" class="row-compare-cb" data-uid="${escapeHtml(p.uid)}" ${
              isCompared ? "checked" : ""
            } title="Select for comparison" aria-label="Select ${escapeHtml(playerName(p))} for comparison">
            <button type="button" class="row-star-btn ${isSaved ? "is-saved" : ""}" data-uid="${escapeHtml(
          p.uid
        )}" aria-pressed="${isSaved}" aria-label="${isSaved ? "Remove from shortlist" : "Add to shortlist"}">${
          isSaved ? "★" : "☆"
        }</button>
            <img class="tab-avatar" src="${personImgUrl(p)}" alt="" width="26" height="26" loading="lazy" decoding="async">
            <button type="button" class="player-link">${escapeHtml(playerName(p))}</button>
            ${badge}
            <button type="button" class="row-copy-btn" title="Copy player name" aria-label="Copy player name" ${
              p.name ? "" : "disabled"
            }>${COPY_ICON_SVG}</button>
          </div>
        `;
      },
      cellClick: (e, cell) => {
        const cmpCb = e.target.closest(".row-compare-cb");
        if (cmpCb) {
          e.stopPropagation();
          const uid = cmpCb.dataset.uid;
          if (cmpCb.checked) {
            if (state.selectedCompareUids.size >= 4) {
              cmpCb.checked = false;
              showToast("Select up to 4 players to compare");
              return;
            }
            state.selectedCompareUids.add(uid);
          } else {
            state.selectedCompareUids.delete(uid);
          }
          updateCompareSelectedButton();
          return;
        }
        const starBtn = e.target.closest(".row-star-btn");
        if (starBtn) {
          e.stopPropagation();
          const row = cell.getRow();
          toggleRowShortlist(row.getData());
          row.reformat();
          return;
        }
        const copyBtn = e.target.closest(".row-copy-btn");
        if (copyBtn) {
          e.stopPropagation();
          copyPlayerName(cell.getRow().getData());
        }
      },
    },
    {
      title: "Club",
      field: "club",
      width: 205,
      minWidth: 140,
      hozAlign: "left",
      headerHozAlign: "left",
      sorter: "string",
      sorterParams: { alignEmptyValues: "bottom" },
      visible: isVisible("club", true),
      formatter: (cell) => {
        const p = cell.getRow().getData();
        const cName = clubNameOf(p);
        const loanTag = p.on_loan ? `<span class="loan-badge" title="On loan${p.loan_parent ? ` from ${escapeHtml(p.loan_parent)}` : ""}">Loan</span>` : "";
        return `
          <div class="tab-club-cell">
            <img class="tab-crest" src="${clubImgUrl(p.club_img_id || p.club_uid, cName)}" alt="" width="20" height="20" loading="lazy" decoding="async">
            <div class="tab-club-text">
              <span class="tab-club-name">${escapeHtml(cName)} ${loanTag}</span>
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
      formatter: (cell) => cell.getValue() ?? "—",
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
      width: 96,
      sorter: "number",
      visible: isVisible("value", true),
      formatter: (cell) => formatPlayerValue(cell.getRow().getData()),
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
      width: 108,
      hozAlign: "left",
      headerHozAlign: "left",
      sorter: "string",
      visible: isVisible("contract_end", true),
      formatter: (cell) => {
        const raw = cell.getValue();
        if (!raw) return "—";
        const yr = Number(String(raw).slice(0, 4));
        const exp = Number.isFinite(yr) && yr > 0 && yr <= endYr;
        return exp
          ? `<span class="contract-expiring" title="Expiring soon">${escapeHtml(raw)}</span>`
          : escapeHtml(raw);
      },
    },
    {
      title: "Role Score",
      field: "active_score",
      width: 104,
      sorter: "number",
      cssClass: "score-cell",
      visible: isVisible("active_score", true),
      formatter: (cell) => {
        const val = Number(cell.getValue() ?? 0);
        return `<span class="pct-pill ${pctClass(Math.round(val))}">${val.toFixed(1)}</span>`;
      },
    },
  ];

  const metricSeen = new Set();
  const metricColDefs = [];
  for (const m of dataset.metrics || []) {
    metricSeen.add(m.key);
    metricColDefs.push({ meta: m, defaultVis: true, group: "Position Defaults" });
  }
  for (const m of enabledExtraMetrics) {
    if (metricSeen.has(m.key)) continue;
    metricSeen.add(m.key);
    metricColDefs.push({ meta: m, defaultVis: true, group: "Position Defaults" });
  }
  if (!metricSeen.has("avg_rating") && catalog.byKey.has("avg_rating")) {
    metricSeen.add("avg_rating");
    metricColDefs.push({ meta: catalog.byKey.get("avg_rating"), defaultVis: false, group: "Catalog Metrics" });
  }
  for (const m of catalog.list) {
    if (metricSeen.has(m.key) || m.key === "minutes") continue;
    if (!isVisible(m.key, false)) continue;
    metricSeen.add(m.key);
    metricColDefs.push({ meta: m, defaultVis: false, group: "Catalog Metrics" });
  }

  for (const { meta, defaultVis, group } of metricColDefs) {
    cols.push({
      title: meta.label,
      field: meta.key,
      width: 118,
      sorter: "number",
      sorterParams: { alignEmptyValues: "bottom" },
      visible: isVisible(meta.key, defaultVis),
      _colGroup: group,
      formatter: (cell) => {
        const p = cell.getRow().getData();
        const val = p[meta.key];
        const pct = p.active_pcts?.[meta.key];
        const pctHtml =
          !hidePcts && pct !== undefined ? ` <span class="pct-pill ${pctClass(pct)}">${pct}</span>` : "";
        return `<span class="metric-cell-wrap">${formatStat(meta.key, val)}${pctHtml}</span>`;
      },
    });
  }

  const visSig = metricColDefs
    .filter((c) => isVisible(c.meta.key, c.defaultVis))
    .map((c) => c.meta.key)
    .join("|");
  return { cols, colSig: `${visSig}::${hidePcts ? "nopct" : "pct"}` };
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

export function getTableHeight() {
  return state.uiPrefs?.tableExpanded ? "auto" : "clamp(420px, 74vh, 860px)";
}

export async function initOrUpdateTable(dataset, rows, onRowClick) {
  if (!window.Tabulator) return;
  const seq = ++state.tableUpdateSeq;
  const { cols, colSig } = buildTabulatorColumns(dataset);

  if (!state.tabulatorTable) {
    const table = new window.Tabulator(els.scoutingTable, {
      data: rows,
      index: "uid",
      height: getTableHeight(),
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
      if (e.target.closest(".row-star-btn, .row-copy-btn, .row-compare-cb")) return;
      const ds = activeDataset();
      if (ds && onRowClick) onRowClick(row.getData(), ds);
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

export function renderColumnChooser(onColumnsChanged = null) {
  const table = state.tabulatorTable;
  const dataset = activeDataset();
  if (!table || !dataset) return;
  const pos = dataset.position;
  const catalog = getMetricCatalog(dataset);
  const savedCols = state.colPrefs?.[pos] || {};

  const cols = table.getColumns().filter((c) => c.getField() && c.getField() !== "name");
  const seenFields = new Set(cols.map((c) => c.getField()));
  const groups = [
    { title: "Player & Contract", items: [] },
    { title: "Position Defaults", items: [] },
    { title: "Catalog Metrics", items: [] },
  ];
  for (const c of cols) {
    const def = c.getDefinition();
    const grpTitle = def._colGroup || "Player & Contract";
    const grp = groups.find((g) => g.title === grpTitle) || groups[0];
    grp.items.push({ title: def.title || c.getField(), field: c.getField(), visible: c.isVisible(), inTable: true });
  }
  for (const m of catalog.list) {
    if (seenFields.has(m.key) || m.key === "minutes") continue;
    seenFields.add(m.key);
    groups[2].items.push({
      title: m.label,
      field: m.key,
      visible: Boolean(savedCols[m.key]),
      inTable: false,
    });
  }

  els.columnChooserPopover.innerHTML = `
    <div class="popover-search-wrap">
      <input type="search" class="popover-search" id="col-chooser-search" placeholder="Search columns..." aria-label="Search table columns">
    </div>
    <div class="popover-actions">
      <span class="popover-hint">Visible Columns (${pos})</span>
      <div class="popover-action-btns">
        <button type="button" class="btn-link" id="btn-reset-cols">Reset Defaults</button>
        <button type="button" class="btn-link" popovertarget="column-chooser-popover" popovertargetaction="hide">Done</button>
      </div>
    </div>
    <div class="column-chooser-list" id="column-chooser-list">
      ${groups
        .filter((g) => g.items.length)
        .map(
          (g) => `
          <div class="col-group-heading" data-col-group="${escapeHtml(g.title)}">${escapeHtml(g.title)}</div>
          ${g.items
            .map(
              (item) => `
              <label class="column-chooser-item" data-col-title="${escapeHtml(
                normalizeSearchText(item.title)
              )}">
                <input type="checkbox" data-col-field="${escapeHtml(item.field)}" data-in-table="${item.inTable ? "1" : "0"}" ${item.visible ? "checked" : ""}>
                <span>${escapeHtml(item.title)}</span>
              </label>
            `
            )
            .join("")}
        `
        )
        .join("")}
    </div>
  `;

  const searchInp = document.getElementById("col-chooser-search");
  const listEl = document.getElementById("column-chooser-list");
  if (searchInp && listEl) {
    searchInp.addEventListener("input", () => {
      const q = normalizeSearchText(searchInp.value);
      listEl.querySelectorAll(".column-chooser-item").forEach((lbl) => {
        lbl.hidden = Boolean(q && !lbl.dataset.colTitle?.includes(q));
      });
      listEl.querySelectorAll(".col-group-heading").forEach((hdr) => {
        let next = hdr.nextElementSibling;
        let anyVis = false;
        while (next && !next.classList.contains("col-group-heading")) {
          if (!next.hidden) {
            anyVis = true;
            break;
          }
          next = next.nextElementSibling;
        }
        hdr.hidden = !anyVis;
      });
    });
  }

  els.columnChooserPopover.querySelectorAll("input[data-col-field]").forEach((cb) => {
    cb.addEventListener("change", () => {
      const field = cb.dataset.colField;
      if (!state.colPrefs[pos]) state.colPrefs[pos] = {};
      state.colPrefs[pos][field] = cb.checked;
      saveColPrefs();
      if (cb.dataset.inTable === "1") {
        if (cb.checked) table.showColumn(field);
        else table.hideColumn(field);
        if (cb.checked && onColumnsChanged) onColumnsChanged();
      } else if (onColumnsChanged) {
        onColumnsChanged();
        cb.dataset.inTable = "1";
      }
    });
  });

  const resetBtn = document.getElementById("btn-reset-cols");
  if (resetBtn) {
    resetBtn.addEventListener("click", () => {
      delete state.colPrefs[pos];
      saveColPrefs();
      const { cols: defaultCols } = buildTabulatorColumns(dataset);
      table.setColumns(defaultCols);
      renderColumnChooser(onColumnsChanged);
      showToast("Table columns reset to default");
    });
  }
}
