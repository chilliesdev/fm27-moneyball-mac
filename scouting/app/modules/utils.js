import { els } from "./state.js";

export function escapeHtml(str) {
  return String(str ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

export function playerName(p) {
  return p?.name || `Player #${p?.uid ?? "?"}`;
}

export async function copyPlayerName(player, button = null) {
  if (!player?.name) return;
  try {
    await navigator.clipboard.writeText(player.name);
    showToast(`Copied "${player.name}"`);
    if (button) {
      const prev = button.textContent;
      button.textContent = "Copied!";
      clearTimeout(button._copyTimer);
      button._copyTimer = setTimeout(() => {
        if (button.isConnected) button.textContent = prev;
      }, 1500);
    }
  } catch {
    showToast("Copy failed");
  }
}

export function clubNameOf(p) {
  return p?.club || "Free Agent";
}

export function clubKeyOf(p) {
  return p?.club_uid ? String(p.club_uid) : `name:${clubNameOf(p)}`;
}

export function personImgUrl(p) {
  const id = p.img_id || p.uid || "";
  const name = playerName(p);
  return `/api/img/person/${encodeURIComponent(id)}?name=${encodeURIComponent(name)}`;
}

export function clubImgUrl(id, name) {
  return `/api/img/club/${encodeURIComponent(id || "")}?name=${encodeURIComponent(name || "Club")}`;
}

export function formatMoney(val) {
  if (val === null || val === undefined || val === "") return "—";
  const num = Number(val);
  if (!Number.isFinite(num)) return "—";
  if (num >= 1_000_000) return `£${(num / 1_000_000).toFixed(1)}M`;
  if (num >= 1_000) return `£${Math.round(num / 1_000)}k`;
  return `£${Math.round(num)}`;
}

export function formatPlayerValue(player) {
  const formatted = formatMoney(player?.value);
  if (formatted !== "—") return formatted;
  return player?.value_state === "placeholder" ? "Undisclosed" : "—";
}

export function formatStat(key, val) {
  if (val === null || val === undefined || val === "") return "—";
  const num = Number(val);
  if (!Number.isFinite(num)) return "—";
  if (key.endsWith("_pct") || key === "save_pct" || key === "clean_sheet_pct") {
    return `${num.toFixed(1)}%`;
  }
  if (key === "goals" || key === "assists" || key === "apps" || key === "starts" || key === "minutes") {
    return String(Math.round(num));
  }
  return num.toFixed(2);
}

export function pctClass(pct) {
  if (pct >= 85) return "pct-elite";
  if (pct >= 65) return "pct-good";
  if (pct >= 35) return "pct-mid";
  return "pct-low";
}

export function showToast(message, options = null) {
  if (!els.toastRegion || !message) return;
  const openDialogs = [...document.querySelectorAll("dialog[open]")];
  const host = openDialogs.length ? openDialogs[openDialogs.length - 1] : document.body;
  if (els.toastRegion.parentElement !== host) {
    try {
      if (els.toastRegion.matches(":popover-open")) els.toastRegion.hidePopover();
    } catch {
      // Ignore popover support differences
    }
    host.append(els.toastRegion);
  }
  while (els.toastRegion.children.length >= 3) {
    els.toastRegion.firstElementChild.remove();
  }
  const item = document.createElement("div");
  item.className = "toast-item";
  const textSpan = document.createElement("span");
  textSpan.className = "toast-message";
  textSpan.textContent = message;
  item.append(textSpan);

  let remaining = options?.duration ?? (options?.onAction ? 5000 : 3000);
  let startedAt = Date.now();
  let timer = null;

  const dismiss = () => {
    clearTimeout(timer);
    item.remove();
    if (!els.toastRegion.children.length) {
      try {
        if (els.toastRegion.matches(":popover-open")) els.toastRegion.hidePopover();
      } catch {
        // Ignore popover support differences
      }
    }
  };

  if (options?.actionLabel && typeof options?.onAction === "function") {
    const actionBtn = document.createElement("button");
    actionBtn.type = "button";
    actionBtn.className = "btn-link toast-action-btn";
    actionBtn.textContent = options.actionLabel;
    actionBtn.addEventListener("click", () => {
      dismiss();
      options.onAction();
    });
    item.append(actionBtn);
  }

  const schedule = () => {
    startedAt = Date.now();
    clearTimeout(timer);
    timer = setTimeout(dismiss, remaining);
  };
  const pause = () => {
    clearTimeout(timer);
    remaining = Math.max(400, remaining - (Date.now() - startedAt));
  };

  item.addEventListener("mouseenter", pause);
  item.addEventListener("mouseleave", schedule);
  item.addEventListener("focusin", pause);
  item.addEventListener("focusout", schedule);
  els.toastRegion.append(item);
  try {
    if (typeof els.toastRegion.showPopover === "function") {
      if (els.toastRegion.matches(":popover-open")) els.toastRegion.hidePopover();
      els.toastRegion.showPopover();
    }
  } catch {
    // Ignore popover support differences
  }
  schedule();
}

export function enableLightDismissFallback(dialog) {
  if ("closedBy" in HTMLDialogElement.prototype) return;
  dialog.addEventListener("click", (event) => {
    if (event.target !== dialog) return;
    const rect = dialog.getBoundingClientRect();
    const inside =
      rect.top <= event.clientY &&
      event.clientY <= rect.top + rect.height &&
      rect.left <= event.clientX &&
      event.clientX <= rect.left + rect.width;
    if (!inside) dialog.close();
  });
}

export function isDarkColorScheme() {
  const meta = document.querySelector('meta[name="color-scheme"]')?.content;
  if (meta === "dark") return true;
  if (meta === "light") return false;
  return window.matchMedia("(prefers-color-scheme: dark)").matches;
}

export function getThemeColors() {
  const cs = getComputedStyle(document.documentElement);
  const isDark = isDarkColorScheme();
  const mode = isDark ? "dark" : "light";
  const read = (prop) => cs.getPropertyValue(`--${prop}-${mode}`).trim();
  return {
    surface: read("surface"),
    border: read("border"),
    text: read("text"),
    muted: read("muted"),
    accent: read("accent"),
    compare: read("compare"),
    poolDot: read("pool-dot"),
    gridLine: isDark ? "rgba(154, 166, 181, 0.16)" : "rgba(82, 93, 109, 0.15)",
    quadrantFill: isDark ? "rgba(245, 158, 11, 0.08)" : "rgba(196, 107, 0, 0.07)",
  };
}

export function normalizeSearchText(value) {
  return String(value ?? "").normalize("NFD").replace(/\p{M}/gu, "").toLowerCase().trim();
}

export function parsePlayerPositions(posStr) {
  return String(posStr ?? "")
    .split(";")
    .map((s) => {
      const t = s.trim();
      return t === "STC" ? "ST" : t;
    })
    .filter(Boolean);
}

export function downloadCsv(rows, filename, dataset, visibleFields = null) {
  if (!rows.length) return;
  const cols = visibleFields?.length
    ? visibleFields
    : [
        "name",
        "club",
        "league",
        "nation",
        "foot",
        "age",
        "positions",
        "minutes",
        "apps",
        "value",
        "wage",
        "contract_end",
        "avg_rating",
        "active_score",
        ...(dataset.metrics || []).map((m) => m.key),
      ];
  const escapeCsv = (v) => {
    const s = String(v ?? "");
    return s.includes(",") || s.includes('"') || s.includes("\n") ? `"${s.replaceAll('"', '""')}"` : s;
  };
  const lines = [cols.join(","), ...rows.map((r) => cols.map((c) => escapeCsv(r[c])).join(","))];
  const blob = new Blob([lines.join("\n")], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
  showToast(`Exported ${rows.length} rows to CSV`);
}
