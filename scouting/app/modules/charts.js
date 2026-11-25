import { DEFAULT_AXES, PROGRESSION_AXES, RADAR_MAX_AXES, SCATTER_PRESETS, collator } from "./constants.js";
import { activeDataset, els, state } from "./state.js";
import { getMetricCatalog, getPlayerMetricPct } from "./scoring.js";
import {
  clubImgUrl,
  clubNameOf,
  escapeHtml,
  formatPlayerValue,
  formatStat,
  getThemeColors,
  parsePlayerPositions,
  personImgUrl,
  playerName,
} from "./utils.js";

export function syncScatterPresetSelect(position) {
  if (!els.scatterPreset) return;
  const presets = SCATTER_PRESETS[position] || [];
  const x = els.scatterX.value;
  const y = els.scatterY.value;
  const matchIdx = presets.findIndex((p) => p.x === x && p.y === y);
  els.scatterPreset.value = matchIdx >= 0 ? String(matchIdx) : "";
}

export function populateScatterAxes(dataset, preserveAxes) {
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

  if (els.scatterPreset) {
    const presets = SCATTER_PRESETS[dataset.position] || [];
    els.scatterPreset.innerHTML = [
      `<option value="">Custom Axes</option>`,
      ...presets.map((p, idx) => `<option value="${idx}">${escapeHtml(p.label)}</option>`),
    ].join("");
    syncScatterPresetSelect(dataset.position);
  }
}

function syncResetZoomButton() {
  if (!els.btnResetZoom) return;
  els.btnResetZoom.classList.toggle("is-pending", Boolean(state.scatterZoomed));
}

export function resetScatterZoom() {
  if (!state.scatterChart) return;
  state.scatterZoomed = false;
  syncResetZoomButton();
  state.scatterChart.dispatchAction({ type: "restore" });
}

export function ensureScatterChart(onPlayerClick) {
  if (state.scatterChart || !window.echarts || !els.scatterChart) return;
  state.scatterChart = window.echarts.init(els.scatterChart, null, { renderer: "canvas" });
  state.scatterChart.on("click", (params) => {
    const player = params?.data?.player;
    const ds = activeDataset();
    if (player && ds && onPlayerClick) onPlayerClick(player, ds);
  });
  state.scatterChart.on("datazoom", (ev) => {
    const batch = ev?.batch?.[0] || ev;
    const isFull =
      batch &&
      (batch.startValue == null && batch.endValue == null && (batch.start === 0 || batch.start === undefined) && (batch.end === 100 || batch.end === undefined));
    state.scatterZoomed = !isFull;
    syncResetZoomButton();
  });
  state.scatterChart.on("restore", () => {
    state.scatterZoomed = false;
    syncResetZoomButton();
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

export function renderScatter(dataset, onPlayerClick) {
  ensureScatterChart(onPlayerClick);
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
  const shortlisted = [];
  let sumX = 0;
  let sumY = 0;
  let minX = Infinity;
  let maxX = -Infinity;
  let minY = Infinity;
  let maxY = -Infinity;

  for (const p of state.filtered) {
    const rawX = p[xKey];
    const rawY = p[yKey];
    if (rawX === null || rawX === undefined || rawX === "" || rawY === null || rawY === undefined || rawY === "") {
      continue;
    }
    const x = Number(rawX);
    const y = Number(rawY);
    if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
    sumX += x;
    sumY += y;
    if (x < minX) minX = x;
    if (x > maxX) maxX = x;
    if (y < minY) minY = y;
    if (y > maxY) maxY = y;

    const isBench = p.uid === benchUid;
    const isShortlisted = Boolean(state.shortlist[p.uid]);
    const pt = {
      value: [x, y],
      player: p,
      isBench,
      isShortlisted,
    };
    if (p.is_hull) {
      pt.itemStyle = isBench
        ? { borderColor: theme.text, borderWidth: 2.5 }
        : isShortlisted
          ? { borderColor: theme.positive, borderWidth: 2.5 }
          : { borderColor: theme.surface, borderWidth: 1.5 };
      hull.push(pt);
    } else if (isShortlisted) {
      pt.itemStyle = { borderColor: theme.surface, borderWidth: 1.5 };
      shortlisted.push(pt);
    } else {
      others.push(pt);
    }
  }

  const totalCount = others.length + hull.length + shortlisted.length;
  state.scatterZoomed = false;
  syncResetZoomButton();
  const avgX = totalCount ? sumX / totalCount : 0;
  const avgY = totalCount ? sumY / totalCount : 0;
  let eliteCount = 0;
  if (totalCount) {
    const checkElite = (pt) => {
      const [x, y] = pt.value;
      const okX = xMeta.higher_is_better ? x >= avgX : x <= avgX;
      const okY = yMeta.higher_is_better ? y >= avgY : y <= avgY;
      if (okX && okY) eliteCount += 1;
    };
    others.forEach(checkElite);
    hull.forEach(checkElite);
    shortlisted.forEach(checkElite);
  }
  state.lastScatterEliteCount = eliteCount;
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
  const elitePos = `${yMeta.higher_is_better ? "insideTop" : "insideBottom"}${xMeta.higher_is_better ? "Right" : "Left"}`;

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
          position: elitePos,
          distance: 6,
          color: theme.accent,
          backgroundColor: theme.surface,
          borderRadius: 4,
          padding: [2, 6],
          fontSize: 10,
          fontWeight: 700,
        },
        data: [[{ name: "Elite Quadrant", coord: [xStart, yStart] }, { coord: [xEnd, yEnd] }]],
      }
    : undefined;

  const markOwnerIdx = others.length > 0 ? 0 : hull.length > 0 ? 1 : shortlisted.length > 0 ? 2 : -1;
  const clubLabel = state.meta?.club_short_name || "Managed Club";

  const poolOpacity = others.length > 1500 ? 0.58 : others.length > 500 ? 0.72 : 0.88;
  const emptyGraphic = !totalCount
    ? [
        {
          type: "text",
          left: "center",
          top: "middle",
          style: {
            text: state.filtered.length
              ? "No metric values available for current axes"
              : "No matching players to plot — adjust filters above",
            fill: theme.muted,
            font: "600 13px -apple-system, BlinkMacSystemFont, sans-serif",
          },
        },
      ]
    : [];
  const option = {
    animationDuration: 220,
    graphic: emptyGraphic,
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
      { type: "inside", xAxisIndex: 0, filterMode: "none", zoomOnMouseWheel: "ctrl" },
      { type: "inside", yAxisIndex: 0, filterMode: "none", zoomOnMouseWheel: "ctrl" },
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
        const posStr = escapeHtml(parsePlayerPositions(p.positions).join(", ") || "—");
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
            <div>Pos: ${posStr} · Mins: ${escapeHtml(p.minutes ?? "—")}</div>
            <div>
              ${escapeHtml(xMeta.label)}: <strong>${formatStat(xKey, p[xKey])}</strong><br>
              ${escapeHtml(yMeta.label)}: <strong>${formatStat(yKey, p[yKey])}</strong>
            </div>
            <div>Value: ${escapeHtml(formatPlayerValue(p))} · Score: <strong>${Number(p.active_score ?? 0).toFixed(1)}</strong>${
              params?.data?.isShortlisted ? ` · <strong style="color:${theme.positive}">★ Shortlisted</strong>` : ""
            }</div>
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
        itemStyle: { color: theme.poolDot, opacity: poolOpacity },
        emphasis: { scale: 1.5, itemStyle: { opacity: 1, borderColor: theme.text, borderWidth: 1.5 } },
        z: 2,
        data: others,
        markLine: markOwnerIdx === 0 ? markLine : undefined,
        markArea: markOwnerIdx === 0 ? markArea : undefined,
      },
      {
        name: clubLabel,
        type: "scatter",
        large: false,
        emphasis: { scale: 1.35 },
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
        markLine: markOwnerIdx === 1 ? markLine : undefined,
        markArea: markOwnerIdx === 1 ? markArea : undefined,
      },
      {
        name: "Shortlisted",
        type: "scatter",
        large: false,
        emphasis: { scale: 1.35 },
        symbol: "triangle",
        symbolSize: 11,
        itemStyle: { color: theme.positive, opacity: 1 },
        z: 5,
        data: shortlisted,
        markLine: markOwnerIdx === 2 ? markLine : undefined,
        markArea: markOwnerIdx === 2 ? markArea : undefined,
      },
    ],
  };

  state.scatterChart.setOption(option, { notMerge: true });
}

export function getProfileDisplayMetrics(dataset) {
  const catalog = getMetricCatalog(dataset);
  const base = [...(dataset.metrics || [])];
  const seen = new Set(base.map((m) => m.key));
  const cfg = dataset.position === state.pos ? state.scoreConfig : null;
  for (const item of cfg?.metrics || []) {
    if (!item.enabled || seen.has(item.key)) continue;
    const cat = catalog.byKey.get(item.key);
    if (!cat) continue;
    seen.add(item.key);
    base.push(cat);
  }
  return base;
}

export function getRadarMetrics(dataset) {
  const all = getProfileDisplayMetrics(dataset);
  if (all.length <= RADAR_MAX_AXES) {
    return { metrics: all, totalCount: all.length, truncated: false };
  }
  const baseKeys = new Set((dataset.metrics || []).map((m) => m.key));
  const cfg = dataset.position === state.pos ? state.scoreConfig : null;
  const weightMap = new Map((cfg?.metrics || []).filter((m) => m.enabled).map((m) => [m.key, m.weight]));
  const extras = all
    .filter((m) => !baseKeys.has(m.key))
    .sort((a, b) => (weightMap.get(b.key) ?? 0) - (weightMap.get(a.key) ?? 0));
  const base = all.filter((m) => baseKeys.has(m.key));
  const combined = [...base, ...extras].slice(0, RADAR_MAX_AXES);
  return { metrics: combined, totalCount: all.length, truncated: true };
}

export function renderRadar(player, compareInput, dataset, baseline, clubLabelOrFn) {
  if (!window.echarts || !els.radarChart) return;
  if (!state.radarChart) {
    state.radarChart = window.echarts.init(els.radarChart, null, { renderer: "canvas" });
  }
  state.radarChart.resize();

  const theme = getThemeColors();
  const { metrics, totalCount, truncated } = getRadarMetrics(dataset);
  if (els.dialogRadarNote) {
    if (truncated) {
      els.dialogRadarNote.textContent = `Radar shows ${metrics.length} of ${totalCount} active metrics. See all metrics below.`;
      els.dialogRadarNote.hidden = false;
    } else {
      els.dialogRadarNote.hidden = true;
    }
  }

  const indicators = metrics.map((m) => ({
    name: m.label.replace(" / 90", ""),
    min: 0,
    max: 100,
  }));

  const compareList = Array.isArray(compareInput)
    ? compareInput.filter(Boolean).slice(0, 3)
    : compareInput
      ? [compareInput]
      : [];
  const labelForCmp = (cmp) => {
    if (typeof clubLabelOrFn === "function") return clubLabelOrFn(cmp);
    return clubLabelOrFn || clubNameOf(cmp);
  };

  const toSeriesEntry = (p, name, color, symbol, lineType, areaOpacity) => {
    const pcts = metrics.map((m) => getPlayerMetricPct(p, m.key, dataset, baseline));
    return {
      value: pcts.map((v) => (v === null || v === undefined ? 0 : v)),
      pcts,
      player: p,
      name,
      symbol,
      areaStyle: { color, opacity: areaOpacity },
      lineStyle: { color, width: 2.3, type: lineType },
      itemStyle: { color },
    };
  };

  const seriesData = [
    toSeriesEntry(player, playerName(player), theme.accent, "circle", "solid", 0.28),
  ];
  const cmpPalette = [
    { color: theme.compare, symbol: "diamond", lineType: "dashed", opacity: 0.2 },
    { color: theme.compare2, symbol: "triangle", lineType: "dotted", opacity: 0.14 },
    { color: theme.compare3, symbol: "rect", lineType: "dashDot", opacity: 0.14 },
  ];
  compareList.forEach((cmp, idx) => {
    const sty = cmpPalette[idx] || cmpPalette[0];
    seriesData.push(
      toSeriesEntry(
        cmp,
        `${playerName(cmp)} (${labelForCmp(cmp)})`,
        sty.color,
        sty.symbol,
        sty.lineType,
        sty.opacity
      )
    );
  });

  state.radarChart.setOption(
    {
      animationDuration: 200,
      tooltip: {
        trigger: "item",
        confine: true,
        backgroundColor: theme.surface,
        borderColor: theme.border,
        textStyle: { color: theme.text, fontSize: 12 },
        formatter: (params) => {
          const entry = params?.data;
          if (!entry?.player) return "";
          const lines = metrics.map((m, i) => {
            const raw = formatStat(m.key, entry.player[m.key]);
            const pct = entry.pcts?.[i];
            const pctStr = pct === null || pct === undefined ? "n/a" : `${pct}th`;
            return `<div style="display:flex;justify-content:space-between;gap:12px"><span>${escapeHtml(m.label)}</span><strong>${escapeHtml(raw)} <span style="opacity:.75">(${pctStr})</span></strong></div>`;
          });
          return `<div style="min-width:210px"><strong>${escapeHtml(entry.name)}</strong><div style="margin-top:4px;font-size:11px">${lines.join("")}</div></div>`;
        },
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

export async function renderPlayerProgression(player, position, season, openToken, loadPositionFn, comparePlayers = []) {
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
  const primaryCmp = Array.isArray(comparePlayers) ? comparePlayers[0] || null : comparePlayers;
  const cmpHistory = new Map();
  for (const entry of state.seasons) {
    try {
      const ds = await loadPositionFn(position, entry.season);
      const match = ds.players.find((p) => p.uid === player.uid);
      if (match) history.push({ season: entry.season, row: match });
      if (primaryCmp) {
        const cmpMatch = ds.players.find((p) => p.uid === primaryCmp.uid);
        if (cmpMatch) cmpHistory.set(entry.season, cmpMatch);
      }
    } catch {
      // Skip unavailable season
    }
  }

  if (!els.playerDialog.open || state.dialogOpenToken !== openToken) return;

  history.sort((a, b) => collator.compare(a.season, b.season));
  if (history.length < 2) {
    els.progressionChart.hidden = true;
    if (els.dialogProgressionMetric) els.dialogProgressionMetric.hidden = true;
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
  const dsForPos = activeDataset();
  const catalog = dsForPos ? getMetricCatalog(dsForPos) : null;
  const [def1, def2] = PROGRESSION_AXES[position] || PROGRESSION_AXES.ST;

  if (els.dialogProgressionMetric && catalog) {
    const prevMetric = els.dialogProgressionMetric.value;
    els.dialogProgressionMetric.innerHTML = [
      `<option value="">Position Pair (Default)</option>`,
      ...catalog.list.map((m) => `<option value="${escapeHtml(m.key)}">${escapeHtml(m.label)}</option>`),
    ].join("");
    els.dialogProgressionMetric.value = prevMetric && catalog.byKey.has(prevMetric) ? prevMetric : "";
    els.dialogProgressionMetric.hidden = false;
    els.dialogProgressionMetric.onchange = () => {
      renderPlayerProgression(player, position, season, openToken, loadPositionFn, state.activeComparePlayers || []);
    };
  }

  const customMetric = els.dialogProgressionMetric?.value || "";
  const m1Key = customMetric || def1;
  const m2Key = customMetric ? "" : def2;
  const fallbackLabels = {
    npxg_p90: "np-xG / 90",
    xa_p90: "xA / 90",
    prog_passes_p90: "Prog. Passes / 90",
    tackles_cmp_p90: "Tackles Won / 90",
    headers_won_pct: "Headers Won %",
    xg_prevented_p90: "xG Prevented / 90",
    goals_allowed_p90: "Goals Allowed / 90",
  };
  const m1Label = catalog?.byKey.get(m1Key)?.label || fallbackLabels[m1Key] || m1Key;
  const m2Label = m2Key ? catalog?.byKey.get(m2Key)?.label || fallbackLabels[m2Key] || m2Key : "";

  const activeSlug = state.scoreConfig?.pos === position ? state.scoreConfig.roleSlug : "overall";
  const roleInfo = activeSlug && activeSlug !== "overall" ? dsForPos?.roles?.[activeSlug] : null;
  const scoreField = roleInfo ? `score_${activeSlug}` : "score_overall";
  const scoreLabel = roleInfo ? `${roleInfo.label} Score` : "Overall Score";

  const xLabels = history.map((h) => h.season);
  const showCmpSeries = Boolean(primaryCmp && cmpHistory.size >= 1);

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
          const secondPart = m2Key ? ` · ${escapeHtml(m2Label)}: ${formatStat(m2Key, r[m2Key])}` : "";
          const cmpRow = cmpHistory.get(item.season);
          const cmpPart = cmpRow
            ? `<br><span style="color:${theme.compare}">vs ${escapeHtml(playerName(primaryCmp))}: ${formatStat(m1Key, cmpRow[m1Key])}</span>`
            : "";
          return `
            <strong>${escapeHtml(item.season)}</strong> (${escapeHtml(clubNameOf(r))})<br>
            Mins: ${r.minutes} · Avg Rating: <strong>${Number(r.avg_rating || 0).toFixed(2)}</strong><br>
            ${escapeHtml(m1Label)}: ${formatStat(m1Key, r[m1Key])}${secondPart}<br>
            ${escapeHtml(scoreLabel)}: <strong>${Number(r[scoreField] ?? r.score_overall ?? 0).toFixed(1)}</strong>${cmpPart}
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
          name: customMetric ? m1Label : "Per-90",
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
        ...(m2Key
          ? [
              {
                name: m2Label,
                type: "line",
                yAxisIndex: 0,
                smooth: true,
                symbolSize: 7,
                itemStyle: { color: theme.compare },
                data: history.map((h) => Number(h.row[m2Key]) || 0),
              },
            ]
          : []),
        ...(showCmpSeries
          ? [
              {
                name: `${playerName(primaryCmp)} (${m1Label})`,
                type: "line",
                yAxisIndex: 0,
                smooth: true,
                symbolSize: 6,
                lineStyle: { type: "dotted" },
                itemStyle: { color: theme.compare2 },
                data: history.map((h) => {
                  const cr = cmpHistory.get(h.season);
                  return cr && cr[m1Key] != null ? Number(cr[m1Key]) : null;
                }),
              },
            ]
          : []),
        {
          name: scoreLabel,
          type: "line",
          yAxisIndex: 1,
          smooth: true,
          symbolSize: 7,
          lineStyle: { type: "dashed" },
          itemStyle: { color: theme.positive },
          data: history.map((h) => Number(h.row[scoreField] ?? h.row.score_overall) || 0),
        },
      ],
    },
    { notMerge: true }
  );
}
