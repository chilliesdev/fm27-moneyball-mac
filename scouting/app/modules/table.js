import { POS_LABELS } from "./constants.js";
import { activeDataset, els, saveColPrefs, state } from "./state.js";
import { toggleRowShortlist } from "./profile.js";
import { getMetricCatalog } from "./scoring.js";
import {
  clubImgUrl,
  clubNameOf,
  escapeHtml,
  formatMoney,
  formatStat,
  pctClass,
  personImgUrl,
  playerName,
  showToast,
} from "./utils.js";

export function buildTabulatorColumns(dataset) {
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

async function tableSetColumnsAndData(cols, rows, resetSort) {
  const table = state.tabulatorTable;
  if (!table) return;
  table.setColumns(cols);
  await table.replaceData(rows);
  if (resetSort) {
    table.setSort([{ column: "active_score", dir: "desc" }]);
  }
}

export async function initOrUpdateTable(dataset, rows, onRowClick) {
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

export function renderColumnChooser() {
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
