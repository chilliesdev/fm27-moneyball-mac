import { METHOD_HINTS, POS_LABELS } from "./constants.js";
import { activeDataset, els, savePresets, state } from "./state.js";
import { matchesPlayer, readScalarFilters } from "./filters.js";
import {
  buildScoreConfigFromRole,
  computePoolRows,
  getMetricCatalog,
  getPosPresets,
  refreshRoleSelectOptions,
} from "./scoring.js";
import {
  clubNameOf,
  enableLightDismissFallback,
  escapeHtml,
  pctClass,
  playerName,
  showToast,
} from "./utils.js";

export function renderScoreDialog() {
  const dataset = activeDataset();
  if (!dataset || !state.scoreConfig) return;

  const catalog = getMetricCatalog(dataset);
  const cfg = state.scoreConfig;
  const method = cfg.method || "percentile";
  els.scoreMethod.value = method;
  els.scoreMethodHint.textContent = METHOD_HINTS[method] || "";
  els.scorePresetPos.textContent = dataset.position;
  els.scoreDialogSubtitle.textContent = `${POS_LABELS[dataset.position]} · ${catalog.list.length} metrics available`;
  if (els.scoreMetricSearch) {
    els.scoreMetricSearch.placeholder = `Search ${catalog.list.length} metrics...`;
  }

  const presets = getPosPresets(dataset.position);
  els.scorePresetSelect.innerHTML = [
    `<option value="">— Select saved preset —</option>`,
    ...presets.map((pr) => `<option value="${escapeHtml(pr.id)}">${escapeHtml(pr.name)}</option>`),
  ].join("");
  els.scorePresetSelect.value = cfg.presetId && presets.some((p) => p.id === cfg.presetId) ? cfg.presetId : "";
  const activePreset = presets.find((p) => p.id === els.scorePresetSelect.value);
  if (els.scoreUpdatePresetBtn) els.scoreUpdatePresetBtn.disabled = !activePreset;
  els.scoreRenamePresetBtn.disabled = !activePreset;
  els.scoreDeletePresetBtn.disabled = !activePreset;
  if (activePreset && document.activeElement !== els.scorePresetName) {
    els.scorePresetName.value = activePreset.name;
  }

  const prevCat = els.scoreCategoryFilter.value || "all";
  const categories = ["Position Defaults", ...new Set(catalog.list.map((m) => m.category).filter((c) => c !== "Position Defaults"))];
  els.scoreCategoryFilter.innerHTML = [
    `<option value="all">All Categories (${catalog.list.length})</option>`,
    ...categories.map((c) => `<option value="${escapeHtml(c)}">${escapeHtml(c)}</option>`),
  ].join("");
  if ([...els.scoreCategoryFilter.options].some((o) => o.value === prevCat)) {
    els.scoreCategoryFilter.value = prevCat;
  }

  const enabledItems = cfg.metrics.filter((m) => m.enabled);
  const totalWeight = enabledItems.reduce((s, m) => s + m.weight, 0);
  els.scoreTotalWeight.textContent = `Enabled: ${enabledItems.length} · Total weight: ${totalWeight.toFixed(1)}`;
  if (els.scoreUnsavedBadge) {
    els.scoreUnsavedBadge.hidden = cfg.roleSlug !== "__custom_draft__";
  }

  const query = els.scoreMetricSearch.value.trim().toLowerCase();
  const catFilter = els.scoreCategoryFilter.value;
  const enabledOnly = els.scoreEnabledOnly.checked;

  const cfgByKey = new Map(cfg.metrics.map((m) => [m.key, m]));
  const orderedGroups = [];
  const seenKeys = new Set();

  const defaultGroupItems = [];
  for (const m of dataset.metrics || []) {
    const catMeta = catalog.byKey.get(m.key);
    if (!catMeta || seenKeys.has(m.key)) continue;
    seenKeys.add(m.key);
    defaultGroupItems.push(catMeta);
  }
  orderedGroups.push({ title: "Position Defaults", items: defaultGroupItems });

  const byCat = new Map();
  for (const catMeta of catalog.list) {
    if (seenKeys.has(catMeta.key)) continue;
    seenKeys.add(catMeta.key);
    if (!byCat.has(catMeta.category)) byCat.set(catMeta.category, []);
    byCat.get(catMeta.category).push(catMeta);
  }
  for (const [catName, items] of byCat.entries()) {
    orderedGroups.push({ title: catName, items });
  }

  const html = [];
  for (const grp of orderedGroups) {
    if (catFilter !== "all" && grp.title !== catFilter) continue;
    const visibleItems = grp.items.filter((catMeta) => {
      const cfgItem = cfgByKey.get(catMeta.key);
      if (!cfgItem) return false;
      if (enabledOnly && !cfgItem.enabled) return false;
      if (query && !catMeta.label.toLowerCase().includes(query) && !catMeta.key.toLowerCase().includes(query)) {
        return false;
      }
      return true;
    });
    if (!visibleItems.length) continue;

    html.push(`<div class="score-group-header">${escapeHtml(grp.title)}</div>`);
    for (const catMeta of visibleItems) {
      const cfgItem = cfgByKey.get(catMeta.key);
      const share =
        cfgItem.enabled && totalWeight > 0 ? ((cfgItem.weight / totalWeight) * 100).toFixed(1) : "0.0";
      const isDefault = catalog.defaultKeys.has(catMeta.key);
      html.push(`
        <div class="score-metric-row ${cfgItem.enabled ? "" : "is-disabled"}" data-key="${escapeHtml(catMeta.key)}">
          <label class="score-metric-label">
            <input type="checkbox" class="score-enable-cb" ${cfgItem.enabled ? "checked" : ""} aria-label="Enable ${escapeHtml(catMeta.label)}">
            <span class="score-metric-name">
              <span>${escapeHtml(catMeta.label)}</span>
              ${isDefault ? `<span class="score-default-tag">Default</span>` : ""}
            </span>
          </label>
          <button type="button" class="score-dir-btn" aria-pressed="${cfgItem.higher_is_better}" title="Toggle scoring direction">
            ${cfgItem.higher_is_better ? "Higher ↑" : "Lower ↓"}
          </button>
          <div class="score-weight-controls">
            <input type="range" class="score-weight-slider" min="0" max="5" step="0.1" value="${cfgItem.weight}" ${cfgItem.enabled ? "" : "disabled"} aria-label="${escapeHtml(catMeta.label)} weight slider">
            <input type="number" class="score-weight-num" min="0" max="5" step="0.1" value="${cfgItem.weight}" ${cfgItem.enabled ? "" : "disabled"} aria-label="${escapeHtml(catMeta.label)} weight value">
            <span class="score-share-badge">${share}%</span>
          </div>
        </div>
      `);
    }
  }

  const prevScroll = els.scoreMetricsList.scrollTop;
  els.scoreMetricsList.innerHTML = html.length
    ? html.join("")
    : `<div class="popover-empty">No metrics match your filter.</div>`;
  els.scoreMetricsList.scrollTop = prevScroll;

  renderScorePreview(dataset);
}

export function renderScorePreview(dataset) {
  const { rows } = computePoolRows(dataset, readScalarFilters(), matchesPlayer);
  const pool = rows.length ? rows : dataset.players.map((p) => ({ ...p, active_score: 0 }));
  const sorted = [...pool].sort((a, b) => b.active_score - a.active_score).slice(0, 5);
  els.scorePreviewNote.textContent = rows.length
    ? `Top 5 of ${rows.length.toLocaleString()} matching players`
    : `Filtered pool empty — showing dataset sample`;

  els.scorePreviewList.innerHTML = sorted
    .map(
      (p, idx) => {
        const sc = Number(p.active_score ?? 0);
        return `
      <button type="button" class="score-preview-item" data-uid="${escapeHtml(p.uid)}" title="Inspect ${escapeHtml(playerName(p))}">
        <div class="score-preview-meta">
          <div class="score-preview-name">#${idx + 1} ${escapeHtml(playerName(p))}</div>
          <div class="score-preview-sub">${escapeHtml(clubNameOf(p))} · Age ${p.age ?? "?"} · ${p.minutes}m</div>
        </div>
        <span class="pct-pill ${pctClass(Math.round(sc))}">${sc.toFixed(1)}</span>
      </button>
    `;
      }
    )
    .join("");
}

function updateScoreSharesInPlace(dataset) {
  const cfg = state.scoreConfig;
  const enabledItems = cfg.metrics.filter((m) => m.enabled);
  const totalWeight = enabledItems.reduce((s, m) => s + m.weight, 0);
  els.scoreTotalWeight.textContent = `Enabled: ${enabledItems.length} · Total weight: ${totalWeight.toFixed(1)}`;
  if (els.scoreUnsavedBadge) {
    els.scoreUnsavedBadge.hidden = cfg.roleSlug !== "__custom_draft__";
  }
  const cfgByKey = new Map(cfg.metrics.map((m) => [m.key, m]));
  els.scoreMetricsList.querySelectorAll(".score-metric-row").forEach((row) => {
    const item = cfgByKey.get(row.dataset.key);
    const badge = row.querySelector(".score-share-badge");
    if (item && badge) {
      const share = item.enabled && totalWeight > 0 ? ((item.weight / totalWeight) * 100).toFixed(1) : "0.0";
      badge.textContent = `${share}%`;
    }
  });
  renderScorePreview(dataset);
}

function markScoreCustomDraft() {
  const dataset = activeDataset();
  if (!dataset || !state.scoreConfig) return;
  state.scoreConfig.roleSlug = "__custom_draft__";
  state.customDrafts[dataset.position] = state.scoreConfig;
  refreshRoleSelectOptions(dataset, "__custom_draft__");
  const presets = getPosPresets(dataset.position);
  const hasActivePreset = Boolean(state.scoreConfig.presetId && presets.some((p) => p.id === state.scoreConfig.presetId));
  els.scorePresetSelect.value = hasActivePreset ? state.scoreConfig.presetId : "";
  if (els.scoreUnsavedBadge) {
    els.scoreUnsavedBadge.hidden = state.scoreConfig.roleSlug !== "__custom_draft__";
  }
  if (els.scoreUpdatePresetBtn) els.scoreUpdatePresetBtn.disabled = !hasActivePreset;
  els.scoreRenamePresetBtn.disabled = !hasActivePreset;
  els.scoreDeletePresetBtn.disabled = !hasActivePreset;
}

function flushScoreDialogChanges(onRefresh) {
  clearTimeout(state.scoreSyncTimer);
  if (state.scoreSyncRaf) cancelAnimationFrame(state.scoreSyncRaf);
  if (state.scoreDialogDirty) {
    state.scoreDialogDirty = false;
    onRefresh();
  }
}

export function wireScoreDialogEvents(onRefresh, onOpenPlayer = null) {
  enableLightDismissFallback(els.scoreDialog);

  els.btnCustomizeScore.addEventListener("click", () => {
    state.scoreDialogDirty = false;
    state.scoreDialogSnapshot = state.scoreConfig
      ? {
          config: structuredClone(state.scoreConfig),
          hadDraft: Boolean(state.customDrafts[state.pos]),
          draft: state.customDrafts[state.pos] ? structuredClone(state.customDrafts[state.pos]) : null,
        }
      : null;
    renderScoreDialog();
    els.scoreDialog.showModal();
  });

  els.scoreCancelBtn?.addEventListener("click", () => {
    const snap = state.scoreDialogSnapshot;
    const dataset = activeDataset();
    if (snap && dataset) {
      state.scoreConfig = snap.config;
      if (snap.hadDraft && snap.draft) state.customDrafts[dataset.position] = snap.draft;
      else delete state.customDrafts[dataset.position];
      refreshRoleSelectOptions(dataset, state.scoreConfig.roleSlug);
    }
    state.scoreDialogDirty = false;
    state.scoreDialogSnapshot = null;
    els.scoreDialog.close();
  });

  els.scoreCloseBtn.addEventListener("click", () => {
    els.scoreDialog.close();
  });

  els.scoreDialog.addEventListener("close", () => {
    state.scoreDialogSnapshot = null;
    flushScoreDialogChanges(onRefresh);
  });

  els.scoreResetBtn.addEventListener("click", () => {
    const dataset = activeDataset();
    if (!dataset) return;
    const baseRole = state.scoreConfig?.roleSlug?.startsWith("custom:")
      ? state.scoreConfig.roleSlug
      : dataset.roles?.[state.scoreConfig?.roleSlug]
        ? state.scoreConfig.roleSlug
        : "overall";
    delete state.customDrafts[dataset.position];
    state.scoreConfig = buildScoreConfigFromRole(dataset, baseRole, "percentile");
    refreshRoleSelectOptions(dataset, state.scoreConfig.roleSlug);
    renderScoreDialog();
    state.scoreDialogDirty = true;
    flushScoreDialogChanges(onRefresh);
    showToast("Role score reset");
  });

  els.scoreMethod.addEventListener("change", () => {
    if (!state.scoreConfig) return;
    state.scoreConfig.method = els.scoreMethod.value;
    els.scoreMethodHint.textContent = METHOD_HINTS[state.scoreConfig.method] || "";
    const dataset = activeDataset();
    if (dataset) {
      if (state.scoreConfig.presetId || state.scoreConfig.roleSlug === "__custom_draft__") {
        markScoreCustomDraft();
      }
      renderScorePreview(dataset);
    }
    state.scoreDialogDirty = true;
  });

  els.scoreMetricSearch.addEventListener("input", renderScoreDialog);
  els.scoreCategoryFilter.addEventListener("change", renderScoreDialog);
  els.scoreEnabledOnly.addEventListener("change", renderScoreDialog);

  els.scoreDefaultsBtn?.addEventListener("click", () => {
    const dataset = activeDataset();
    if (!dataset || !state.scoreConfig) return;
    const catalog = getMetricCatalog(dataset);
    for (const item of state.scoreConfig.metrics) {
      const cat = catalog.byKey.get(item.key);
      item.enabled = catalog.defaultKeys.has(item.key);
      item.weight = 1;
      if (cat) item.higher_is_better = cat.higher_is_better;
    }
    markScoreCustomDraft();
    renderScoreDialog();
    state.scoreDialogDirty = true;
  });

  els.scoreEqualizeBtn?.addEventListener("click", () => {
    const dataset = activeDataset();
    if (!dataset || !state.scoreConfig) return;
    for (const item of state.scoreConfig.metrics) {
      if (item.enabled) item.weight = 1;
    }
    markScoreCustomDraft();
    renderScoreDialog();
    state.scoreDialogDirty = true;
  });

  els.scoreClearMetricsBtn?.addEventListener("click", () => {
    if (!state.scoreConfig) return;
    for (const item of state.scoreConfig.metrics) item.enabled = false;
    markScoreCustomDraft();
    renderScoreDialog();
    state.scoreDialogDirty = true;
  });

  els.scoreMetricsList.addEventListener("click", (ev) => {
    const row = ev.target.closest(".score-metric-row");
    if (!row || !state.scoreConfig) return;
    const item = state.scoreConfig.metrics.find((m) => m.key === row.dataset.key);
    if (!item) return;

    const dirBtn = ev.target.closest(".score-dir-btn");
    if (dirBtn) {
      item.higher_is_better = !item.higher_is_better;
      dirBtn.setAttribute("aria-pressed", String(item.higher_is_better));
      dirBtn.textContent = item.higher_is_better ? "Higher ↑" : "Lower ↓";
      markScoreCustomDraft();
      const dataset = activeDataset();
      if (dataset) renderScorePreview(dataset);
      state.scoreDialogDirty = true;
    }
  });

  els.scoreMetricsList.addEventListener("change", (ev) => {
    const row = ev.target.closest(".score-metric-row");
    if (!row || !state.scoreConfig) return;
    const item = state.scoreConfig.metrics.find((m) => m.key === row.dataset.key);
    const dataset = activeDataset();
    if (!item || !dataset) return;

    if (ev.target.classList.contains("score-enable-cb")) {
      item.enabled = ev.target.checked;
      row.classList.toggle("is-disabled", !item.enabled);
      const slider = row.querySelector(".score-weight-slider");
      const num = row.querySelector(".score-weight-num");
      if (slider) slider.disabled = !item.enabled;
      if (num) num.disabled = !item.enabled;
      markScoreCustomDraft();
      updateScoreSharesInPlace(dataset);
      state.scoreDialogDirty = true;
    } else if (ev.target.classList.contains("score-weight-num") || ev.target.classList.contains("score-weight-slider")) {
      const val = Math.max(0, Math.min(5, Number(ev.target.value) || 0));
      item.weight = val;
      const slider = row.querySelector(".score-weight-slider");
      const num = row.querySelector(".score-weight-num");
      if (slider) slider.value = String(val);
      if (num) num.value = String(val);
      markScoreCustomDraft();
      updateScoreSharesInPlace(dataset);
      state.scoreDialogDirty = true;
    }
  });

  els.scoreMetricsList.addEventListener("input", (ev) => {
    if (!ev.target.classList.contains("score-weight-slider")) return;
    const row = ev.target.closest(".score-metric-row");
    if (!row || !state.scoreConfig) return;
    const item = state.scoreConfig.metrics.find((m) => m.key === row.dataset.key);
    const dataset = activeDataset();
    if (!item || !dataset) return;

    const val = Math.max(0, Math.min(5, Number(ev.target.value) || 0));
    item.weight = val;
    const num = row.querySelector(".score-weight-num");
    if (num) num.value = String(val);
    markScoreCustomDraft();
    updateScoreSharesInPlace(dataset);
    state.scoreDialogDirty = true;
  });

  els.scorePresetSelect.addEventListener("change", () => {
    const dataset = activeDataset();
    if (!dataset) return;
    const id = els.scorePresetSelect.value;
    if (!id) {
      if (state.scoreConfig) state.scoreConfig.presetId = null;
      if (els.scoreUpdatePresetBtn) els.scoreUpdatePresetBtn.disabled = true;
      els.scoreRenamePresetBtn.disabled = true;
      els.scoreDeletePresetBtn.disabled = true;
      return;
    }
    state.scoreConfig = buildScoreConfigFromRole(dataset, `custom:${id}`);
    refreshRoleSelectOptions(dataset, `custom:${id}`);
    renderScoreDialog();
    state.scoreDialogDirty = true;
    flushScoreDialogChanges(onRefresh);
  });

  els.scoreSavePresetBtn.addEventListener("click", () => {
    const dataset = activeDataset();
    if (!dataset || !state.scoreConfig) return;
    const pos = dataset.position;
    const existing = getPosPresets(pos);
    const rawName = els.scorePresetName.value.trim() || `Custom ${pos} ${existing.length + 1}`;
    const id = `p_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`;
    const enabledMetrics = state.scoreConfig.metrics
      .filter((m) => m.enabled)
      .map((m) => ({ key: m.key, weight: m.weight, higher_is_better: m.higher_is_better }));
    if (!enabledMetrics.length) {
      showToast("Enable at least one metric to save a preset");
      return;
    }
    const newPreset = {
      id,
      name: rawName,
      method: state.scoreConfig.method || "percentile",
      metrics: enabledMetrics,
    };
    if (!state.presets[pos]) state.presets[pos] = [];
    state.presets[pos].push(newPreset);
    savePresets();
    delete state.customDrafts[pos];
    state.scoreConfig = buildScoreConfigFromRole(dataset, `custom:${id}`);
    refreshRoleSelectOptions(dataset, `custom:${id}`);
    renderScoreDialog();
    state.scoreDialogDirty = true;
    flushScoreDialogChanges(onRefresh);
    showToast(`Saved preset "${rawName}"`);
  });

  els.scoreUpdatePresetBtn?.addEventListener("click", () => {
    const dataset = activeDataset();
    if (!dataset || !state.scoreConfig) return;
    const id = els.scorePresetSelect.value;
    const preset = getPosPresets(dataset.position).find((p) => p.id === id);
    if (!preset) return;
    const enabledMetrics = state.scoreConfig.metrics
      .filter((m) => m.enabled)
      .map((m) => ({ key: m.key, weight: m.weight, higher_is_better: m.higher_is_better }));
    if (!enabledMetrics.length) {
      showToast("Enable at least one metric to update preset");
      return;
    }
    preset.name = els.scorePresetName.value.trim() || preset.name;
    preset.method = state.scoreConfig.method || "percentile";
    preset.metrics = enabledMetrics;
    savePresets();
    delete state.customDrafts[dataset.position];
    state.scoreConfig = buildScoreConfigFromRole(dataset, `custom:${id}`);
    refreshRoleSelectOptions(dataset, `custom:${id}`);
    renderScoreDialog();
    state.scoreDialogDirty = true;
    flushScoreDialogChanges(onRefresh);
    showToast(`Updated preset "${preset.name}"`);
  });

  els.scoreRenamePresetBtn.addEventListener("click", () => {
    const dataset = activeDataset();
    if (!dataset) return;
    const id = els.scorePresetSelect.value;
    const newName = els.scorePresetName.value.trim();
    if (!id || !newName) {
      showToast("Enter a preset name to rename");
      return;
    }
    const preset = getPosPresets(dataset.position).find((p) => p.id === id);
    if (!preset) return;
    preset.name = newName;
    savePresets();
    refreshRoleSelectOptions(dataset, `custom:${id}`);
    renderScoreDialog();
    showToast(`Renamed preset to "${newName}"`);
  });

  els.scorePreviewList?.addEventListener("click", (ev) => {
    const item = ev.target.closest(".score-preview-item[data-uid]");
    const dataset = activeDataset();
    if (!item || !dataset || !onOpenPlayer) return;
    const player = dataset.players.find((p) => p.uid === item.dataset.uid);
    if (player) onOpenPlayer(player, dataset);
  });

  els.scoreDeletePresetBtn.addEventListener("click", () => {
    const dataset = activeDataset();
    if (!dataset) return;
    const pos = dataset.position;
    const id = els.scorePresetSelect.value;
    if (!id) return;
    const list = getPosPresets(pos);
    const targetIdx = list.findIndex((p) => p.id === id);
    const target = targetIdx >= 0 ? list[targetIdx] : null;
    state.presets[pos] = list.filter((p) => p.id !== id);
    savePresets();
    els.scorePresetName.value = "";
    state.scoreConfig = buildScoreConfigFromRole(dataset, "overall", state.scoreConfig?.method);
    refreshRoleSelectOptions(dataset, "overall");
    renderScoreDialog();
    state.scoreDialogDirty = true;
    flushScoreDialogChanges(onRefresh);
    if (target) {
      showToast(`Deleted preset "${target.name}"`, {
        actionLabel: "Undo",
        onAction: () => {
          const cur = getPosPresets(pos);
          if (!cur.some((p) => p.id === target.id)) {
            const restored = [...cur];
            restored.splice(Math.min(targetIdx, restored.length), 0, target);
            state.presets[pos] = restored;
            savePresets();
          }
          const ds = activeDataset();
          if (ds && ds.position === pos) {
            state.scoreConfig = buildScoreConfigFromRole(ds, `custom:${target.id}`);
            refreshRoleSelectOptions(ds, `custom:${target.id}`);
            if (els.scoreDialog.open) renderScoreDialog();
            onRefresh();
          }
        },
      });
    }
  });
}
