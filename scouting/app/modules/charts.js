import { DEFAULT_AXES, collator } from "./constants.js";
import { activeDataset, els, state } from "./state.js";
import { getMetricCatalog, getPlayerMetricPct } from "./scoring.js";
import {
  clubImgUrl,
  clubNameOf,
  escapeHtml,
  formatMoney,
  formatStat,
  getThemeColors,
  personImgUrl,
  playerName,
} from "./utils.js";

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
}

export function ensureScatterChart(onPlayerClick) {
  if (state.scatterChart || !window.echarts || !els.scatterChart) return;
  state.scatterChart = window.echarts.init(els.scatterChart, null, { renderer: "canvas" });
  state.scatterChart.on("click", (params) => {
    const player = params?.data?.player;
    const ds = activeDataset();
    if (player && ds && onPlayerClick) onPlayerClick(player, ds);
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
  let sumX = 0;
  let sumY = 0;
  let minX = Infinity;
  let maxX = -Infinity;
  let minY = Infinity;
  let maxY = -Infinity;

  for (const p of state.filtered) {
    const x = Number(p[xKey]) || 0;
    const y = Number(p[yKey]) || 0;
    sumX += x;
    sumY += y;
    if (x < minX) minX = x;
    if (x > maxX) maxX = x;
    if (y < minY) minY = y;
    if (y > maxY) maxY = y;

    const isBench = p.uid === benchUid;
    const pt = {
      value: [x, y],
      player: p,
      isBench,
    };
    if (p.is_hull) {
      pt.itemStyle = isBench
        ? { borderColor: theme.text, borderWidth: 2.5 }
        : { borderColor: theme.surface, borderWidth: 1.5 };
      hull.push(pt);
    } else {
      others.push(pt);
    }
  }

  const totalCount = others.length + hull.length;
  const avgX = totalCount ? sumX / totalCount : 0;
  const avgY = totalCount ? sumY / totalCount : 0;
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
          position: "insideTopRight",
          color: theme.accent,
          fontSize: 10,
          fontWeight: 700,
        },
        data: [[{ name: "Elite Quadrant", coord: [xStart, yStart] }, { coord: [xEnd, yEnd] }]],
      }
    : undefined;

  const attachMarksToFirst = others.length > 0;
  const clubLabel = state.meta?.club_short_name || "Managed Club";

  const option = {
    animationDuration: 220,
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
      { type: "inside", xAxisIndex: 0, filterMode: "none" },
      { type: "inside", yAxisIndex: 0, filterMode: "none" },
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
            <div>
              ${escapeHtml(xMeta.label)}: <strong>${formatStat(xKey, p[xKey])}</strong><br>
              ${escapeHtml(yMeta.label)}: <strong>${formatStat(yKey, p[yKey])}</strong>
            </div>
            <div>Value: ${formatMoney(p.value)} · Score: <strong>${Number(p.active_score ?? 0).toFixed(1)}</strong></div>
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
        itemStyle: { color: theme.poolDot, opacity: 0.9 },
        emphasis: { disabled: true },
        z: 2,
        data: others,
        markLine: attachMarksToFirst ? markLine : undefined,
        markArea: attachMarksToFirst ? markArea : undefined,
      },
      {
        name: clubLabel,
        type: "scatter",
        large: false,
        emphasis: { disabled: true },
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
        markLine: !attachMarksToFirst && hull.length ? markLine : undefined,
        markArea: !attachMarksToFirst && hull.length ? markArea : undefined,
      },
    ],
  };

  state.scatterChart.setOption(option, { notMerge: true });
}

export function renderRadar(player, comparePlayer, dataset, baseline, clubLabel) {
  if (!window.echarts || !els.radarChart) return;
  if (!state.radarChart) {
    state.radarChart = window.echarts.init(els.radarChart, null, { renderer: "canvas" });
  }
  state.radarChart.resize();

  const theme = getThemeColors();
  const metrics = dataset.metrics || [];
  const indicators = metrics.map((m) => ({
    name: m.label.replace(" / 90", ""),
    min: 0,
    max: 100,
  }));

  const playerValues = metrics.map((m) => getPlayerMetricPct(player, m.key, dataset, baseline));
  const seriesData = [
    {
      value: playerValues,
      name: playerName(player),
      symbol: "circle",
      areaStyle: { color: theme.accent, opacity: 0.28 },
      lineStyle: { color: theme.accent, width: 2.5 },
      itemStyle: { color: theme.accent },
    },
  ];

  if (comparePlayer) {
    const cmpValues = metrics.map((m) => getPlayerMetricPct(comparePlayer, m.key, dataset, baseline));
    seriesData.push({
      value: cmpValues,
      name: `${playerName(comparePlayer)} (${clubLabel})`,
      symbol: "diamond",
      areaStyle: { color: theme.compare, opacity: 0.2 },
      lineStyle: { color: theme.compare, width: 2.5, type: "dashed" },
      itemStyle: { color: theme.compare },
    });
  }

  state.radarChart.setOption(
    {
      animationDuration: 200,
      tooltip: {
        trigger: "item",
        confine: true,
        backgroundColor: theme.surface,
        borderColor: theme.border,
        textStyle: { color: theme.text, fontSize: 12 },
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

export async function renderPlayerProgression(player, position, season, openToken, loadPositionFn) {
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
  for (const entry of state.seasons) {
    try {
      const ds = await loadPositionFn(position, entry.season);
      const match = ds.players.find((p) => p.uid === player.uid);
      if (match) history.push({ season: entry.season, row: match });
    } catch {
      // Skip unavailable season
    }
  }

  if (!els.playerDialog.open || state.dialogOpenToken !== openToken) return;

  history.sort((a, b) => collator.compare(a.season, b.season));
  if (history.length < 2) {
    els.progressionChart.hidden = true;
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
  const isGk = position === "GK";
  const m1Key = isGk ? "xg_prevented_p90" : "npxg_p90";
  const m1Label = isGk ? "xG Prevented / 90" : "np-xG / 90";
  const m2Key = isGk ? "goals_allowed_p90" : "xa_p90";
  const m2Label = isGk ? "Goals Allowed / 90" : "xA / 90";

  const xLabels = history.map((h) => h.season);

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
          return `
            <strong>${escapeHtml(item.season)}</strong> (${escapeHtml(clubNameOf(r))})<br>
            Mins: ${r.minutes} · Avg Rating: <strong>${Number(r.avg_rating || 0).toFixed(2)}</strong><br>
            ${escapeHtml(m1Label)}: ${formatStat(m1Key, r[m1Key])} · ${escapeHtml(m2Label)}: ${formatStat(m2Key, r[m2Key])}<br>
            Overall Score: <strong>${Number(r.score_overall || 0).toFixed(1)}</strong>
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
          name: "Per-90",
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
        {
          name: m2Label,
          type: "line",
          yAxisIndex: 0,
          smooth: true,
          symbolSize: 7,
          itemStyle: { color: theme.compare },
          data: history.map((h) => Number(h.row[m2Key]) || 0),
        },
        {
          name: "Overall Score",
          type: "line",
          yAxisIndex: 1,
          smooth: true,
          symbolSize: 7,
          lineStyle: { type: "dashed" },
          itemStyle: { color: "#16a34a" },
          data: history.map((h) => Number(h.row.score_overall) || 0),
        },
      ],
    },
    { notMerge: true }
  );
}
