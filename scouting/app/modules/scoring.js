import { els, state } from "./state.js";
import { escapeHtml } from "./utils.js";

export function getMetricCatalog(dataset) {
  if (state.catalogCache.has(dataset)) return state.catalogCache.get(dataset);

  const byKey = new Map();
  const list = [];
  for (const m of dataset.all_metrics || []) {
    const entry = {
      key: m.key,
      label: m.label,
      higher_is_better: Boolean(m.higher_is_better),
      category: m.category || "Other",
    };
    byKey.set(entry.key, entry);
    list.push(entry);
  }
  const defaultKeys = new Set();
  for (const m of dataset.metrics || []) {
    defaultKeys.add(m.key);
    if (!byKey.has(m.key)) {
      const entry = {
        key: m.key,
        label: m.label,
        higher_is_better: Boolean(m.higher_is_better),
        category: "Position Defaults",
      };
      byKey.set(entry.key, entry);
      list.push(entry);
    }
  }
  const catalog = { list, byKey, defaultKeys };
  state.catalogCache.set(dataset, catalog);
  return catalog;
}

export function bisectLeft(arr, target) {
  let lo = 0;
  let hi = arr.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (arr[mid] < target) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

export function bisectRight(arr, target) {
  let lo = 0;
  let hi = arr.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (arr[mid] <= target) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

export function datasetHasClubReputation(dataset) {
  if (!dataset?.players?.length) return true;
  if (state.repCoverageCache.has(dataset)) return state.repCoverageCache.get(dataset);
  let withRep = 0;
  const minNeeded = Math.min(10, dataset.players.length);
  for (const p of dataset.players) {
    if ((p.club_rep || 0) > 0) {
      withRep += 1;
      if (withRep >= minNeeded) break;
    }
  }
  const hasRep = withRep >= minNeeded;
  state.repCoverageCache.set(dataset, hasRep);
  return hasRep;
}

export function getBaselinePool(dataset, minMins, minRep, dynamicPct) {
  const effMinRep = datasetHasClubReputation(dataset) ? minRep : 0;
  const peerPool = dataset.players.filter(
    (p) => p.minutes >= minMins && (p.club_rep >= effMinRep || p.is_hull)
  );
  if (dynamicPct && peerPool.length >= 10) {
    return {
      pool: peerPool,
      peerCount: peerPool.length,
      isGlobal: false,
      tag: `${minMins}:${effMinRep}`,
    };
  }
  const minBase = dataset.baseline_minutes || 900;
  let globalPool = dataset.players.filter((p) => p.minutes >= minBase);
  if (globalPool.length < 20) globalPool = dataset.players;
  return {
    pool: globalPool,
    peerCount: peerPool.length,
    isGlobal: true,
    tag: `global:${minBase}`,
  };
}

export function getMetricDist(dataset, baseline, key) {
  let pools = state.distCache.get(dataset);
  if (!pools) {
    pools = new Map();
    state.distCache.set(dataset, pools);
  }
  let metricMap = pools.get(baseline.tag);
  if (!metricMap) {
    metricMap = new Map();
    pools.set(baseline.tag, metricMap);
  }
  if (metricMap.has(key)) return metricMap.get(key);

  const pool = baseline.pool;
  const rawVals = [];
  for (let i = 0; i < pool.length; i++) {
    const raw = pool[i][key];
    if (raw === null || raw === undefined || raw === "") continue;
    const num = Number(raw);
    if (Number.isFinite(num)) rawVals.push(num);
  }
  const n = rawVals.length;
  if (n === 0) {
    const empty = { n: 0, mean: 0, std: 0, min: 0, max: 0, sorted: new Float64Array(0) };
    metricMap.set(key, empty);
    return empty;
  }

  const sorted = Float64Array.from(rawVals);
  let sum = 0;
  let min = sorted[0];
  let max = sorted[0];
  for (let i = 0; i < n; i++) {
    const v = sorted[i];
    sum += v;
    if (v < min) min = v;
    if (v > max) max = v;
  }
  const mean = sum / n;
  let sq = 0;
  for (let i = 0; i < n; i++) {
    const d = sorted[i] - mean;
    sq += d * d;
  }
  const std = Math.sqrt(sq / n);
  sorted.sort();
  const dist = { n, mean, std, min, max, sorted };
  metricMap.set(key, dist);
  return dist;
}

export function scoreMetric(val, method, higher, dist, fallbackPct, defaultHigher) {
  if (val === null || val === undefined || val === "") return 50;
  const x = Number(val);
  if (!Number.isFinite(x)) return 50;
  if (!dist || dist.n === 0) {
    if (fallbackPct !== null && fallbackPct !== undefined) {
      return higher === defaultHigher ? fallbackPct : 100 - fallbackPct;
    }
    return 50;
  }
  if (method === "zscore") {
    if (dist.std === 0 || !Number.isFinite(dist.std)) return 50;
    let z = (x - dist.mean) / dist.std;
    if (!higher) z = -z;
    return Math.max(0, Math.min(100, 50 + z * (50 / 3)));
  }
  if (method === "minmax") {
    if (dist.max === dist.min) return 50;
    let norm = ((x - dist.min) / (dist.max - dist.min)) * 100;
    if (!higher) norm = 100 - norm;
    return Math.max(0, Math.min(100, norm));
  }
  if (dist.min === dist.max) return 50;
  const mid = (bisectLeft(dist.sorted, x) + bisectRight(dist.sorted, x)) / 2;
  let pct = (mid / dist.n) * 100;
  if (!higher) pct = 100 - pct;
  return Math.max(0, Math.min(100, Math.round(pct)));
}

export function getPlayerMetricPct(player, key, dataset, baseline) {
  if (player?.active_pcts && player.active_pcts[key] !== undefined) {
    return player.active_pcts[key];
  }
  const catalog = getMetricCatalog(dataset);
  const meta = catalog.byKey.get(key);
  const config = dataset.position === state.pos ? state.scoreConfig : null;
  const cfgItem = config?.metrics.find((m) => m.key === key);
  const higher = cfgItem ? cfgItem.higher_is_better : (meta?.higher_is_better ?? true);
  const method = config?.method || "percentile";
  const dist = getMetricDist(dataset, baseline, key);
  return Math.round(
    scoreMetric(player?.[key], method, higher, dist, player?.[`pct_${key}`], meta?.higher_is_better ?? true)
  );
}

export function getPosPresets(pos) {
  const list = state.presets?.[pos];
  return Array.isArray(list) ? list : [];
}

export function buildScoreConfigFromRole(dataset, roleValue, preserveMethod = null) {
  const catalog = getMetricCatalog(dataset);
  const pos = dataset.position;

  if (roleValue && roleValue.startsWith("custom:")) {
    const presetId = roleValue.slice(7);
    const preset = getPosPresets(pos).find((p) => p.id === presetId);
    if (preset) {
      const presetMap = new Map(preset.metrics.map((m) => [m.key, m]));
      return {
        pos,
        roleSlug: roleValue,
        presetId,
        method: preset.method || "percentile",
        metrics: catalog.list.map((cat) => {
          const saved = presetMap.get(cat.key);
          return {
            key: cat.key,
            weight: saved ? Math.max(0, Math.min(5, Number(saved.weight) || 0)) : 1,
            higher_is_better: saved ? Boolean(saved.higher_is_better) : cat.higher_is_better,
            enabled: Boolean(saved),
          };
        }),
      };
    }
  }

  const slug = roleValue && (roleValue === "overall" || dataset.roles[roleValue]) ? roleValue : "overall";
  const roleKeys =
    slug === "overall"
      ? new Set(dataset.metrics.map((m) => m.key))
      : new Set(dataset.roles[slug]?.metrics || dataset.metrics.map((m) => m.key));

  return {
    pos,
    roleSlug: slug,
    presetId: null,
    method: preserveMethod || state.scoreConfig?.method || "percentile",
    metrics: catalog.list.map((cat) => ({
      key: cat.key,
      weight: 1,
      higher_is_better: cat.higher_is_better,
      enabled: roleKeys.has(cat.key),
    })),
  };
}

export function refreshRoleSelectOptions(dataset, desiredValue) {
  const pos = dataset.position;
  const roleEntries = Object.entries(dataset.roles || {});
  const presets = getPosPresets(pos);
  const parts = [
    `<option value="overall">Overall Moneyball Score</option>`,
    ...roleEntries.map(([slug, info]) => `<option value="${escapeHtml(slug)}">${escapeHtml(info.label)}</option>`),
  ];
  if (presets.length) {
    parts.push(
      `<optgroup label="Custom Presets">${presets
        .map((p) => `<option value="custom:${escapeHtml(p.id)}">${escapeHtml(p.name)}</option>`)
        .join("")}</optgroup>`
    );
  }
  if (desiredValue === "__custom_draft__") {
    parts.push(`<option value="__custom_draft__">Custom (Unsaved)</option>`);
  }
  els.role.innerHTML = parts.join("");
  if (desiredValue && [...els.role.options].some((o) => o.value === desiredValue)) {
    els.role.value = desiredValue;
  } else {
    els.role.value = "overall";
  }
}

export function computePoolRows(dataset, scalar, matchesFn) {
  const baseline = getBaselinePool(dataset, scalar.minMins, scalar.minRep, scalar.dynamicPct);
  const catalog = getMetricCatalog(dataset);

  const cfg = state.scoreConfig || buildScoreConfigFromRole(dataset, "overall");
  const method = cfg.method || "percentile";
  const enabledItems = cfg.metrics.filter((m) => m.enabled);
  const cfgByKey = new Map(cfg.metrics.map((m) => [m.key, m]));

  const pctKeys = new Set(dataset.metrics.map((m) => m.key));
  for (const item of enabledItems) pctKeys.add(item.key);

  const dists = new Map();
  for (const k of pctKeys) {
    dists.set(k, getMetricDist(dataset, baseline, k));
  }

  let totalWeight = 0;
  for (const item of enabledItems) totalWeight += item.weight;

  const out = [];
  for (const p of dataset.players) {
    if (!matchesFn(p, scalar)) continue;

    const activePcts = {};
    const rawScores = new Map();
    for (const k of pctKeys) {
      const catMeta = catalog.byKey.get(k);
      const defaultHigher = catMeta?.higher_is_better ?? true;
      const higher = cfgByKey.get(k)?.higher_is_better ?? defaultHigher;
      const raw = scoreMetric(p[k], method, higher, dists.get(k), p[`pct_${k}`], defaultHigher);
      rawScores.set(k, raw);
      activePcts[k] = Math.round(raw);
    }

    let activeScore = 0;
    if (totalWeight > 0) {
      let weightedSum = 0;
      for (const item of enabledItems) {
        weightedSum += (rawScores.get(item.key) ?? 50) * item.weight;
      }
      activeScore = Math.round((weightedSum / totalWeight) * 10) / 10;
    }

    out.push({
      ...p,
      active_pcts: activePcts,
      active_score: activeScore,
    });
  }

  return { rows: out, baseline };
}
