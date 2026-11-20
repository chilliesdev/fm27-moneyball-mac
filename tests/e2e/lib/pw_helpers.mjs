// Shared Playwright/Chromium helpers for FM27 Moneyball Scout E2E tests.
// Uses cached Playwright under ~/.npm/_npx and ms-playwright Chromium without workspace node_modules.

import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);

export function loadPlaywright() {
  const npxRoot = path.join(os.homedir(), ".npm", "_npx");
  if (!fs.existsSync(npxRoot)) {
    throw new Error(`npm _npx cache not found at ${npxRoot}`);
  }
  const candidates = fs
    .readdirSync(npxRoot)
    .map((d) => path.join(npxRoot, d, "node_modules", "playwright", "package.json"))
    .filter((p) => fs.existsSync(p));
  if (!candidates.length) {
    throw new Error("Cached playwright package not found under ~/.npm/_npx");
  }
  return createRequire(candidates[0])("playwright");
}

export function findChromiumExecutable() {
  const cacheRoot = path.join(os.homedir(), "Library", "Caches", "ms-playwright");
  if (!fs.existsSync(cacheRoot)) {
    throw new Error(`ms-playwright cache not found at ${cacheRoot}`);
  }
  const preferred = path.join(
    cacheRoot,
    "chromium-1243",
    "chrome-mac-arm64",
    "Google Chrome for Testing.app",
    "Contents",
    "MacOS",
    "Google Chrome for Testing"
  );
  if (fs.existsSync(preferred)) return preferred;

  const dirs = fs
    .readdirSync(cacheRoot)
    .filter((d) => d.startsWith("chromium-"))
    .sort();
  while (dirs.length) {
    const dir = dirs.pop();
    const bin = path.join(
      cacheRoot,
      dir,
      "chrome-mac-arm64",
      "Google Chrome for Testing.app",
      "Contents",
      "MacOS",
      "Google Chrome for Testing"
    );
    if (fs.existsSync(bin)) return bin;
  }
  throw new Error("No ms-playwright chromium-* binary found");
}

export function attachNetworkAndErrorTrackers(page, allowedOriginPrefix) {
  const consoleErrors = [];
  const pageErrors = [];
  const badResponses = [];
  const externalRequests = [];

  page.on("console", (msg) => {
    if (msg.type() === "error") {
      consoleErrors.push(msg.text());
    }
  });

  page.on("pageerror", (err) => {
    pageErrors.push(err?.message || String(err));
  });

  page.on("response", (res) => {
    if (res.status() >= 400) {
      badResponses.push(`${res.status()} ${res.url()}`);
    }
  });

  page.on("request", (req) => {
    const u = req.url();
    if (u.startsWith("data:") || u.startsWith("blob:") || u.startsWith("about:")) return;
    if (allowedOriginPrefix && u.startsWith(allowedOriginPrefix)) return;
    if (/^https?:\/\/(127\.0\.0\.1|localhost)(:\d+)?(\/|$)/i.test(u)) return;
    externalRequests.push(u);
  });

  return {
    consoleErrors,
    pageErrors,
    badResponses,
    externalRequests,
    assertClean(label = "page") {
      if (consoleErrors.length) {
        throw new Error(`${label} console.error(s): ${consoleErrors.slice(0, 3).join(" | ")}`);
      }
      if (pageErrors.length) {
        throw new Error(`${label} pageerror(s): ${pageErrors.slice(0, 3).join(" | ")}`);
      }
      if (badResponses.length) {
        throw new Error(`${label} HTTP >=400 response(s): ${badResponses.slice(0, 3).join(" | ")}`);
      }
      if (externalRequests.length) {
        throw new Error(`${label} external request(s): ${externalRequests.slice(0, 3).join(" | ")}`);
      }
    },
  };
}

export async function openApp(browser, baseUrl, { colorScheme = "light", viewport = { width: 1440, height: 900 }, preInitHook = null } = {}) {
  const context = await browser.newContext({
    baseURL: baseUrl,
    colorScheme,
    viewport,
    acceptDownloads: true,
  });
  context.setDefaultTimeout(10000);
  try {
    const page = await context.newPage();
    const tracker = attachNetworkAndErrorTrackers(page, baseUrl);
    if (preInitHook) await preInitHook(page, context);
    await page.goto(baseUrl, { waitUntil: "domcontentloaded", timeout: 30000 });
    await waitForAppReady(page);
    return { context, page, tracker };
  } catch (error) {
    await context.close();
    throw error;
  }
}

export async function waitForAppReady(page) {
  await page.waitForFunction(
    () => {
      const ps = document.getElementById("pool-summary");
      const tablist = document.getElementById("position-tablist");
      return ps && /targets matched/i.test(ps.textContent || "") && tablist?.getAttribute("aria-busy") !== "true";
    },
    null,
    { timeout: 30000 }
  );
}

export async function getMatchedCount(page) {
  const txt = (await page.locator("#pool-summary").textContent()) || "";
  const m = txt.match(/([\d,]+)\s+targets matched/i);
  if (!m) throw new Error(`Unable to parse matched count from #pool-summary: ${txt}`);
  return Number(m[1].replaceAll(",", ""));
}

export async function switchPositionTab(page, pos) {
  const tab = page.locator(`#tab-${pos}`);
  if ((await tab.count()) === 0) {
    throw new Error(`Position tab #tab-${pos} not found`);
  }
  await tab.click();
  await page.waitForFunction(
    (p) => document.querySelector(`#tab-${p}`)?.getAttribute("aria-selected") === "true",
    pos,
    { timeout: 2500 }
  );
  await waitForAppReady(page);
}

export async function setRelaxedPoolFilters(page) {
  await page.locator("#f-max-val").selectOption("999999999", { timeout: 10000 });
  await page.locator("#f-min-rep").selectOption("0", { timeout: 10000 });
  await page.waitForTimeout(50);
}

export async function findFilterTrigger(page, nameRegex) {
  const triggers = page.locator(".filters-panel .field > button[popovertarget]");
  const labels = await triggers.evaluateAll((buttons) => buttons.map((button) => ({
    id: button.id,
    label: button.parentElement.querySelector(":scope > span").textContent.trim(),
  })));
  const matches = labels.filter(({ label }) => nameRegex.test(label));
  assert(matches.length === 1, `Expected one filter trigger matching ${nameRegex}`);
  return triggers.and(page.locator(`[id=${JSON.stringify(matches[0].id)}]`));
}

export async function getRowShortlistStars(page) {
  const byAttr = page.locator(
    '.tabulator .tabulator-row button[aria-label*="shortlist"i], .tabulator .tabulator-row button[title*="shortlist"i], .tabulator .tabulator-row button[data-action="shortlist"], .tabulator .tabulator-row button.shortlist-star'
  );
  if ((await byAttr.count()) > 0) return byAttr;
  return page.locator(".tabulator .tabulator-row button").filter({ hasText: /★|☆/ });
}

export async function openFilterPopover(page, nameRegex) {
  const trigger = await findFilterTrigger(page, nameRegex);
  const targetId = await trigger.getAttribute("popovertarget");
  const popover = page.locator(`[id=${JSON.stringify(targetId)}][popover]`);
  await trigger.click();
  await popover.waitFor({ state: "visible" });
  await trigger.and(page.locator('[aria-expanded="true"]')).waitFor();
  return { trigger, popover };
}

export async function findResetFiltersButton(page) {
  const byId = page.locator("#btn-reset-filters");
  if ((await byId.count()) > 0) return byId.first();
  const btn = page.getByRole("button", { name: /reset\s*filters/i });
  if ((await btn.count()) === 0) {
    throw new Error("Reset Filters button not found");
  }
  return btn.first();
}

export async function findCustomizeScoreButton(page) {
  const byId = page.locator('#btn-customize-score, button[title*="Customize Role Score"i]');
  if ((await byId.count()) > 0) return byId.first();
  const btn = page.getByRole("button", { name: /^customize(\s*(role\s*)?score)?$/i });
  if ((await btn.count()) === 0) {
    throw new Error("Customize Score button not found");
  }
  return btn.first();
}

export async function findTabulator(page) {
  const tab = page.locator(".tabulator");
  if ((await tab.count()) === 0) {
    throw new Error("Tabulator container (.tabulator) not found (table still legacy <table>?)");
  }
  return tab.first();
}

export async function getTabulatorRowCount(page) {
  await findTabulator(page);
  return await page.locator(".tabulator .tabulator-row").count();
}

export async function getScatterCanvas(page) {
  const legacySvg = page.locator("#scatter-svg");
  if ((await legacySvg.count()) > 0 && (await legacySvg.isVisible())) {
    throw new Error("Legacy #scatter-svg is still present instead of ECharts <canvas>");
  }
  const canvas = page.locator(".scatter-card canvas, .scatter-wrap canvas").first();
  if ((await canvas.count()) === 0) {
    throw new Error("ECharts scatter <canvas> not found inside .scatter-card");
  }
  return canvas;
}

export async function getCanvasDataUrl(canvas) {
  return await canvas.evaluate((el) => el.toDataURL("image/png"));
}

export async function openFirstProfileDialog(page) {
  await findTabulator(page);
  const firstBtn = page.locator(".tabulator .tabulator-row").first().locator("button.player-link, a, button").filter({ hasText: /[A-Za-z]/ }).first();
  await firstBtn.click();
  const dlg = page.locator("#player-dialog[open]");
  await dlg.waitFor({ state: "visible" });
  await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
  return dlg;
}

export function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}
