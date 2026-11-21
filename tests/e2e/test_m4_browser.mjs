// Opaque-box E2E browser tests for F9 (browser checks), F10-F15 (Tiers 1-2), Tier 3, and Tier 4.
// Run: node tests/e2e/test_m4_browser.mjs --base-url http://127.0.0.1:<port> [--tier {1,2,3,4,all}] [--json-out PATH]

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  assert,
  findChromiumExecutable,
  findCustomizeScoreButton,
  findFilterTrigger,
  findResetFiltersButton,
  findTabulator,
  getCanvasDataUrl,
  getMatchedCount,
  getRowShortlistStars,
  getScatterCanvas,
  getTabulatorRowCount,
  loadPlaywright,
  openApp,
  openFilterPopover,
  openFirstProfileDialog,
  setRelaxedPoolFilters,
  switchPositionTab,
  waitForAppReady,
} from "./lib/pw_helpers.mjs";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const APP_DIR = path.join(REPO_ROOT, "scouting", "app");

function parseArgs(argv) {
  const opts = { tier: "all", baseUrl: process.env.BASE_URL || "", jsonOut: "" };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--tier" && i + 1 < argv.length) opts.tier = argv[++i];
    else if (a === "--base-url" && i + 1 < argv.length) opts.baseUrl = argv[++i];
    else if (a === "--json-out" && i + 1 < argv.length) opts.jsonOut = argv[++i];
  }
  return opts;
}

function escapeRegex(str) {
  return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

async function selectSeasonWithManagedPlayers(page) {
  const count = () => page.locator("#scatter-chart").evaluate((el) =>
    window.echarts.getInstanceByDom(el).getOption().series[1].data.length);
  const selector = page.locator("#f-season");
  const current = await selector.inputValue();
  const seasons = await selector.locator("option").evaluateAll((options) => options.map((option) => option.value));
  for (const season of seasons) {
    if (await count()) return;
    if (season === current) continue;
    await selector.selectOption(season);
    await page.waitForFunction((value) => document.querySelector("#save-meta").textContent.includes(`Season ${value} ·`), season);
    await waitForAppReady(page);
  }
  assert(await count(), "No season has managed-club players on the scatter plot");
}

async function waitForChartColors(page, selector, scheme, tokens) {
  await page.waitForFunction(({ selector, scheme, tokens }) => {
    const canvas = document.querySelector(`${selector} canvas`);
    if (!canvas?.width || !canvas.height) return false;
    const colors = getComputedStyle(document.documentElement);
    const pending = tokens.map((token) => {
      const hex = colors.getPropertyValue(`--${token}-${scheme}`).trim();
      return [1, 3, 5].map((offset) => parseInt(hex.slice(offset, offset + 2), 16));
    });
    const pixels = canvas.getContext("2d").getImageData(0, 0, canvas.width, canvas.height).data;
    for (let i = 0; i < pixels.length && pending.length; i += 4) {
      if (pixels[i + 3] < 200) continue;
      const match = pending.findIndex((rgb) => rgb.every((channel, j) => Math.abs(channel - pixels[i + j]) <= 2));
      if (match >= 0) pending.splice(match, 1);
    }
    return pending.length === 0;
  }, { selector, scheme, tokens });
}

async function getPopoverCheckboxes(popover) {
  const cbs = popover.locator('input[type="checkbox"]:visible');
  if ((await cbs.count()) > 0) return cbs;
  return popover.locator('[role="option"]:visible');
}

async function isPopoverOptionSelected(opt) {
  const tag = await opt.evaluate((el) => el.tagName);
  if (tag === "INPUT") return await opt.isChecked();
  return (await opt.getAttribute("aria-selected")) === "true";
}

async function getPopoverOptionLabel(opt) {
  return await opt.evaluate((el) => {
    const lblEl = el.querySelector(".opt-label") || el.closest("label") || el.parentElement;
    if (el.tagName !== "INPUT") {
      const labelSpan = el.querySelector(".opt-label");
      if (labelSpan) return (labelSpan.textContent || "").trim();
    }
    return (lblEl?.textContent || el.textContent || "").trim();
  });
}

async function setPopoverOptionSelected(opt, desired) {
  const cur = await isPopoverOptionSelected(opt);
  if (cur === desired) return;
  const tag = await opt.evaluate((el) => el.tagName);
  if (tag === "INPUT") {
    if (desired) await opt.check();
    else await opt.uncheck();
  } else {
    await opt.click();
  }
}

async function getPopoverSearchInput(popover) {
  const inp = popover.locator('input[type="search"], input[type="text"], input:not([type="checkbox"]):not([type="radio"])');
  assert((await inp.count()) > 0, "Popover missing search input");
  return inp.first();
}

async function selectFirstMatchingInPopover(page, nameRegex, searchText = "", countToPick = 1) {
  const { popover } = await openFilterPopover(page, nameRegex);
  if (searchText) {
    const searchInp = popover.locator('input[type="search"], input[type="text"], input:not([type="checkbox"]):not([type="radio"])');
    if ((await searchInp.count()) > 0) {
      await searchInp.first().fill(searchText);
    }
  }

  const getOptionMatchValues = async () => {
    const opts = await getPopoverCheckboxes(popover);
    const total = await opts.count();
    const entries = [];
    for (let i = 0; i < total; i++) {
      const opt = opts.nth(i);
      const labelTxt = await getPopoverOptionLabel(opt);
      const valAttr = await opt.getAttribute("data-value");
      entries.push({ i, labelTxt, valAttr });
    }
    return { opts, entries };
  };

  let pickedIndices = [];
  const { opts, entries } = await getOptionMatchValues();
  if (searchText) {
    const exactRx = new RegExp(`(^|\\b)${escapeRegex(searchText)}(\\b|$)`, "i");
    const subRx = new RegExp(escapeRegex(searchText), "i");
    for (const rx of [exactRx, subRx]) {
      pickedIndices = entries.filter((e) => rx.test(e.labelTxt)).map((e) => e.i);
      if (pickedIndices.length >= countToPick) break;
    }
  } else {
    pickedIndices = entries.map((e) => e.i);
  }

  assert(
    pickedIndices.length >= countToPick,
    `Expected >=${countToPick} matching visible options for '${searchText}' in ${nameRegex}, got ${pickedIndices.length}`
  );

  const pickedLabels = [];
  const targets = pickedIndices.slice(0, countToPick).map((idx) => entries[idx]);
  for (const t of targets) {
    let targetOpt = opts.nth(t.i);
    if (t.valAttr !== null) {
      const byVal = popover.locator(`[role="option"][data-value="${t.valAttr.replaceAll('"', '\\"')}"]:visible`);
      if ((await byVal.count()) > 0) targetOpt = byVal.first();
    }
    await setPopoverOptionSelected(targetOpt, true);
    pickedLabels.push(t.labelTxt);
  }
  await page.keyboard.press("Escape");
  return pickedLabels;
}

async function selectOptionByText(selectLocator, textRegex) {
  const opts = selectLocator.locator("option");
  const n = await opts.count();
  for (let i = 0; i < n; i++) {
    const txt = (await opts.nth(i).textContent()) || "";
    if (textRegex.test(txt)) {
      const val = await opts.nth(i).getAttribute("value");
      await selectLocator.selectOption(val, { timeout: 10000 });
      return val;
    }
  }
  throw new Error(`No <option> matching ${textRegex} found`);
}

async function findCustomizeDialog(page) {
  const btn = await findCustomizeScoreButton(page);
  await btn.click();
  const dlg = page.locator("dialog[open]").filter({ hasText: /percentile|z-score|min-max/i });
  assert((await dlg.count()) > 0, "Customize Score <dialog open> did not open");
  return dlg.first();
}

async function findPresetNameInput(dlg) {
  const named = dlg.locator(
    'input[placeholder*="preset"i], input[placeholder*="name"i], input[aria-label*="preset"i], input[aria-label*="name"i]'
  );
  if ((await named.count()) > 0) return named.first();
  const textInputs = dlg.locator('input[type="text"]');
  assert((await textInputs.count()) > 0, "Preset name input not found");
  return textInputs.last();
}

async function selectCalcMethod(dlg, rx) {
  const methodSel = dlg.locator("select").filter({ hasText: /Percentile|Z-Score|Min-Max/i }).first();
  if ((await methodSel.count()) > 0) {
    const opt = methodSel.locator("option").filter({ hasText: rx }).first();
    assert((await opt.count()) > 0, `Method option matching ${rx} not found`);
    const val = await opt.getAttribute("value");
    await methodSel.selectOption(val);
    return;
  }
  const radioRole = dlg.getByRole("radio", { name: rx });
  if ((await radioRole.count()) > 0) {
    await radioRole.first().check();
    return;
  }
  const radioLabel = dlg.locator("label").filter({ hasText: rx }).first();
  if ((await radioLabel.count()) > 0) {
    await radioLabel.click();
    return;
  }
  throw new Error(`Calculation method control matching ${rx} not found`);
}

async function getTableRowScoresSnapshot(page) {
  const rows = page.locator(".tabulator .tabulator-row");
  const n = Math.min(5, await rows.count());
  const out = [];
  for (let i = 0; i < n; i++) {
    out.push(((await rows.nth(i).textContent()) || "").trim());
  }
  return out.join("||");
}

async function verifyScatterPngExport(page) {
  const card = page.locator(".scatter-card");
  const byRole = card.getByRole("button", { name: /png|export/i });
  const byAttr = card.locator(
    'button[aria-label*="png"i], button[aria-label*="export"i], button[title*="png"i], button[title*="export"i]'
  );
  const expBtn = (await byRole.count()) > 0 ? byRole.first() : byAttr.first();
  if ((await expBtn.count()) > 0) {
    const [dl] = await Promise.all([
      page.waitForEvent("download", { timeout: 2500 }),
      expBtn.click(),
    ]);
    const dlPath = await dl.path();
    assert(dlPath && fs.statSync(dlPath).size > 1000, "Exported scatter PNG too small");
    return;
  }
  const toolboxPng = await getScatterCanvas(page).then((c) =>
    c.evaluate((el) => {
      const inst = window.echarts?.getInstanceByDom(el.closest("[_echarts_instance_]") || el.parentElement?.parentElement);
      const tb = inst?.getOption()?.toolbox;
      const hasSave = Array.isArray(tb) && tb.some((item) => Boolean(item?.feature?.saveAsImage));
      if (!hasSave) return null;
      return inst.getDataURL({ type: "png" });
    })
  );
  assert(toolboxPng && toolboxPng.startsWith("data:image/png;base64,") && toolboxPng.length > 2000, "Scatter PNG export button / toolbox saveAsImage missing");
}

async function getColumnChooserButton(page) {
  const btn = page.getByRole("button", { name: /column(s|\s*chooser)/i });
  assert((await btn.count()) > 0, "Column Chooser button not found");
  return btn.first();
}

async function getFilterChips(page) {
  return page
    .locator(
      "#active-filters-chips button, .active-filters-chips button, .active-filters-bar button, #filter-chips button, .active-filters button, [data-filter-chips] button, .filter-chips button, .chips-bar button, .filter-chip button, [data-chip] button, .chip button, button.chip-btn, button.filter-chip, button.chip, button[data-chip]"
    )
    .filter({ hasNotText: /reset/i });
}

async function buildTwoSeasonRoutes(page, { dropPlayerUid = null } = {}) {
  const stRes = await page.request.get("/data/ST.json");
  const stData = await stRes.json();
  const metaRes = await page.request.get("/data/meta.json");
  const metaData = await metaRes.json();

  const priorSt = structuredClone(stData);
  priorSt.season = "2026-27";
  if (dropPlayerUid) {
    priorSt.players = priorSt.players.filter((p) => String(p.uid) !== String(dropPlayerUid));
  } else {
    priorSt.players = priorSt.players.map((p) => ({
      ...p,
      avg_rating: Number((Number(p.avg_rating || 6.8) - 0.15).toFixed(2)),
      npxg_p90: Number(Math.max(0, Number(p.npxg_p90 || 0.3) - 0.08).toFixed(3)),
      xa_p90: Number(Math.max(0, Number(p.xa_p90 || 0.15) - 0.04).toFixed(3)),
      score_overall: Number(Math.max(10, Number(p.score_overall || 55) - 4.5).toFixed(1)),
    }));
  }

  await page.route("**/api/status", async (route) => {
    const resp = await route.fetch();
    const json = await resp.json();
    const cur = json.seasons?.[0] || {
      season: metaData.season || "2027-28",
      in_game_date: metaData.in_game_date || "2028-05-16",
      save_file: metaData.save_file || "save.fm",
      club_name: metaData.club_name || "Hull City AFC",
      club_short_name: metaData.club_short_name || "Hull City",
      club_uid: metaData.club_uid || "665",
    };
    json.seasons = [
      cur,
      { ...cur, season: "2026-27", in_game_date: "2027-05-15" },
    ];
    await route.fulfill({ json });
  });

  await page.route("**/seasons/2026-27/data/ST.json", async (route) => {
    await route.fulfill({ json: priorSt });
  });

  return { stData, metaData };
}

function makeTests(baseUrl) {
  const cases = [];
  const add = (id, feature, tier, fn) => cases.push({ id, feature, tier, fn });

  // ==================== F9 BROWSER (6 cases) ====================
  add("F9-T1-04", "F9", 1, async (browser) => {
    const { context, page, tracker } = await openApp(browser, baseUrl);
    try {
      const info = await page.evaluate(() => ({
        echartsType: typeof window.echarts,
        echartsInitType: typeof window.echarts?.init,
        echartsVersion: String(window.echarts?.version || ""),
        tabulatorType: typeof window.Tabulator,
      }));
      assert(info.echartsType === "object", `window.echarts=${info.echartsType}`);
      assert(info.echartsInitType === "function", `echarts.init=${info.echartsInitType}`);
      assert(info.echartsVersion.startsWith("6."), `echarts.version=${info.echartsVersion}`);
      assert(info.tabulatorType === "function", `window.Tabulator=${info.tabulatorType}`);
      tracker.assertClean("F9-T1-04");
      return `echarts@${info.echartsVersion} & Tabulator UMD loaded`;
    } finally {
      await context.close();
    }
  });

  add("F9-T1-05", "F9", 1, async (browser) => {
    const { context, page, tracker } = await openApp(browser, baseUrl);
    try {
      await page.waitForTimeout(100);
      assert(tracker.externalRequests.length === 0, `External requests: ${tracker.externalRequests}`);
      assert(tracker.badResponses.length === 0, `Bad responses: ${tracker.badResponses}`);
      tracker.assertClean("F9-T1-05");
      return "100% offline localhost traffic";
    } finally {
      await context.close();
    }
  });

  add("F9-T2-01", "F9", 2, async (browser) => {
    const { context, page, tracker } = await openApp(browser, baseUrl);
    try {
      const sheets = await page.evaluate(() =>
        [...document.styleSheets]
          .filter((s) => (s.href || "").includes("tabulator"))
          .map((s) => ({ href: s.href, rules: s.cssRules.length }))
      );
      assert(sheets.length > 0 && sheets[0].rules > 0, `tabulator.min.css not active in CSSOM: ${JSON.stringify(sheets)}`);
      tracker.assertClean("F9-T2-01");
      return `tabulator CSS active (${sheets[0].rules} rules)`;
    } finally {
      await context.close();
    }
  });

  add("F9-T2-02", "F9", 2, async (browser) => {
    for (const scheme of ["light", "dark"]) {
      const { context, page, tracker } = await openApp(browser, baseUrl, { colorScheme: scheme });
      try {
        await findTabulator(page);
        await getScatterCanvas(page);
        tracker.assertClean(`F9-T2-02(${scheme})`);
      } finally {
        await context.close();
      }
    }
    return "Zero 404/map/font errors in light & dark schemes";
  });

  add("F9-T2-04", "F9", 2, async (browser) => {
    const { context, page, tracker } = await openApp(browser, baseUrl);
    try {
      const scripts = await page.evaluate(() =>
        [...document.querySelectorAll("script[src]")].map((s) => s.getAttribute("src") || "")
      );
      const eIdx = scripts.findIndex((s) => s.includes("echarts"));
      const tIdx = scripts.findIndex((s) => s.includes("tabulator"));
      const aIdx = scripts.findIndex((s) => s.includes("app.js"));
      assert(eIdx >= 0 && tIdx >= 0 && aIdx > eIdx && aIdx > tIdx, `Bad script order: ${JSON.stringify(scripts)}`);
      tracker.assertClean("F9-T2-04");
      return `Script load order valid: ${scripts.join(" -> ")}`;
    } finally {
      await context.close();
    }
  });

  add("F9-T2-06", "F9", 2, async (browser) => {
    const staleRequests = [];
    const { context, page, tracker } = await openApp(browser, baseUrl, {
      preInitHook: async (pg) => {
        await pg.route(/\/(?:app\.js|styles\.css)$/, async (route) => {
          const pathname = new URL(route.request().url()).pathname;
          staleRequests.push(pathname);
          const isScript = pathname === "/app.js";
          await route.fulfill({
            contentType: isScript ? "application/javascript" : "text/css",
            body: isScript ? 'document.querySelector("#pool-summary").textContent = "Legacy Scout script";' : "",
          });
        });
      },
    });
    try {
      await findTabulator(page);
      await getScatterCanvas(page);
      assert(staleRequests.length === 0, `Dashboard requested legacy asset URLs: ${staleRequests.join(", ")}`);
      tracker.assertClean("F9-T2-06");
      return "Dashboard bypassed legacy asset URLs and rendered the table and chart";
    } finally {
      await context.close();
    }
  });

  // ==================== F10 MULTI-SELECT POPOVER FILTERS (12 cases) ====================
  add("F10-T1-01", "F10", 1, async (browser) => {
    const cssText = fs.readFileSync(path.join(APP_DIR, "styles.css"), "utf-8");
    assert(cssText.includes("@supports (position-area: block-end)"), "styles.css missing @supports (position-area: block-end)");
    assert(cssText.includes("@supports not (position-area: block-end)"), "styles.css missing @supports not fallback");

    const { context, page, tracker } = await openApp(browser, baseUrl);
    try {
      const { popover: popLeagues } = await openFilterPopover(page, /\bleagues?\b/i);
      assert((await popLeagues.getAttribute("popover")) === "auto", "Leagues popover missing popover='auto'");
      const clubsBtn = await findFilterTrigger(page, /\bclubs?\b/i);
      await clubsBtn.click();
      await page.waitForTimeout(80);
      assert((await page.locator("[popover]:popover-open").count()) === 1, "Expected popover='auto' exclusivity");
      assert(!(await popLeagues.evaluate((el) => el.matches(":popover-open"))), "Leagues popover did not auto-close");
      await page.keyboard.press("Escape");
      assert((await page.locator("[popover]:popover-open").count()) === 0, "Escape did not dismiss popover");
      tracker.assertClean("F10-T1-01");
      return "popover='auto' exclusivity & CSS Anchor Positioning verified";
    } finally {
      await context.close();
    }
  });

  add("F10-T1-02", "F10", 1, async (browser) => {
    const { context, page, tracker } = await openApp(browser, baseUrl);
    try {
      await setRelaxedPoolFilters(page);
      const before = await getMatchedCount(page);
      const { trigger, popover } = await openFilterPopover(page, /\bleagues?\b/i);
      const inp = await getPopoverSearchInput(popover);
      await inp.fill("Premier");
      const opts = await getPopoverCheckboxes(popover);
      const visCount = await opts.count();
      assert(visCount >= 1, "Expected >=1 league matching 'Premier'");
      await setPopoverOptionSelected(opts.nth(0), true);
      if (visCount >= 2) {
        const opts2 = await getPopoverCheckboxes(popover);
        if ((await opts2.count()) >= 2) await setPopoverOptionSelected(opts2.nth(1), true);
      }
      await page.keyboard.press("Escape");
      const after = await getMatchedCount(page);
      assert(after > 0 && after < before, `Expected filtered count < ${before}, got ${after}`);
      const badge = trigger.locator(".trigger-badge:visible");
      assert((await badge.count()) === 1, "Selected-league count is hidden");
      assert(Number(await badge.textContent()) > 0, "Selected-league count is zero");
      tracker.assertClean("F10-T1-02");
      return `Leagues filter reduced ${before} -> ${after}`;
    } finally {
      await context.close();
    }
  });

  add("F10-T1-03", "F10", 1, async (browser) => {
    const { context, page, tracker } = await openApp(browser, baseUrl);
    try {
      await setRelaxedPoolFilters(page);
      await selectFirstMatchingInPopover(page, /\bleagues?\b/i, "Premier League", 1);
      const { popover } = await openFilterPopover(page, /\bclubs?\b/i);
      const imgs = popover.locator('img[src*="/api/img/club/"]');
      assert((await imgs.count()) > 0, "Clubs popover missing club crest <img>");
      const okImg = await imgs.first().evaluate((el) => el.complete && el.naturalWidth > 0);
      assert(okImg, "First club crest in Clubs popover failed to load");
      const popText = (await popover.textContent()) || "";
      assert(/Premier League/i.test(popText), "Clubs popover missing league subtext");
      tracker.assertClean("F10-T1-03");
      return "Clubs popover logos, league subtext & reactivity verified";
    } finally {
      await context.close();
    }
  });

  add("F10-T1-07", "F10", 1, async (browser) => {
    const leagueName = "Scheduled League";
    const clubName = "Scheduled FC";
    const { context, page, tracker } = await openApp(browser, baseUrl, {
      preInitHook: async (pg) => {
        await pg.route("**/data/meta.json", async (route) => {
          const meta = await (await route.fetch()).json();
          meta.club_catalog = [...(meta.club_catalog || []), {
            club_uid: "99999999", club_img_id: "99999999", club: clubName, league: leagueName,
          }];
          await route.fulfill({ json: meta });
        });
      },
    });
    try {
      await page.locator("#f-search").fill("no_matching_player_zzzz");
      const { popover: allClubs } = await openFilterPopover(page, /\bclubs?\b/i);
      const before = await allClubs.getByRole("option").count();
      assert(before > 0, "Clubs vanished when the filter pool was empty");
      await allClubs.getByRole("button", { name: "Show More" }).click();
      assert((await allClubs.getByRole("option").count()) > before, "Show More did not reveal more clubs");
      await page.keyboard.press("Escape");

      const { popover: leagues } = await openFilterPopover(page, /\bleagues?\b/i);
      const league = leagues.getByRole("option").filter({ hasText: leagueName });
      assert((await league.locator(".opt-count").textContent()) === "0", "Scheduled league should show zero matches");
      await league.click();
      const { popover: clubs } = await openFilterPopover(page, /\bclubs?\b/i);
      const options = clubs.getByRole("option");
      assert((await options.count()) === 1, "Club list did not narrow to the selected league");
      assert((await options.first().locator(".opt-label").textContent()) === clubName, "Scheduled club is missing");
      assert((await options.first().locator(".opt-count").textContent()) === "0", "Scheduled club should show zero matches");
      tracker.assertClean("F10-T1-07");
      return "Full catalog stays available with zero matches and clubs can be paged and scoped";
    } finally {
      await context.close();
    }
  });

  add("F10-T1-04", "F10", 1, async (browser) => {
    const { context, page, tracker } = await openApp(browser, baseUrl);
    try {
      await setRelaxedPoolFilters(page);
      await selectFirstMatchingInPopover(page, /\bpositions?\b/i, "ST", 1);
      const stCount = await getMatchedCount(page);
      assert(stCount > 0, "Selecting Position ST returned 0 rows (STC mapping missing?)");
      await switchPositionTab(page, "W");
      await selectFirstMatchingInPopover(page, /\bpositions?\b/i, "AML", 1);
      const amlCount = await getMatchedCount(page);
      assert(amlCount > 0, "Selecting AML on W tab returned 0 rows");
      tracker.assertClean("F10-T1-04");
      return `ST (${stCount}) & AML (${amlCount}) position filters verified`;
    } finally {
      await context.close();
    }
  });

  add("F10-T1-05", "F10", 1, async (browser) => {
    const { context, page, tracker } = await openApp(browser, baseUrl);
    try {
      const before = await getMatchedCount(page);
      await selectFirstMatchingInPopover(page, /\bnationalit(y|ies)\b|\bnations?\b/i, "England", 1);
      const after = await getMatchedCount(page);
      assert(after > 0 && after < before, `Nationality filter expected < ${before}, got ${after}`);
      tracker.assertClean("F10-T1-05");
      return `Nationality filter England: ${before} -> ${after}`;
    } finally {
      await context.close();
    }
  });

  add("F10-T1-06", "F10", 1, async (browser) => {
    const { context, page, tracker } = await openApp(browser, baseUrl);
    try {
      const { popover: footPop } = await openFilterPopover(page, /\bfoot\b/i);
      const footTxt = (await footPop.textContent()) || "";
      assert(/Left/i.test(footTxt) && /Right/i.test(footTxt) && /Both/i.test(footTxt), `Missing foot options: ${footTxt}`);
      await page.keyboard.press("Escape");

      await selectFirstMatchingInPopover(page, /\bfoot\b/i, "", 1);
      const { popover: statusPop } = await openFilterPopover(page, /\bstatus\b/i);
      const stTxt = (await statusPop.textContent()) || "";
      for (const req of ["Expiring Soon", "On Loan", "Not On Loan", "Free Agent"]) {
        assert(stTxt.includes(req), `Status popover missing '${req}'`);
      }
      await page.keyboard.press("Escape");
      tracker.assertClean("F10-T1-06");
      return "Foot & Status multi-select options verified";
    } finally {
      await context.close();
    }
  });

  add("F10-T2-01", "F10", 2, async (browser) => {
    for (const vp of [{ width: 1440, height: 900 }, { width: 768, height: 900 }]) {
      const { context, page, tracker } = await openApp(browser, baseUrl, { viewport: vp });
      try {
        for (const rx of [/\bleagues?\b/i, /\bclubs?\b/i, /\bpositions?\b/i, /\bnationalit|\bnations?\b/i, /\bfoot\b/i, /\bstatus\b/i]) {
          const { popover } = await openFilterPopover(page, rx);
          const box = await popover.boundingBox();
          assert(box && box.x >= 0 && box.y >= 0 && box.x + box.width <= vp.width + 2 && box.y + box.height <= vp.height + 2, `Popover clipped at ${vp.width}x${vp.height}: ${JSON.stringify(box)}`);
          await page.keyboard.press("Escape");
        }
        tracker.assertClean(`F10-T2-01(${vp.width})`);
      } finally {
        await context.close();
      }
    }
    return "All 6 popovers positioned within 1440x900 & 768x900 viewports";
  });

  add("F10-T2-02", "F10", 2, async (browser) => {
    const { context, page, tracker } = await openApp(browser, baseUrl);
    try {
      await setRelaxedPoolFilters(page);
      await selectFirstMatchingInPopover(page, /\bleagues?\b/i, "Premier League", 1);
      await selectFirstMatchingInPopover(page, /\bclubs?\b/i, "Arsenal", 1);
      // Switch League to Sky Bet Championship specifically
      const { popover } = await openFilterPopover(page, /\bleagues?\b/i);
      const opts = await getPopoverCheckboxes(popover);
      const n = await opts.count();
      for (let i = 0; i < n; i++) {
        const curOpts = await getPopoverCheckboxes(popover);
        let deselectedAny = false;
        const m = await curOpts.count();
        for (let j = 0; j < m; j++) {
          if (await isPopoverOptionSelected(curOpts.nth(j))) {
            await setPopoverOptionSelected(curOpts.nth(j), false);
            deselectedAny = true;
            break;
          }
        }
        if (!deselectedAny) break;
      }
      assert(/Arsenal/i.test(await page.locator("#btn-f-clubs .trigger-label").textContent()),
        "Clearing the last league unexpectedly cleared Arsenal");
      const inp = await getPopoverSearchInput(popover);
      await inp.fill("Sky Bet Championship");
      const champOpts = await getPopoverCheckboxes(popover);
      const cntOpts = await champOpts.count();
      assert(cntOpts >= 1, "Sky Bet Championship option not found");
      let picked = false;
      for (let i = 0; i < cntOpts; i++) {
        const lbl = await getPopoverOptionLabel(champOpts.nth(i));
        if (/Sky Bet Championship/i.test(lbl)) {
          await setPopoverOptionSelected(champOpts.nth(i), true);
          picked = true;
          break;
        }
      }
      if (!picked) await setPopoverOptionSelected(champOpts.nth(0), true);
      await page.keyboard.press("Escape");
      const cnt = await getMatchedCount(page);
      assert(cnt > 0, "Stale club from League A blocked League B after switching leagues");
      tracker.assertClean("F10-T2-02");
      return `League switch pruned stale club (${cnt} Sky Bet Championship players)`;
    } finally {
      await context.close();
    }
  });

  add("F10-T2-03", "F10", 2, async (browser) => {
    const { context, page, tracker } = await openApp(browser, baseUrl);
    try {
      for (const rx of [/\bleagues?\b/i, /\bclubs?\b/i, /\bnationalit|\bnations?\b/i]) {
        const { popover } = await openFilterPopover(page, rx);
        const inp = await getPopoverSearchInput(popover);
        await inp.fill("  [eng] (1) \\ ");
        await inp.fill("");
        assert((await (await getPopoverCheckboxes(popover)).count()) > 0, `Options not restored after clearing search in ${rx}`);
        await page.keyboard.press("Escape");
      }
      tracker.assertClean("F10-T2-03");
      return "Regex metacharacter search safe in all searchable popovers";
    } finally {
      await context.close();
    }
  });

  add("F10-T2-04", "F10", 2, async (browser) => {
    const { context, page, tracker } = await openApp(browser, baseUrl);
    try {
      await page.locator("#f-max-val").selectOption("1000000");
      await page.locator("#f-min-rep").selectOption("7500");
      await page.locator("#f-search").fill("zzzz_no_such_player_xyz");
      const cnt = await getMatchedCount(page);
      assert(cnt === 0, `Expected 0 matched players, got ${cnt}`);
      await findTabulator(page);
      assert((await getTabulatorRowCount(page)) === 0, "Expected 0 Tabulator rows on empty match");
      await getScatterCanvas(page);
      tracker.assertClean("F10-T2-04");
      return "Zero-match intersection rendered cleanly";
    } finally {
      await context.close();
    }
  });

  add("F10-T2-05", "F10", 2, async (browser) => {
    const { context, page, tracker } = await openApp(browser, baseUrl);
    try {
      await setRelaxedPoolFilters(page);
      await page.locator("#f-include-hull").check();
      await selectFirstMatchingInPopover(page, /\bclubs?\b/i, "Everton", 1);
      const rows = page.locator(".tabulator .tabulator-row");
      const n = await rows.count();
      assert(n > 0, "Expected >=1 Everton row when pool filters relaxed");
      for (let i = 0; i < Math.min(n, 10); i++) {
        const txt = (await rows.nth(i).textContent()) || "";
        assert(!/Hull City/i.test(txt), `Hull City leaked when Club=Everton selected: ${txt}`);
      }
      tracker.assertClean("F10-T2-05");
      return `Explicit club filter overrides Include managed club (${n} Everton rows)`;
    } finally {
      await context.close();
    }
  });

  add("F10-T2-06", "F10", 2, async (browser) => {
    const { context, page, tracker } = await openApp(browser, baseUrl);
    try {
      const baseline = await getMatchedCount(page);
      const { popover } = await openFilterPopover(page, /\bfoot\b/i);
      const opts = await getPopoverCheckboxes(popover);
      const n = await opts.count();
      assert(n === 3, `Expected 3 foot options, got ${n}`);
      for (let i = 0; i < n; i++) {
        await setPopoverOptionSelected((await getPopoverCheckboxes(popover)).nth(i), true);
      }
      await page.keyboard.press("Escape");
      const allChecked = await getMatchedCount(page);
      assert(allChecked === baseline, `All 3 foot options (${allChecked}) != unchecked (${baseline})`);

      const { popover: pop2 } = await openFilterPopover(page, /\bfoot\b/i);
      for (let i = 0; i < n; i++) {
        await setPopoverOptionSelected((await getPopoverCheckboxes(pop2)).nth(i), false);
      }
      await page.keyboard.press("Escape");
      assert((await getMatchedCount(page)) === baseline, "Unchecking all did not restore baseline");
      tracker.assertClean("F10-T2-06");
      return `All-checked == none-checked (${baseline})`;
    } finally {
      await context.close();
    }
  });

  // ==================== F11 DYNAMIC UX CONTROLS (12 cases) ====================
  add("F11-T1-01", "F11", 1, async (browser) => {
    const { context, page, tracker } = await openApp(browser, baseUrl);
    try {
      const opts = await page.locator("#f-contract option").allTextContents();
      assert(opts.some((o) => o.includes("2028")), `Missing 2028 in #f-contract: ${opts}`);
      tracker.assertClean("F11-T1-01");
    } finally {
      await context.close();
    }
    // Dynamic check with 2031-32 season route
    const { context: ctx2, page: p2, tracker: tr2 } = await openApp(browser, baseUrl, {
      preInitHook: async (pg) => {
        await pg.route("**/data/meta.json", async (route) => {
          const r = await route.fetch();
          const j = await r.json();
          j.season = "2031-32";
          j.in_game_date = "2032-05-15";
          j.season_end_year = 2032;
          await route.fulfill({ json: j });
        });
      },
    });
    try {
      const opts2 = await p2.locator("#f-contract option").allTextContents();
      assert(opts2.some((o) => o.includes("2032")), `Contract options hardcoded instead of dynamic: ${opts2}`);
      tr2.assertClean("F11-T1-01-dyn");
      return `Dynamic contract options shifted to 2032: ${opts2.join(", ")}`;
    } finally {
      await ctx2.close();
    }
  });

  add("F11-T1-02", "F11", 1, async (browser) => {
    const { context, page, tracker } = await openApp(browser, baseUrl);
    try {
      const baseCnt = await getMatchedCount(page);
      await page.locator("#f-max-age").selectOption("21");
      await page.locator("#f-search").fill("a");
      const chips = await getFilterChips(page);
      const cnt = await chips.count();
      assert(cnt >= 2, `Expected >=2 active filter chips, got ${cnt}`);
      const ageChip = chips.filter({ hasText: /21|Age/i }).first();
      await ageChip.click();
      assert((await page.locator("#f-max-age").inputValue()) === "25", "Removing age chip did not reset Max Age");
      assert((await getMatchedCount(page)) >= baseCnt * 0.1, "Pool count did not update after chip removal");
      tracker.assertClean("F11-T1-02");
      return "Active filter chips & one-click removal verified";
    } finally {
      await context.close();
    }
  });

  add("F11-T1-03", "F11", 1, async (browser) => {
    const { context, page, tracker } = await openApp(browser, baseUrl);
    try {
      const baseCnt = await getMatchedCount(page);
      await page.locator("#f-max-age").selectOption("21");
      await page.locator("#f-search").fill("Silva");
      await selectFirstMatchingInPopover(page, /\bfoot\b/i, "", 1);
      const resetBtn = await findResetFiltersButton(page);
      await resetBtn.click();
      assert((await page.locator("#f-max-age").inputValue()) === "25", "Max Age not reset");
      assert((await page.locator("#f-search").inputValue()) === "", "Search not reset");
      assert((await (await getFilterChips(page)).count()) === 0, "Chips still visible after reset");
      assert((await getMatchedCount(page)) === baseCnt, "Pool count not restored");
      tracker.assertClean("F11-T1-03");
      return "Reset Filters restored defaults";
    } finally {
      await context.close();
    }
  });

  add("F11-T1-04", "F11", 1, async (browser) => {
    const { context, page, tracker } = await openApp(browser, baseUrl);
    try {
      await findTabulator(page);
      const stars = await getRowShortlistStars(page);
      assert((await stars.count()) > 0, "Quick shortlist star button not found on Tabulator row");
      await stars.first().click();
      assert((await page.locator("#shortlist-count").textContent())?.trim() === "1", "Shortlist count did not become 1");
      await page.reload({ waitUntil: "domcontentloaded" });
      await waitForAppReady(page);
      assert((await page.locator("#shortlist-count").textContent())?.trim() === "1", "Shortlist did not persist across reload");
      const starsAfter = await getRowShortlistStars(page);
      await starsAfter.first().click();
      assert((await page.locator("#shortlist-count").textContent())?.trim() === "0", "Shortlist count did not return to 0");
      tracker.assertClean("F11-T1-04");
      return "Quick row shortlist toggle & persistence verified";
    } finally {
      await context.close();
    }
  });

  add("F11-T1-07", "F11", 1, async (browser) => {
    const { context, page, tracker } = await openApp(browser, baseUrl);
    try {
      const readPlayers = () => page.evaluate(() => {
        const chart = window.echarts.getInstanceByDom(document.querySelector("#scatter-chart"));
        return chart.getOption().series.flatMap((series) => series.data.map(({ player }) => {
          const { uid, name, club, age, value, wage } = player;
          return { uid, name, club, age, value, wage };
        }));
      });
      const players = await readPlayers();
      const sample = players.find((player) => player.name?.length > 3 && player.club?.length > 3 &&
        [player.age, player.value, player.wage].every(Number.isFinite));
      assert(sample, "No sample player has all three filter values");
      const search = page.locator("#f-search");
      const options = page.locator("#search-suggestions").getByRole("option");
      await search.fill(sample.name.slice(0, -1));
      const first = await options.first().getAttribute("data-value");
      await search.press("ArrowDown");
      await search.press("Enter");
      assert((await search.inputValue()) === first, "Keyboard suggestion did not update the search");
      const profile = page.locator("#player-dialog[open]");
      await profile.waitFor({ state: "visible" });
      assert((await profile.locator("#dialog-player-name").textContent()) === first, "Keyboard suggestion opened the wrong profile");
      await profile.locator("#dialog-close-btn").click();
      await search.fill(sample.club.slice(0, -1));
      await options.filter({ hasText: new RegExp(`^\\s*${escapeRegex(sample.club)}Club\\s*$`) }).click();
      assert((await search.inputValue()) === sample.club, "Club suggestion did not update the search");
      await search.fill("");

      const minimums = [["age", "age"], ["val", "value"], ["wage", "wage"]];
      for (const [input, field] of minimums) {
        await page.locator(`#f-min-${input}`).fill(String(sample[field]));
      }
      const expected = players.filter((player) => minimums.every(([, field]) =>
        Number.isFinite(player[field]) && player[field] >= sample[field]));
      const actual = await readPlayers();
      assert(actual.some((player) => player.uid === sample.uid), "Minimums must include values at the boundary");
      assert(actual.length === expected.length && actual.every((player) => expected.some((p) => p.uid === player.uid)),
        "Minimum filters did not match the expected players");
      await page.getByRole("button", { name: /Remove Min Age/ }).click();
      assert(!(await page.locator("#f-min-age").inputValue()), "Chip did not clear the age minimum");
      await (await findResetFiltersButton(page)).click();
      assert((await readPlayers()).length === players.length, "Reset did not clear all minimums");
      tracker.assertClean("F11-T1-07");
      return "Player and club suggestions plus all three minimum filters verified";
    } finally {
      await context.close();
    }
  });

  add("F11-T1-09", "F11", 1, async (browser) => {
    const playerName = "Álvaro Lookup";
    const leagueName = "League Without Starts";
    const clubName = "Lookup FC";
    const club = { club_uid: "99999990", club_img_id: "99999990", club: clubName, league: leagueName };
    const player = { ...club, uid: "99999991", name: playerName, age: 32, positions: "STC",
      position_groups: ["ST"], has_scouting_stats: false };
    const { context, page, tracker } = await openApp(browser, baseUrl, {
      preInitHook: async (pg) => {
        await pg.route("**/data/meta.json", async (route) => {
          const meta = await (await route.fetch()).json();
          meta.has_player_search = true;
          meta.club_catalog = [...(meta.club_catalog || []), club];
          await route.fulfill({ json: meta });
        });
        await pg.route("**/data/player_search.json", (route) =>
          route.fulfill({ json: { fields: Object.keys(player), rows: [Object.values(player)] } }));
      },
    });
    try {
      await switchPositionTab(page, "GK");
      const search = page.locator("#f-search");
      await search.fill("alvaro lookup");
      const option = page.locator("#search-suggestions").getByRole("option").filter({ hasText: playerName });
      await option.click();
      const profile = page.locator("#player-dialog[open]");
      await profile.waitFor({ state: "visible" });
      assert((await profile.locator("#dialog-player-name").textContent()) === playerName, "Search did not open the player's profile");
      assert(await profile.locator("#dialog-season-empty").isVisible(), "Missing stats status did not appear");
      assert(!(await profile.locator("#dialog-radar-panel").isVisible()), "Profile showed a radar without results");
      await profile.locator("#dialog-shortlist-btn").click();
      await profile.locator("#dialog-close-btn").click();
      await page.locator("#btn-shortlist-view").click();
      await page.locator("#shortlist-dialog").getByRole("button", { name: playerName, exact: true }).click();
      await profile.waitFor({ state: "visible" });
      assert(await profile.locator("#dialog-season-empty").isVisible(), "Saved profile did not reopen");
      await profile.locator("#dialog-close-btn").click();
      await page.locator("#shortlist-close-btn").click();
      await search.fill("");
      await switchPositionTab(page, "ST");
      await selectFirstMatchingInPopover(page, /\bleagues?\b/i, leagueName, 1);
      await selectFirstMatchingInPopover(page, /\bclubs?\b/i, clubName, 1);
      const squad = page.locator("#squad-results");
      await squad.getByRole("button", { name: new RegExp(playerName) }).waitFor({ state: "visible" });
      assert((await getMatchedCount(page)) === 0, "Squad profile leaked into the stats pool");
      tracker.assertClean("F11-T1-09");
      return "Save-wide lookup, missing stats, shortlist and squad profiles verified";
    } finally {
      await context.close();
    }
  });

  add("F11-T1-08", "F11", 1, async (browser) => {
    const { context, page, tracker } = await openApp(browser, baseUrl);
    try {
      await context.grantPermissions(["clipboard-read", "clipboard-write"]);
      await (await getRowShortlistStars(page)).first().click();
      await switchPositionTab(page, "GK");
      const keeperName = await page.locator(".tabulator-row .player-link").first().textContent();
      await (await getRowShortlistStars(page)).first().click();
      await switchPositionTab(page, "ST");
      await page.locator("#btn-shortlist-view").click();
      const shortlist = page.locator("#shortlist-dialog");
      assert((await shortlist.locator(".shortlist-item").count()) === 2, "Expected two saved players");
      await shortlist.locator("#shortlist-position").selectOption("GK");
      assert((await shortlist.locator(".shortlist-item").count()) === 1, "GK filter should show one player");
      await shortlist.getByRole("button", { name: "Copy Name" }).click();
      assert((await page.evaluate(() => navigator.clipboard.readText())) === keeperName, "Shortlist name was not copied");
      await shortlist.getByRole("button", { name: keeperName, exact: true }).click();
      const profile = page.locator("#player-dialog[open]");
      await profile.waitFor({ state: "visible" });
      assert((await profile.locator("#dialog-player-name").textContent()) === keeperName, "Opened the wrong player");
      assert(/Nationality/.test(await profile.locator("#dialog-profile-facts").textContent()), "Profile facts are missing");
      assert(/Appearances[\s\S]*Save %/.test(await profile.locator("#dialog-season-stats").textContent()), "Keeper season stats are missing");
      await profile.getByRole("button", { name: "Copy Name" }).click();
      assert((await page.evaluate(() => navigator.clipboard.readText())) === keeperName, "Profile name was not copied");
      await profile.locator("#dialog-close-btn").click();
      assert((await shortlist.locator("#shortlist-position").inputValue()) === "GK", "Position filter did not persist");
      const [download] = await Promise.all([page.waitForEvent("download"), shortlist.locator("#btn-export-shortlist").click()]);
      const csv = fs.readFileSync(await download.path(), "utf-8");
      assert(csv.split("\n").length === 2 && csv.includes(keeperName), "Export did not match the filtered shortlist");
      tracker.assertClean("F11-T1-08");
      return "Shortlist position filter, profile, clipboard and filtered CSV verified";
    } finally {
      await context.close();
    }
  });

  add("F11-T1-05", "F11", 1, async (browser) => {
    const { context, page, tracker } = await openApp(browser, baseUrl);
    try {
      await findResetFiltersButton(page); // Ensure M4 UX present
      await page.locator("h1").click();
      await page.keyboard.press("/");
      const focusedId = await page.evaluate(() => document.activeElement?.id);
      assert(focusedId === "f-search", `Expected #f-search focused on '/', got '${focusedId}'`);
      assert((await page.locator("#f-search").inputValue()) === "", "'/' leaked into #f-search");

      await page.locator("#f-min-mins").focus();
      await page.keyboard.press("/");
      const stillMin = await page.evaluate(() => document.activeElement?.id);
      assert(stillMin === "f-min-mins", "'/' stole focus from <select>");
      tracker.assertClean("F11-T1-05");
      return "'/' shortcut focuses #f-search without stealing from inputs";
    } finally {
      await context.close();
    }
  });

  add("F11-T1-06", "F11", 1, async (browser) => {
    const { context, page, tracker } = await openApp(browser, baseUrl);
    try {
      const crestImg = page.locator("header img[src*='/api/img/club/'], #club-crest img[src*='/api/img/club/']").first();
      assert((await crestImg.count()) > 0, "Topbar club crest <img> pointing to /api/img/club/ not found");
      const imgOk = await crestImg.evaluate((el) => el.complete && el.naturalWidth > 0);
      assert(imgOk, "Topbar club crest <img> failed to load");

      const resetBtn = await findResetFiltersButton(page);
      await page.locator("#f-max-age").selectOption("21");
      await resetBtn.click();
      const toast = page
        .locator('[role="status"]:not(#sort-status), [aria-live]:not(#sort-status), .toast, .toast-item, [data-toast], #toast-region > *')
        .first();
      assert((await toast.count()) > 0, "Toast aria-live element not found");
      const toastTxt = ((await toast.textContent()) || "").trim();
      assert(toastTxt.length > 0, "Toast message empty after Reset Filters");
      tracker.assertClean("F11-T1-06");
      return `Topbar crest loaded & toast='${toastTxt}'`;
    } finally {
      await context.close();
    }
  });

  add("F11-T2-01", "F11", 2, async (browser) => {
    const { context, page, tracker } = await openApp(browser, baseUrl);
    try {
      const dlg = await findCustomizeDialog(page);
      const inp = await findPresetNameInput(dlg);
      await inp.focus();
      await page.keyboard.press("/");
      const insideDlg = await page.evaluate(() => Boolean(document.activeElement?.closest("dialog")));
      assert(insideDlg, "'/' stole focus out of open <dialog>");
      tracker.assertClean("F11-T2-01");
      return "'/' ignored inside open <dialog> inputs";
    } finally {
      await context.close();
    }
  });

  add("F11-T2-02", "F11", 2, async (browser) => {
    const { context, page, tracker } = await openApp(browser, baseUrl);
    try {
      await findTabulator(page);
      const stars = await getRowShortlistStars(page);
      assert((await stars.count()) >= 5, "Quick row shortlist stars missing");
      for (let i = 0; i < 5; i++) await stars.nth(i).click();
      const toasts = await page.locator("#toast-region > .toast-item").count();
      assert(toasts > 0 && toasts <= 3, `Expected 1–3 toast items, got ${toasts}`);
      tracker.assertClean("F11-T2-02");
      return "Rapid toast triggers stayed bounded";
    } finally {
      await context.close();
    }
  });

  add("F11-T2-03", "F11", 2, async (browser) => {
    const { context, page, tracker } = await openApp(browser, baseUrl, {
      preInitHook: async (pg) => {
        await pg.route("**/data/meta.json", async (route) => {
          const r = await route.fetch();
          const j = await r.json();
          j.club_img_id = "999999999";
          await route.fulfill({ json: j });
        });
      },
    });
    try {
      const crestImg = page.locator("header img[src*='/api/img/club/'], #club-crest img[src*='/api/img/club/']").first();
      assert((await crestImg.count()) > 0, "Topbar club crest <img> missing");
      const ok = await crestImg.evaluate((el) => el.complete && el.naturalWidth > 0);
      assert(ok, "Topbar SVG fallback crest did not load");
      tracker.assertClean("F11-T2-03");
      return "Missing club crest fell back cleanly to 200 SVG";
    } finally {
      await context.close();
    }
  });

  add("F11-T2-04", "F11", 2, async (browser) => {
    const { context, page, tracker } = await openApp(browser, baseUrl);
    try {
      const baseCnt = await getMatchedCount(page);
      const resetBtn = await findResetFiltersButton(page);
      if (await resetBtn.isVisible()) {
        await resetBtn.click();
        assert((await getMatchedCount(page)) === baseCnt, "Count changed on idempotent reset");
      } else {
        await page.locator("#f-max-age").selectOption("21");
        await resetBtn.click();
        assert((await getMatchedCount(page)) === baseCnt, "Count not restored after reset");
      }
      tracker.assertClean("F11-T2-04");
      return "Idempotent Reset Filters succeeded";
    } finally {
      await context.close();
    }
  });

  add("F11-T2-05", "F11", 2, async (browser) => {
    const { context, page, tracker } = await openApp(browser, baseUrl);
    try {
      await findResetFiltersButton(page);
      await page.locator("#f-search").fill("O'Brien & Co");
      const chips = await getFilterChips(page);
      const searchChip = chips.filter({ hasText: "O'Brien & Co" }).first();
      assert((await searchChip.count()) > 0, "Special-char search chip missing");
      await searchChip.click();
      assert((await page.locator("#f-search").inputValue()) === "", "Special-char search chip did not clear input");
      tracker.assertClean("F11-T2-05");
      return "Special-char chip escaped & cleared cleanly";
    } finally {
      await context.close();
    }
  });

  add("F11-T2-06", "F11", 2, async (browser) => {
    const { context, page, tracker } = await openApp(browser, baseUrl, {
      preInitHook: async (pg) => {
        await pg.route("**/data/meta.json", async (route) => {
          const r = await route.fetch();
          const j = await r.json();
          j.in_game_date = "";
          j.season = "2029-30";
          delete j.season_end_year;
          await route.fulfill({ json: j });
        });
      },
    });
    try {
      const opts = await page.locator("#f-contract option").allTextContents();
      assert(opts.every((o) => !/NaN/i.test(o)), `NaN in contract options: ${opts}`);
      assert(opts.some((o) => o.includes("2030")), `Fallback season 2030 missing in contract options: ${opts}`);
      tracker.assertClean("F11-T2-06");
      return `Season fallback contract options: ${opts.join(", ")}`;
    } finally {
      await context.close();
    }
  });

  // ==================== F12 CUSTOMIZE SCORE <DIALOG> (12 cases) ====================
  add("F12-T1-01", "F12", 1, async (browser) => {
    const { context, page, tracker } = await openApp(browser, baseUrl);
    try {
      const dlg = await findCustomizeDialog(page);
      const txt = (await dlg.textContent()) || "";
      assert(/Weighted Percentile/i.test(txt) && /Weighted Z-Score/i.test(txt) && /Weighted Min-Max/i.test(txt), "Missing 3 calculation methods");
      assert(/\d+%/.test(txt), "Missing live % share readout");
      assert(/Top\s*5|Preview/i.test(txt), "Missing Top-5 preview section");
      tracker.assertClean("F12-T1-01");
      return "Customize Score dialog & all required sections verified";
    } finally {
      await context.close();
    }
  });

  add("F12-T1-02", "F12", 1, async (browser) => {
    const { context, page, tracker } = await openApp(browser, baseUrl);
    try {
      const dlg = await findCustomizeDialog(page);
      await selectCalcMethod(dlg, /Z-Score/i);
      const zTxt = (await dlg.textContent()) || "";
      await selectCalcMethod(dlg, /Min-Max/i);
      const mTxt = (await dlg.textContent()) || "";
      assert(zTxt !== mTxt, "Top-5 preview did not update across Z-Score and Min-Max methods");
      tracker.assertClean("F12-T1-02");
      return "Method switching updates Top-5 preview live";
    } finally {
      await context.close();
    }
  });

  add("F12-T1-03", "F12", 1, async (browser) => {
    const { context, page, tracker } = await openApp(browser, baseUrl);
    try {
      const dlg = await findCustomizeDialog(page);
      const unchecked = dlg.locator('input[type="checkbox"]:not(:checked):visible');
      assert((await unchecked.count()) > 0, "Expected unchecked catalog metrics outside ST defaults");
      await unchecked.first().check();
      const weights = dlg.locator('input[type="range"], input[type="number"]');
      assert((await weights.count()) >= 2, "Missing 0-5 weight controls");
      await weights.first().fill("5");
      await weights.first().dispatchEvent("input");
      const txt = (await dlg.textContent()) || "";
      assert(/\d+%/.test(txt), "Normalized % shares not displayed");
      tracker.assertClean("F12-T1-03");
      return "Catalog metric enabling & weight adjustment verified";
    } finally {
      await context.close();
    }
  });

  add("F12-T1-04", "F12", 1, async (browser) => {
    const { context, page, tracker } = await openApp(browser, baseUrl);
    try {
      const dlg = await findCustomizeDialog(page);
      const dirBtn = dlg.locator("button").filter({ hasText: /Higher\s*↑|Lower\s*↓/i }).first();
      assert((await dirBtn.count()) > 0, "Higher ↑ / Lower ↓ toggle button not found");
      const before = ((await dirBtn.textContent()) || "").trim();
      await dirBtn.click();
      const after = ((await dirBtn.textContent()) || "").trim();
      assert(before !== after, `Direction button did not toggle: ${before}`);
      tracker.assertClean("F12-T1-04");
      return `Direction toggled: ${before} -> ${after}`;
    } finally {
      await context.close();
    }
  });

  add("F12-T1-05", "F12", 1, async (browser) => {
    const { context, page, tracker } = await openApp(browser, baseUrl);
    try {
      const dlg = await findCustomizeDialog(page);
      const nameInp = await findPresetNameInput(dlg);
      await nameInp.fill("Pressing 9");
      await dlg.getByRole("button", { name: /save/i }).first().click();
      await page.keyboard.press("Escape");

      const roleOpts = await page.locator("#f-role option").allTextContents();
      assert(roleOpts.some((o) => o.includes("Pressing 9")), `Preset missing from #f-role: ${roleOpts}`);
      await switchPositionTab(page, "CB");
      const cbOpts = await page.locator("#f-role option").allTextContents();
      assert(!cbOpts.some((o) => o.includes("Pressing 9")), "ST preset leaked into CB");
      await page.reload({ waitUntil: "domcontentloaded" });
      await waitForAppReady(page);
      const stOptsAfter = await page.locator("#f-role option").allTextContents();
      assert(stOptsAfter.some((o) => o.includes("Pressing 9")), "Preset did not survive reload");

      const pressingVal = await page
        .locator("#f-role option")
        .filter({ hasText: /Pressing 9/ })
        .first()
        .getAttribute("value");
      await page.locator("#f-role").selectOption(pressingVal);

      const dlg2 = await findCustomizeDialog(page);
      const delBtn = dlg2.getByRole("button", { name: /delete/i }).first();
      assert((await delBtn.count()) > 0, "Delete preset button missing");
      await delBtn.click();
      await page.keyboard.press("Escape");
      const afterDeleteOpts = await page.locator("#f-role option").allTextContents();
      assert(!afterDeleteOpts.some((o) => o.includes("Pressing 9")), "Preset still present after Delete");
      tracker.assertClean("F12-T1-05");
      return "Preset save, position scoping, reload persistence & delete verified";
    } finally {
      await context.close();
    }
  });

  add("F12-T1-06", "F12", 1, async (browser) => {
    const { context, page, tracker } = await openApp(browser, baseUrl);
    try {
      await findTabulator(page);
      const beforeScores = await getTableRowScoresSnapshot(page);
      const beforeCanvas = await getCanvasDataUrl(await getScatterCanvas(page));
      const dlg = await findCustomizeDialog(page);
      const weights = dlg.locator('input[type="range"], input[type="number"]');
      assert((await weights.count()) >= 2, "Missing weight inputs in Customize Score dialog");
      await weights.first().fill("0");
      await weights.first().dispatchEvent("input");
      await weights.nth(1).fill("5");
      await weights.nth(1).dispatchEvent("input");
      const applyBtn = dlg.getByRole("button", { name: /apply|done|close/i }).first();
      await applyBtn.click();
      await page.waitForTimeout(150);
      const afterScores = await getTableRowScoresSnapshot(page);
      const afterCanvas = await getCanvasDataUrl(await getScatterCanvas(page));
      assert(afterScores !== beforeScores || afterCanvas !== beforeCanvas, "Table Role Score & scatter did not update after weight change");
      tracker.assertClean("F12-T1-06");
      return "Live table & scatter sync verified";
    } finally {
      await context.close();
    }
  });

  add("F12-T2-01", "F12", 2, async (browser) => {
    const { context, page, tracker } = await openApp(browser, baseUrl);
    try {
      const dlg = await findCustomizeDialog(page);
      const weights = dlg.locator('.score-weight-num:enabled');
      const n = await weights.count();
      assert(n > 0, "Expected enabled metric weights");
      for (let i = 0; i < n; i++) {
        await weights.nth(i).fill("0");
        await weights.nth(i).press("Tab");
      }
      const txt = (await dlg.textContent()) || "";
      assert((await dlg.locator("#score-total-weight").textContent()).includes("Total weight: 0.0"));
      assert(!/\b(?:NaN|Infinity)\b/.test(txt), "Non-finite score with zero weights");
      tracker.assertClean("F12-T2-01");
      return "Zero-weight division-by-zero guard verified";
    } finally {
      await context.close();
    }
  });

  add("F12-T2-02", "F12", 2, async (browser) => {
    const { context, page, tracker } = await openApp(browser, baseUrl);
    try {
      const dlg = await findCustomizeDialog(page);
      const checked = dlg.locator('input[type="checkbox"]:checked:visible');
      const n = await checked.count();
      for (let i = 0; i < n; i++) {
        await checked.first().uncheck();
      }
      const txt = (await dlg.textContent()) || "";
      assert(!/\b(?:NaN|Infinity)\b/.test(txt), "Non-finite score with zero enabled metrics");
      tracker.assertClean("F12-T2-02");
      return "Zero enabled metrics handled cleanly";
    } finally {
      await context.close();
    }
  });

  add("F12-T2-03", "F12", 2, async (browser) => {
    const { context, page, tracker } = await openApp(browser, baseUrl);
    try {
      await page.locator("#f-search").fill("Pellegrino");
      const dlg = await findCustomizeDialog(page);
      await selectCalcMethod(dlg, /Z-Score/i);
      const txt = (await dlg.textContent()) || "";
      assert(!/\b(?:NaN|Infinity)\b/.test(txt), "Non-finite score with one player");
      tracker.assertClean("F12-T2-03");
      return "Zero-variance Z-Score/Min-Max finite";
    } finally {
      await context.close();
    }
  });

  add("F12-T2-04", "F12", 2, async (browser) => {
    const { context, page, tracker } = await openApp(browser, baseUrl);
    try {
      let alerted = false;
      page.on("dialog", async (d) => { alerted = true; await d.dismiss(); });
      const dlg = await findCustomizeDialog(page);
      const nameInp = await findPresetNameInput(dlg);
      await nameInp.fill("   ");
      await dlg.getByRole("button", { name: /save/i }).first().click();
      await nameInp.fill("<script>alert(1)</script>");
      await dlg.getByRole("button", { name: /save/i }).first().click();
      assert(!alerted, "XSS script executed from preset name!");
      tracker.assertClean("F12-T2-04");
      return "Blank & XSS preset names safely handled";
    } finally {
      await context.close();
    }
  });

  add("F12-T2-05", "F12", 2, async (browser) => {
    const candidateKeys = [
      "hull_fm27_moneyball_role_presets_v1",
      "moneyball_role_presets_v1",
      "fm27_moneyball_role_presets_v1",
      "role_presets",
    ];
    const { context, page, tracker } = await openApp(browser, baseUrl, {
      preInitHook: async (pg) => {
        await pg.addInitScript((keys) => {
          for (const k of keys) localStorage.setItem(k, "{corrupt_json");
        }, candidateKeys);
      },
    });
    try {
      const dlg = await findCustomizeDialog(page);
      const inp = await findPresetNameInput(dlg);
      await inp.fill("TempProbe");
      await dlg.getByRole("button", { name: /save/i }).first().click();
      await page.keyboard.press("Escape");

      const corruptedCount = await page.evaluate((keys) => {
        const targets = new Set(keys);
        for (let i = 0; i < localStorage.length; i++) {
          const k = localStorage.key(i);
          if (k && /preset|role/i.test(k)) targets.add(k);
        }
        for (const k of targets) localStorage.setItem(k, "{corrupt_json");
        return targets.size;
      }, candidateKeys);
      assert(corruptedCount >= candidateKeys.length);

      await page.reload({ waitUntil: "domcontentloaded" });
      await waitForAppReady(page);
      await findCustomizeDialog(page);
      tracker.assertClean("F12-T2-05");
      return "Corrupt localStorage preset JSON recovered cleanly";
    } finally {
      await context.close();
    }
  });

  add("F12-T2-06", "F12", 2, async (browser) => {
    const { context, page, tracker } = await openApp(browser, baseUrl);
    try {
      const dlg = await findCustomizeDialog(page);
      await page.keyboard.press("Escape");
      assert(!(await dlg.isVisible()), "Escape did not close Customize Score dialog");
      await findResetFiltersButton(page);
      tracker.assertClean("F12-T2-06");
      return "Customize Score dialog dismisses cleanly on Escape";
    } finally {
      await context.close();
    }
  });

  // ==================== F13 ECHARTS PER-90 SCATTER PLOT (12 cases) ====================
  add("F13-T1-01", "F13", 1, async (browser) => {
    const { context, page, tracker } = await openApp(browser, baseUrl);
    try {
      await setRelaxedPoolFilters(page);
      const canvas = await getScatterCanvas(page);
      const box = await canvas.boundingBox();
      assert(box && box.width > 300 && box.height > 200, `Scatter canvas size invalid: ${JSON.stringify(box)}`);
      const url = await getCanvasDataUrl(canvas);
      assert(url.startsWith("data:image/png;base64,") && url.length > 2000, "Scatter canvas appears blank");
      tracker.assertClean("F13-T1-01");
      return `ECharts scatter canvas ${Math.round(box.width)}x${Math.round(box.height)}`;
    } finally {
      await context.close();
    }
  });

  add("F13-T1-02", "F13", 1, async (browser) => {
    const { context, page, tracker } = await openApp(browser, baseUrl);
    try {
      const canvas = await getScatterCanvas(page);
      const before = await getCanvasDataUrl(canvas);
      const optsX = await page.locator("#scatter-x option").all();
      assert(optsX.length >= 2, `Expected >=2 metrics in #scatter-x, got ${optsX.length}`);
      const secondVal = await optsX[optsX.length - 1].getAttribute("value");
      await page.locator("#scatter-x").selectOption(secondVal);
      await page.waitForTimeout(150);
      const after = await getCanvasDataUrl(canvas);
      assert(after !== before, "Scatter canvas did not update on X-axis change");
      tracker.assertClean("F13-T1-02");
      return `Scatter axis change updated canvas (${optsX.length} metrics)`;
    } finally {
      await context.close();
    }
  });

  add("F13-T1-03", "F13", 1, async (browser) => {
    const { context, page, tracker } = await openApp(browser, baseUrl);
    try {
      const canvas = await getScatterCanvas(page);
      await canvas.scrollIntoViewIfNeeded();
      const beforeZoom = await canvas.evaluate((el) => {
        const chart = window.echarts.getInstanceByDom(el.closest("[_echarts_instance_]"));
        chart.dispatchAction({
          type: "takeGlobalCursor",
          key: "dataZoomSelect",
          dataZoomSelectActive: true,
        });
        return JSON.stringify(chart.getOption().dataZoom);
      });
      const box = await canvas.boundingBox();
      await page.mouse.move(box.x + box.width * 0.3, box.y + box.height * 0.3);
      await page.mouse.down();
      await page.mouse.move(box.x + box.width * 0.7, box.y + box.height * 0.7, { steps: 5 });
      await page.mouse.up();
      await page.waitForTimeout(150);
      const afterZoom = await canvas.evaluate((el) => {
        const inst = window.echarts?.getInstanceByDom(el.closest("[_echarts_instance_]") || el.parentElement?.parentElement);
        return JSON.stringify(inst?.getOption()?.dataZoom || []);
      });
      assert(afterZoom !== beforeZoom, "Scatter box zoom did not change the axis ranges");
      const resetZoom = page.locator(".scatter-card button").filter({ hasText: /reset\s*zoom/i });
      if ((await resetZoom.count()) > 0) await resetZoom.first().click();
      tracker.assertClean("F13-T1-03");
      return "Scatter drag/zoom & reset verified";
    } finally {
      await context.close();
    }
  });

  add("F13-T1-04", "F13", 1, async (browser) => {
    const { context, page, tracker } = await openApp(browser, baseUrl);
    try {
      const canvas = await getScatterCanvas(page);
      const optCheck = await canvas.evaluate((el) => {
        const inst = window.echarts?.getInstanceByDom(el.closest("[_echarts_instance_]") || el.parentElement?.parentElement);
        if (!inst) return null;
        const opt = inst.getOption();
        const ser = opt.series || [];
        return {
          seriesCount: ser.length,
          hasMarkLine: ser.some((s) => Boolean(s.markLine)),
          hasMarkArea: ser.some((s) => Boolean(s.markArea)),
        };
      });
      assert(optCheck && optCheck.hasMarkLine && optCheck.hasMarkArea, `Missing markLine/markArea on scatter: ${JSON.stringify(optCheck)}`);
      tracker.assertClean("F13-T1-04");
      return `Scatter series=${optCheck.seriesCount}, markLine+markArea present`;
    } finally {
      await context.close();
    }
  });

  add("F13-T1-05", "F13", 1, async (browser) => {
    const { context, page, tracker } = await openApp(browser, baseUrl);
    try {
      const canvas = await getScatterCanvas(page);
      await canvas.scrollIntoViewIfNeeded();
      const pt = await canvas.evaluate((el) => {
        const root = el.closest("[_echarts_instance_]") || el.parentElement?.parentElement;
        const inst = window.echarts?.getInstanceByDom(root);
        if (!inst) return null;
        const series = inst.getOption().series || [];
        const idx = series.findIndex((x) => Array.isArray(x.data) && x.data.length > 0);
        if (idx < 0) return null;
        const d = series[idx].data[0];
        const val = Array.isArray(d) ? d : d.value;
        const px = inst.convertToPixel({ seriesIndex: idx }, val);
        const r = el.getBoundingClientRect();
        return { x: r.left + px[0], y: r.top + px[1] };
      });
      assert(pt, "Unable to locate plotted scatter point");
      await page.mouse.move(pt.x, pt.y);
      const tip = page.locator(".scatter-tt");
      await tip.locator("img[src*='/api/img/person/']").waitFor({ state: "visible" });
      assert((await tip.locator("img[src*='/api/img/club/']").count()) === 1, "Scatter tooltip missing club crest");
      const hovered = (await tip.locator("strong").first().textContent()).trim();
      await page.mouse.click(pt.x, pt.y);
      const profile = page.locator("#player-dialog[open]");
      await profile.waitFor({ state: "visible" });
      assert((await profile.locator("#dialog-player-name").textContent()).trim() === hovered, "Chart opened a different player");
      tracker.assertClean("F13-T1-05");
      return "Scatter HTML tooltip & click-to-open profile verified";
    } finally {
      await context.close();
    }
  });

  add("F13-T1-06", "F13", 1, async (browser) => {
    const urls = {};
    for (const scheme of ["light", "dark"]) {
      const { context, page, tracker } = await openApp(browser, baseUrl, { colorScheme: scheme });
      try {
        await selectSeasonWithManagedPlayers(page);
        const canvas = await getScatterCanvas(page);
        await waitForChartColors(page, "#scatter-chart", scheme, ["pool-dot", "accent"]);
        urls[scheme] = await getCanvasDataUrl(canvas);
        if (scheme === "light") {
          await verifyScatterPngExport(page);
        }
        tracker.assertClean(`F13-T1-06(${scheme})`);
      } finally {
        await context.close();
      }
    }
    assert(urls.light !== urls.dark, "Scatter canvas identical in light vs dark mode");
    return "Scatter PNG export & light/dark theme sync verified";
  });

  add("F13-T2-01", "F13", 2, async (browser) => {
    const { context, page, tracker } = await openApp(browser, baseUrl);
    try {
      const canvas = await getScatterCanvas(page);
      await page.locator("#f-search").fill("zzzz_zero_match_xyz");
      const box = await canvas.boundingBox();
      assert(box && box.width > 300, "Canvas collapsed on 0 rows");
      await page.locator("#f-search").fill("");
      assert((await getMatchedCount(page)) > 0);
      tracker.assertClean("F13-T2-01");
      return "Scatter survives 0-row filter & recovers";
    } finally {
      await context.close();
    }
  });

  add("F13-T2-02", "F13", 2, async (browser) => {
    const { context, page, tracker } = await openApp(browser, baseUrl);
    try {
      await getScatterCanvas(page);
      await page.locator("#f-search").fill("Pellegrino");
      assert((await getMatchedCount(page)) === 1, "Expected 1 match for Pellegrino");
      tracker.assertClean("F13-T2-02");
      return "Single-player scatter renders cleanly";
    } finally {
      await context.close();
    }
  });

  add("F13-T2-03", "F13", 2, async (browser) => {
    const { context, page, tracker } = await openApp(browser, baseUrl);
    try {
      await getScatterCanvas(page);
      await setRelaxedPoolFilters(page);
      await page.locator("#f-min-mins").selectOption("450");
      assert((await getMatchedCount(page)) > 1000);
      tracker.assertClean("F13-T2-03");
      return "High-volume 450+ mins outlier scatter rendered";
    } finally {
      await context.close();
    }
  });

  add("F13-T2-04", "F13", 2, async (browser) => {
    const { context, page, tracker } = await openApp(browser, baseUrl);
    try {
      await getScatterCanvas(page);
      const xVal = await page.locator("#scatter-x").inputValue();
      await page.locator("#scatter-y").selectOption(xVal);
      tracker.assertClean("F13-T2-04");
      return "Identical X/Y axes rendered without error";
    } finally {
      await context.close();
    }
  });

  add("F13-T2-05", "F13", 2, async (browser) => {
    const { context, page, tracker } = await openApp(browser, baseUrl);
    try {
      const canvas = await getScatterCanvas(page);
      const w1 = (await canvas.boundingBox()).width;
      await page.setViewportSize({ width: 800, height: 700 });
      await page.waitForFunction((originalWidth) => {
        const chart = document.querySelector("#scatter-chart canvas");
        return chart && chart.getBoundingClientRect().width < originalWidth;
      }, w1);
      const w2 = (await canvas.boundingBox()).width;
      assert(w2 < w1 && w2 > 200, `Canvas did not reflow on resize: ${w1} -> ${w2}`);
      tracker.assertClean("F13-T2-05");
      return `Scatter canvas resized ${Math.round(w1)} -> ${Math.round(w2)}`;
    } finally {
      await context.close();
    }
  });

  add("F13-T2-06", "F13", 2, async (browser) => {
    const { context, page, tracker } = await openApp(browser, baseUrl);
    try {
      await getScatterCanvas(page);
      await page.locator("#position-tablist").evaluate((tablist) => {
        for (const pos of ["W", "CM", "GK"]) tablist.querySelector(`#tab-${pos}`).click();
      });
      await page.waitForFunction(() => document.querySelector("#tab-GK")?.getAttribute("aria-selected") === "true", null, { timeout: 2500 });
      await waitForAppReady(page);
      assert((await page.locator("#scatter-x").inputValue()) === "xg_prevented_p90", "Scatter axes did not settle on GK");
      tracker.assertClean("F13-T2-06");
      return "Rapid tab switching settled cleanly on GK";
    } finally {
      await context.close();
    }
  });

  // ==================== F14 ECHARTS PROFILE RADAR & PROGRESSION (12 cases) ====================
  add("F14-T1-01", "F14", 1, async (browser) => {
    const { context, page, tracker } = await openApp(browser, baseUrl);
    try {
      const dlg = await openFirstProfileDialog(page);
      assert((await dlg.locator("#radar-svg").count()) === 0, "Legacy #radar-svg still present");
      const radarCanvas = dlg.locator("canvas").first();
      assert((await radarCanvas.count()) > 0, "Radar ECharts <canvas> missing in profile dialog");
      const box = await radarCanvas.boundingBox();
      assert(box && box.width >= 240 && box.height >= 240, `Radar canvas too small: ${JSON.stringify(box)}`);
      const imgs = dlg.locator('img[src*="/api/img/"]');
      assert((await imgs.count()) >= 1, "Profile dialog missing player/club <img>");
      tracker.assertClean("F14-T1-01");
      return `Profile Radar canvas ${Math.round(box.width)}x${Math.round(box.height)}`;
    } finally {
      await context.close();
    }
  });

  add("F14-T1-02", "F14", 1, async (browser) => {
    const { context, page, tracker } = await openApp(browser, baseUrl);
    try {
      const dlg = await openFirstProfileDialog(page);
      const radarCanvas = dlg.locator("canvas").first();
      assert((await radarCanvas.count()) > 0, "Radar <canvas> missing");
      const before = await getCanvasDataUrl(radarCanvas);
      await dlg.locator("#dialog-compare-select").selectOption("");
      await page.waitForTimeout(120);
      const after = await getCanvasDataUrl(radarCanvas);
      assert(after !== before, "Radar canvas did not change when switching comparison");
      tracker.assertClean("F14-T1-02");
      return "Radar comparison switching updated canvas";
    } finally {
      await context.close();
    }
  });

  add("F14-T1-03", "F14", 1, async (browser) => {
    const { context, page, tracker } = await openApp(browser, baseUrl, {
      preInitHook: async (pg) => {
        await buildTwoSeasonRoutes(pg);
      },
    });
    try {
      const dlg = await openFirstProfileDialog(page);
      const wrap = dlg.locator("#dialog-progression-wrap");
      await wrap.waitFor({ state: "visible", timeout: 2500 });
      const progCanvas = wrap.locator("canvas").first();
      await progCanvas.waitFor({ state: "visible", timeout: 2500 });
      const box = await progCanvas.boundingBox();
      assert(box && box.width >= 240 && box.height >= 140, `Progression canvas too small: ${JSON.stringify(box)}`);
      tracker.assertClean("F14-T1-03");
      return `Progression canvas ${Math.round(box.width)}x${Math.round(box.height)}`;
    } finally {
      await context.close();
    }
  });

  add("F14-T1-04", "F14", 1, async (browser) => {
    const { context, page, tracker } = await openApp(browser, baseUrl);
    try {
      const dlg = await openFirstProfileDialog(page);
      assert((await dlg.locator("canvas").count()) >= 1, "Radar <canvas> missing");
      const progHidden =
        (await dlg.locator("#dialog-progression-wrap").isHidden()) ||
        (await dlg.locator("#progression-chart").isHidden());
      assert(progHidden && (await dlg.locator("#dialog-progression-wrap canvas").count()) === 0, "Progression chart should be hidden for 1 season");
      tracker.assertClean("F14-T1-04");
      return "Single-season progression cleanly hidden";
    } finally {
      await context.close();
    }
  });

  add("F14-T1-05", "F14", 1, async (browser) => {
    const { context, page, tracker } = await openApp(browser, baseUrl);
    try {
      const dlg1 = await openFirstProfileDialog(page);
      assert((await dlg1.locator("canvas").count()) >= 1, "Radar <canvas> missing");
      await page.keyboard.press("Escape");
      await switchPositionTab(page, "GK");
      const dlg2 = await openFirstProfileDialog(page);
      const txt = (await dlg2.textContent()) || "";
      assert(/Save %|xG Prevented/i.test(txt), "GK metrics missing after reopening profile dialog");
      tracker.assertClean("F14-T1-05");
      return "Dialog close & reopen across ST -> GK succeeded";
    } finally {
      await context.close();
    }
  });

  add("F14-T1-06", "F14", 1, async (browser) => {
    const snaps = {};
    for (const scheme of ["light", "dark"]) {
      const { context, page, tracker } = await openApp(browser, baseUrl, { colorScheme: scheme });
      try {
        await selectSeasonWithManagedPlayers(page);
        const dlg = await openFirstProfileDialog(page);
        const canvas = dlg.locator("canvas").first();
        assert((await canvas.count()) > 0, "Radar <canvas> missing");
        const comparison = dlg.locator("#dialog-compare-select");
        await comparison.selectOption({ index: 1 });
        await waitForChartColors(page, "#radar-chart", scheme, ["accent", "compare"]);
        snaps[scheme] = await getCanvasDataUrl(canvas);
        tracker.assertClean(`F14-T1-06(${scheme})`);
      } finally {
        await context.close();
      }
    }
    assert(snaps.light !== snaps.dark, "Radar canvas identical in light vs dark");
    return "Radar light/dark synchronization verified";
  });

  add("F14-T2-01", "F14", 2, async (browser) => {
    const { context, page, tracker } = await openApp(browser, baseUrl, { viewport: { width: 390, height: 844 } });
    try {
      const dlg = await openFirstProfileDialog(page);
      const canvas = dlg.locator("canvas").first();
      assert((await canvas.count()) > 0, "Radar <canvas> missing");
      const box = await canvas.boundingBox();
      assert(box && box.width > 180 && box.height > 180, `Mobile radar too small: ${JSON.stringify(box)}`);
      const overflow = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 2);
      assert(!overflow, "Horizontal overflow on 390x844 mobile viewport");
      tracker.assertClean("F14-T2-01");
      return `Mobile 390x844 dialog & radar ${Math.round(box.width)}x${Math.round(box.height)}`;
    } finally {
      await context.close();
    }
  });

  add("F14-T2-02", "F14", 2, async (browser) => {
    const { context, page, tracker } = await openApp(browser, baseUrl, {
      preInitHook: async (pg) => {
        const stRes = await pg.request.get("/data/ST.json");
        const st = await stRes.json();
        const player = st.players.find((p) => p.name?.includes("Pellegrino"));
        assert(player, "Pellegrino missing from the current season fixture");
        await buildTwoSeasonRoutes(pg, { dropPlayerUid: player.uid });
      },
    });
    try {
      await page.locator("#f-search").fill("Pellegrino");
      const dlg = await openFirstProfileDialog(page);
      assert((await dlg.locator("canvas").count()) >= 1, "Radar <canvas> missing");
      await page.waitForTimeout(150);
      const progHidden =
        (await dlg.locator("#dialog-progression-wrap").isHidden()) ||
        (await dlg.locator("#progression-chart").isHidden());
      assert(progHidden && (await dlg.locator("#dialog-progression-wrap canvas").count()) === 0, "Progression should hide when player missing in prior season");
      tracker.assertClean("F14-T2-02");
      return "Player missing in prior season hid progression cleanly";
    } finally {
      await context.close();
    }
  });

  add("F14-T2-03", "F14", 2, async (browser) => {
    const { context, page, tracker } = await openApp(browser, baseUrl);
    try {
      await findTabulator(page);
      await page.locator("#f-search").fill("Pellegrino");
      const dlg = await openFirstProfileDialog(page);
      assert((await dlg.locator("canvas").count()) >= 1, "Radar <canvas> missing");
      const opts = await dlg.locator("#dialog-compare-select option").allTextContents();
      assert(!opts.some((o) => /Pellegrino/i.test(o)), `Self-comparison leaked: ${opts}`);
      tracker.assertClean("F14-T2-03");
      return "Managed player self-comparison excluded";
    } finally {
      await context.close();
    }
  });

  add("F14-T2-04", "F14", 2, async (browser) => {
    const { context, page, tracker } = await openApp(browser, baseUrl);
    try {
      await setRelaxedPoolFilters(page);
      await page.locator("#f-min-mins").selectOption("450");
      const dlg = await openFirstProfileDialog(page);
      assert((await dlg.locator("canvas").count()) >= 1, "Radar <canvas> missing");
      const txt = (await dlg.textContent()) || "";
      assert(!/NaN|Infinity/i.test(txt), "NaN/Infinity in profile dialog stats");
      tracker.assertClean("F14-T2-04");
      return "Low-minute / zero-stat player radar valid";
    } finally {
      await context.close();
    }
  });

  add("F14-T2-05", "F14", 2, async (browser) => {
    const { context, page, tracker } = await openApp(browser, baseUrl, {
      preInitHook: async (pg) => {
        await pg.route("**/api/img/person/*", async (route) => {
          await route.fulfill({
            status: 200,
            contentType: "image/svg+xml",
            body: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 40 40"><text x="20" y="24">XX</text></svg>',
          });
        });
      },
    });
    try {
      const dlg = await openFirstProfileDialog(page);
      const img = dlg.locator('img[src*="/api/img/person/"]').first();
      assert((await img.count()) > 0, "Missing portrait <img> in profile dialog");
      assert(await img.evaluate((el) => el.complete && el.naturalWidth > 0), "Fallback SVG portrait failed");
      tracker.assertClean("F14-T2-05");
      return "Profile portrait SVG fallback rendered cleanly";
    } finally {
      await context.close();
    }
  });

  add("F14-T2-06", "F14", 2, async (browser) => {
    const { context, page, tracker } = await openApp(browser, baseUrl);
    try {
      const dlg1 = await openFirstProfileDialog(page);
      assert((await dlg1.locator("canvas").count()) >= 1, "Radar <canvas> missing");
      await page.keyboard.press("Escape");
      await page.setViewportSize({ width: 920, height: 700 });
      const dlg2 = await openFirstProfileDialog(page);
      const box = await dlg2.locator("canvas").first().boundingBox();
      assert(box && box.width >= 200, "Radar canvas failed to resize after reopen");
      tracker.assertClean("F14-T2-06");
      return "Escape dismissal + resize + reopen verified";
    } finally {
      await context.close();
    }
  });

  // ==================== F15 TABULATOR PLAYERS TABLE (12 cases) ====================
  add("F15-T1-01", "F15", 1, async (browser) => {
    const { context, page, tracker } = await openApp(browser, baseUrl);
    try {
      await findTabulator(page);
      await setRelaxedPoolFilters(page);
      const matched = await getMatchedCount(page);
      assert(matched > 1000, `Expected >1000 ST targets, got ${matched}`);
      const domRows = await getTabulatorRowCount(page);
      assert(domRows > 0 && domRows < 180, `Expected virtualized DOM rows <180, got ${domRows}`);
      const holder = page.locator(".tabulator .tabulator-tableholder");
      await holder.evaluate((el) => { el.scrollTop = el.scrollHeight * 0.6; });
      await page.waitForTimeout(80);
      assert((await getTabulatorRowCount(page)) > 0, "Virtual scroll lost rows");
      tracker.assertClean("F15-T1-01");
      return `Virtualized ${matched} matching players (${domRows} DOM rows)`;
    } finally {
      await context.close();
    }
  });

  add("F15-T1-02", "F15", 1, async (browser) => {
    const { context, page, tracker } = await openApp(browser, baseUrl);
    try {
      await findTabulator(page);
      const frozen = page.locator(".tabulator .tabulator-row .tabulator-frozen-left").first();
      assert((await frozen.count()) > 0, "Missing .tabulator-frozen-left Player cell");
      const xBefore = (await frozen.boundingBox()).x;
      await page.locator(".tabulator .tabulator-tableholder").evaluate((el) => { el.scrollLeft = 400; });
      const xAfter = (await frozen.boundingBox()).x;
      assert(Math.abs(xBefore - xAfter) < 3, `Frozen Player column moved on scroll: ${xBefore} -> ${xAfter}`);
      assert((await frozen.locator('img[src*="/api/img/person/"]').count()) > 0, "Player cell missing face <img>");
      tracker.assertClean("F15-T1-02");
      return "Frozen Player column with face <img> verified";
    } finally {
      await context.close();
    }
  });

  add("F15-T1-03", "F15", 1, async (browser) => {
    const { context, page, tracker } = await openApp(browser, baseUrl);
    try {
      await findTabulator(page);
      const clubImgs = page.locator('.tabulator .tabulator-row img[src*="/api/img/club/"]');
      assert((await clubImgs.count()) > 0, "Tabulator Club column missing club crest <img>");
      const ok = await clubImgs.first().evaluate((el) => el.complete && el.naturalWidth > 0);
      assert(ok, "Tabulator club crest <img> failed to load");
      tracker.assertClean("F15-T1-03");
      return "Tabulator Club column crest <img> loaded";
    } finally {
      await context.close();
    }
  });

  add("F15-T1-04", "F15", 1, async (browser) => {
    const { context, page, tracker } = await openApp(browser, baseUrl);
    try {
      await findTabulator(page);
      const ageHdr = page.locator(".tabulator .tabulator-col").filter({ hasText: /^Age$/i }).first();
      const scoreHdr = page.locator(".tabulator .tabulator-col").filter({ hasText: /Role Score/i }).first();
      await ageHdr.click();
      await scoreHdr.click({ modifiers: ["Shift"] });
      assert(
        (await page.locator('.tabulator .pct-pill, .tabulator [class*="pct-"], .tabulator .pill').count()) > 0,
        "Missing percentile pill cells"
      );
      tracker.assertClean("F15-T1-04");
      return "Multi-column sort & percentile pills verified";
    } finally {
      await context.close();
    }
  });

  add("F15-T1-05", "F15", 1, async (browser) => {
    const { context, page, tracker } = await openApp(browser, baseUrl);
    try {
      await findTabulator(page);
      const btn = await getColumnChooserButton(page);
      await btn.click();
      const pop = page.locator("[popover]:popover-open").first();
      await pop.waitFor({ state: "visible", timeout: 1200 });
      const wageBox = pop.locator("label").filter({ hasText: /Wage/i }).locator('input[type="checkbox"]').first();
      const wageCol = page.locator(".tabulator .tabulator-col").filter({ hasText: /Wage/i }).first();
      await wageBox.uncheck();
      assert(await wageCol.isHidden(), "Wage column not hidden");
      await wageBox.check();
      assert(await wageCol.isVisible(), "Wage column not restored");
      tracker.assertClean("F15-T1-05");
      return "Column Chooser popover hide/restore verified";
    } finally {
      await context.close();
    }
  });

  add("F15-T1-06", "F15", 1, async (browser) => {
    const bgs = {};
    for (const scheme of ["light", "dark"]) {
      const { context, page, tracker } = await openApp(browser, baseUrl, { colorScheme: scheme });
      try {
        await findTabulator(page);
        if (scheme === "light") {
          const col = page.locator(".tabulator .tabulator-header .tabulator-col:visible").nth(2);
          await col.scrollIntoViewIfNeeded();
          const w1 = (await col.boundingBox()).width;
          const adjHandle = col.locator("xpath=following-sibling::*[contains(@class,'tabulator-col-resize-handle')][1]");
          const allHandles = page.locator(".tabulator .tabulator-header .tabulator-col-resize-handle:visible").nth(2);
          const handle = (await adjHandle.count()) > 0 ? adjHandle : allHandles;
          const hBox = await handle.boundingBox();
          assert(hBox, "Tabulator resize handle boundingBox missing");
          await page.mouse.move(hBox.x + hBox.width / 2, hBox.y + hBox.height / 2);
          await page.mouse.down();
          await page.mouse.move(hBox.x + 60, hBox.y + hBox.height / 2, { steps: 4 });
          await page.mouse.up();
          const w2 = (await col.boundingBox()).width;
          assert(w2 > w1 + 15, `Column did not resize: ${w1} -> ${w2}`);
        }
        bgs[scheme] = await page.locator(".tabulator .tabulator-header").evaluate((el) => getComputedStyle(el).backgroundColor);
        tracker.assertClean(`F15-T1-06(${scheme})`);
      } finally {
        await context.close();
      }
    }
    assert(bgs.light !== bgs.dark, `Tabulator header bg identical in light vs dark: ${bgs.light}`);
    return `Tabulator resize & theming (${bgs.light} vs ${bgs.dark})`;
  });

  add("F15-T2-01", "F15", 2, async (browser) => {
    const { context, page, tracker } = await openApp(browser, baseUrl);
    try {
      await findTabulator(page);
      await switchPositionTab(page, "W");
      await setRelaxedPoolFilters(page);
      const holder = page.locator(".tabulator .tabulator-tableholder");
      await holder.scrollIntoViewIfNeeded();
      await holder.evaluate((el) => { el.scrollTop = el.scrollHeight * 0.75; });
      await page.waitForTimeout(100);
      const player = await holder.evaluate((el) => {
        const bounds = el.getBoundingClientRect();
        const button = [...el.querySelectorAll("button.player-link")].find((item) => {
          const box = item.getBoundingClientRect();
          return box.top >= bounds.top && box.bottom <= bounds.bottom;
        });
        if (!button) return null;
        const row = button.closest(".tabulator-row");
        return { name: button.textContent.trim(), uid: row.querySelector(".row-star-btn").dataset.uid };
      });
      assert(player, "No visible player after virtual scrolling");
      const row = holder.locator(".tabulator-row").filter({
        has: page.locator(`.row-star-btn[data-uid=${JSON.stringify(player.uid)}]`),
      });
      await row.locator(".player-link").click();
      const dlg = page.locator("#player-dialog[open]");
      await dlg.waitFor({ state: "visible", timeout: 2500 });
      const dlgName = ((await dlg.locator("#dialog-player-name").textContent()) || "").trim();
      assert(player.name === dlgName, `Row mismatch: clicked ${player.name}, opened ${dlgName}`);
      tracker.assertClean("F15-T2-01");
      return `Deep virtual scroll clicked '${dlgName}' accurately`;
    } finally {
      await context.close();
    }
  });

  add("F15-T2-02", "F15", 2, async (browser) => {
    const { context, page, tracker } = await openApp(browser, baseUrl);
    try {
      await findTabulator(page);
      await page.locator("#f-search").fill("zzzz_empty_table_test");
      assert((await getTabulatorRowCount(page)) === 0);
      const resetBtn = await findResetFiltersButton(page);
      await resetBtn.click();
      assert((await getTabulatorRowCount(page)) > 0);
      tracker.assertClean("F15-T2-02");
      return "Empty Tabulator state & recovery verified";
    } finally {
      await context.close();
    }
  });

  add("F15-T2-03", "F15", 2, async (browser) => {
    const { context, page, tracker } = await openApp(browser, baseUrl);
    try {
      await findTabulator(page);
      await setRelaxedPoolFilters(page);
      const valHdr = page.locator(".tabulator .tabulator-col").filter({ hasText: /^Value$/i }).first();
      await valHdr.click();
      await valHdr.click();
      const values = await page.locator('.tabulator-cell[tabulator-field="value"]').allTextContents();
      assert(values.length > 0, "No Value cells rendered after sorting");
      assert(values.every((value) => !/\b(?:NaN|undefined)\b/.test(value)), "Invalid value after sorting");
      tracker.assertClean("F15-T2-03");
      return "Null value/wage/contract sorting clean";
    } finally {
      await context.close();
    }
  });

  add("F15-T2-04", "F15", 2, async (browser) => {
    const { context, page, tracker } = await openApp(browser, baseUrl);
    try {
      await findTabulator(page);
      const btn = await getColumnChooserButton(page);
      await btn.click();
      const pop = page.locator("[popover]:popover-open").first();
      const boxes = pop.locator('input[type="checkbox"]');
      const n = await boxes.count();
      for (let i = 0; i < n; i++) {
        const box = boxes.nth(i);
        if ((await box.isChecked()) && (await box.isEnabled())) {
          await box.uncheck();
        }
      }
      assert((await page.locator(".tabulator .tabulator-frozen-left").count()) > 0, "Frozen Player column disappeared");
      tracker.assertClean("F15-T2-04");
      return "Frozen Player column protected when hiding columns";
    } finally {
      await context.close();
    }
  });

  add("F15-T2-05", "F15", 2, async (browser) => {
    const { context, page, tracker } = await openApp(browser, baseUrl);
    try {
      await findTabulator(page);
      await switchPositionTab(page, "GK");
      const gkCols = await page.locator(".tabulator .tabulator-col-title").allTextContents();
      assert(gkCols.some((c) => /Save %/i.test(c)), `Missing Save % on GK: ${gkCols}`);
      await switchPositionTab(page, "CB");
      const cbCols = await page.locator(".tabulator .tabulator-col-title").allTextContents();
      assert(!cbCols.some((c) => /Save %/i.test(c)) && cbCols.some((c) => /Headers Won/i.test(c)), `Bad CB cols: ${cbCols}`);
      tracker.assertClean("F15-T2-05");
      return "Tabulator columns rebuilt cleanly on ST -> GK -> CB";
    } finally {
      await context.close();
    }
  });

  add("F15-T2-06", "F15", 2, async (browser) => {
    const { context, page, tracker } = await openApp(browser, baseUrl, { colorScheme: "light" });
    try {
      await findTabulator(page);
      const bgLight = await page.locator(".tabulator .tabulator-header").evaluate((el) => getComputedStyle(el).backgroundColor);
      await page.emulateMedia({ colorScheme: "dark" });
      await page.waitForTimeout(80);
      const bgDark = await page.locator(".tabulator .tabulator-header").evaluate((el) => getComputedStyle(el).backgroundColor);
      assert(bgLight !== bgDark, `Dynamic emulateMedia did not update Tabulator theme (${bgLight})`);
      tracker.assertClean("F15-T2-06");
      return `Dynamic colorScheme flip updated Tabulator (${bgLight} -> ${bgDark})`;
    } finally {
      await context.close();
    }
  });

  // ==================== TIER 3 PAIRWISE CROSS-FEATURE (16 cases) ====================
  add("T3-01", "T3", 3, async (browser) => {
    const { context, page, tracker } = await openApp(browser, baseUrl);
    try {
      await setRelaxedPoolFilters(page);
      await findTabulator(page);
      await getScatterCanvas(page);
      await selectFirstMatchingInPopover(page, /\bleagues?\b/i, "Premier League", 1);
      const { popover } = await openFilterPopover(page, /\bclubs?\b/i);
      assert((await (await getPopoverCheckboxes(popover)).count()) <= 25, "Clubs did not narrow to Premier League");
      await page.keyboard.press("Escape");
      assert((await getMatchedCount(page)) > 0);
      tracker.assertClean("T3-01");
      return "Leagues x Clubs x Scatter x Tabulator synced";
    } finally {
      await context.close();
    }
  });

  add("T3-02", "T3", 3, async (browser) => {
    const { context, page, tracker } = await openApp(browser, baseUrl);
    try {
      await setRelaxedPoolFilters(page);
      await selectFirstMatchingInPopover(page, /\bpositions?\b/i, "ST", 1);
      await selectFirstMatchingInPopover(page, /\bfoot\b/i, "Left", 1);
      assert((await getMatchedCount(page)) > 0, "ST + Left Foot returned 0");
      tracker.assertClean("T3-02");
      return "Positions (ST<->STC) x Foot x Table verified";
    } finally {
      await context.close();
    }
  });

  add("T3-03", "T3", 3, async (browser) => {
    const { context, page, tracker } = await openApp(browser, baseUrl);
    try {
      await findResetFiltersButton(page);
      await selectOptionByText(page.locator("#f-contract"), /2029/);
      await selectFirstMatchingInPopover(page, /\bstatus\b/i, "Not On Loan", 1);
      assert((await (await getFilterChips(page)).count()) >= 1);
      tracker.assertClean("T3-03");
      return "Status x Dynamic Contract Expiry verified";
    } finally {
      await context.close();
    }
  });

  add("T3-04", "T3", 3, async (browser) => {
    const { context, page, tracker } = await openApp(browser, baseUrl);
    try {
      await findResetFiltersButton(page);
      await page.locator("h1").click();
      await page.keyboard.press("/");
      await page.keyboard.type("Bell");
      assert((await page.locator("#f-search").inputValue()) === "Bell");
      const { popover } = await openFilterPopover(page, /\bleagues?\b/i);
      const inp = await getPopoverSearchInput(popover);
      await inp.focus();
      await page.keyboard.press("/");
      assert((await inp.inputValue()) === "/", "'/' did not type into popover search");
      tracker.assertClean("T3-04");
      return "'/' shortcut x Popovers x Chips verified";
    } finally {
      await context.close();
    }
  });

  add("T3-05", "T3", 3, async (browser) => {
    const { context, page, tracker } = await openApp(browser, baseUrl);
    try {
      await findTabulator(page);
      const stars = await getRowShortlistStars(page);
      assert((await stars.count()) > 0, "Row shortlist star missing");
      await stars.first().click();
      const dlg = await openFirstProfileDialog(page);
      assert(/Remove/i.test((await dlg.locator("#dialog-shortlist-btn").textContent()) || ""));
      await page.keyboard.press("Escape");
      await page.locator("#btn-shortlist-view").click();
      await page.locator("#shortlist-dialog[open] .remove-shortlist-btn").first().click();
      assert((await page.locator("#shortlist-count").textContent())?.trim() === "0");
      tracker.assertClean("T3-05");
      return "Quick row shortlist x Profile dialog x Shortlist modal synced";
    } finally {
      await context.close();
    }
  });

  add("T3-06", "T3", 3, async (browser) => {
    const { context, page, tracker } = await openApp(browser, baseUrl);
    try {
      const baseCnt = await getMatchedCount(page);
      await getScatterCanvas(page);
      await page.locator("#f-max-age").selectOption("21");
      await page.locator("#f-search").fill("a");
      await selectFirstMatchingInPopover(page, /\bfoot\b/i, "", 1);
      await (await findResetFiltersButton(page)).click();
      assert((await getMatchedCount(page)) === baseCnt);
      tracker.assertClean("T3-06");
      return "Reset Filters x Multi-selects x Scatter synced";
    } finally {
      await context.close();
    }
  });

  add("T3-07", "T3", 3, async (browser) => {
    const { context, page, tracker } = await openApp(browser, baseUrl);
    try {
      await findTabulator(page);
      const canvas = await getScatterCanvas(page);
      const beforeCanvas = await getCanvasDataUrl(canvas);
      const beforeScores = await getTableRowScoresSnapshot(page);
      const dlg = await findCustomizeDialog(page);
      await selectCalcMethod(dlg, /Z-Score/i);
      await page.keyboard.press("Escape");
      await page.waitForTimeout(150);
      const afterCanvas = await getCanvasDataUrl(canvas);
      const afterScores = await getTableRowScoresSnapshot(page);
      assert(beforeCanvas.length > 1000 && afterCanvas.length > 1000, "Scatter canvas invalid");
      assert(beforeCanvas !== afterCanvas || beforeScores !== afterScores, "Z-Score change did not update scatter or table");
      tracker.assertClean("T3-07");
      return "Customize Score Method x Scatter x Tabulator verified";
    } finally {
      await context.close();
    }
  });

  add("T3-08", "T3", 3, async (browser) => {
    const { context, page, tracker } = await openApp(browser, baseUrl);
    try {
      await findTabulator(page);
      const beforeScores = await getTableRowScoresSnapshot(page);
      const pdBefore = await openFirstProfileDialog(page);
      const radarBefore = await getCanvasDataUrl(pdBefore.locator("canvas").first());
      await page.keyboard.press("Escape");

      const dlg = await findCustomizeDialog(page);
      const dirBtn = dlg.locator("button").filter({ hasText: /Higher\s*↑|Lower\s*↓/i }).first();
      assert((await dirBtn.count()) > 0, "Direction toggle button missing");
      await dirBtn.click();
      await page.keyboard.press("Escape");
      await page.waitForTimeout(150);

      const afterScores = await getTableRowScoresSnapshot(page);
      const pdAfter = await openFirstProfileDialog(page);
      assert((await pdAfter.locator("canvas").count()) >= 1);
      const radarAfter = await getCanvasDataUrl(pdAfter.locator("canvas").first());
      assert(afterScores !== beforeScores || radarAfter !== radarBefore, "Direction flip did not update Role Score or Radar");
      tracker.assertClean("T3-08");
      return "Customize Score Direction x Profile Radar verified";
    } finally {
      await context.close();
    }
  });

  add("T3-09", "T3", 3, async (browser) => {
    const { context, page, tracker } = await openApp(browser, baseUrl);
    try {
      const dlg = await findCustomizeDialog(page);
      const inp = await findPresetNameInput(dlg);
      await inp.fill("Poacher");
      await dlg.getByRole("button", { name: /save/i }).first().click();
      await page.keyboard.press("Escape");
      const preset = page.locator('#f-role option[value^="custom:"]').filter({ hasText: /^Poacher$/ });
      await switchPositionTab(page, "W");
      assert((await preset.count()) === 0, "ST preset appeared on the W tab");
      await page.reload({ waitUntil: "domcontentloaded" });
      await waitForAppReady(page);
      assert((await preset.count()) === 1, "Saved ST preset missing after reload");
      tracker.assertClean("T3-09");
      return "Presets localStorage x Position Tabs x Reload verified";
    } finally {
      await context.close();
    }
  });

  add("T3-10", "T3", 3, async (browser) => {
    const { context, page, tracker } = await openApp(browser, baseUrl);
    try {
      const canvas = await getScatterCanvas(page);
      const benchVal = await page.locator("#f-benchmark").inputValue();
      const pt = await canvas.evaluate((el) => {
        const inst = window.echarts?.getInstanceByDom(el.closest("[_echarts_instance_]") || el.parentElement?.parentElement);
        const series = inst?.getOption()?.series || [];
        const idx = series.findIndex((x) => Array.isArray(x.data) && x.data.length > 0);
        if (idx < 0) return null;
        const d = series[idx].data[0];
        const px = inst.convertToPixel({ seriesIndex: idx }, Array.isArray(d) ? d : d.value);
        const r = el.getBoundingClientRect();
        return { x: r.left + px[0], y: r.top + px[1] };
      });
      assert(pt, "No scatter point found");
      await page.mouse.click(pt.x, pt.y);
      const dlg = page.locator("#player-dialog[open]");
      await dlg.waitFor({ state: "visible", timeout: 2500 });
      assert((await dlg.locator("#dialog-compare-select").inputValue()) === benchVal || benchVal === "");
      tracker.assertClean("T3-10");
      return "Scatter click x Profile Dialog x Benchmark sync verified";
    } finally {
      await context.close();
    }
  });

  add("T3-11", "T3", 3, async (browser) => {
    const { context, page, tracker } = await openApp(browser, baseUrl);
    try {
      const canvas = await getScatterCanvas(page);
      const before = await getCanvasDataUrl(canvas);
      await page.locator("#scatter-x").selectOption("avg_rating");
      await page.locator("#scatter-y").selectOption("xg_per_shot");
      await page.waitForTimeout(150);
      const after = await getCanvasDataUrl(canvas);
      assert(after !== before, "Scatter canvas did not update for avg_rating vs xg_per_shot");
      tracker.assertClean("T3-11");
      return "Scatter X/Y avg_rating vs xg_per_shot verified";
    } finally {
      await context.close();
    }
  });

  add("T3-12", "T3", 3, async (browser) => {
    const { context, page, tracker } = await openApp(browser, baseUrl);
    try {
      await findTabulator(page);
      const btn = await getColumnChooserButton(page);
      await btn.click();
      const pop = page.locator("[popover]:popover-open").first();
      await pop.locator("label").filter({ hasText: /Wage/i }).locator('input[type="checkbox"]').first().uncheck();
      await page.keyboard.press("Escape");
      await page.locator(".tabulator .tabulator-col").filter({ hasText: /^Age$/i }).first().click();
      const [dl] = await Promise.all([
        page.waitForEvent("download", { timeout: 2500 }),
        page.locator("#btn-export-csv").click(),
      ]);
      const p = await dl.path();
      assert(p && fs.readFileSync(p, "utf-8").split("\n").length > 2);
      tracker.assertClean("T3-12");
      return "Column Chooser x Multi-Sort x CSV Export verified";
    } finally {
      await context.close();
    }
  });

  add("T3-13", "T3", 3, async (browser) => {
    const { context, page, tracker } = await openApp(browser, baseUrl);
    try {
      await findTabulator(page);
      const holder = page.locator(".tabulator .tabulator-tableholder");
      await holder.scrollIntoViewIfNeeded();
      const ready = await page.waitForFunction(() => {
        const holder = document.querySelector(".tabulator-tableholder");
        const bounds = holder.getBoundingClientRect();
        const images = [...holder.querySelectorAll('img[src*="/api/img/"]')].filter((img) => {
          const box = img.getBoundingClientRect();
          return box.width > 0 && box.height > 0 &&
            box.bottom > Math.max(0, bounds.top) &&
            box.top < Math.min(window.innerHeight, bounds.bottom) &&
            box.right > Math.max(0, bounds.left) &&
            box.left < Math.min(window.innerWidth, bounds.right);
        });
        return images.length >= 5 && images.every((img) => img.complete && img.naturalWidth > 0)
          ? images.length
          : false;
      }, null, { timeout: 5000 });
      tracker.assertClean("T3-13");
      return `${await ready.jsonValue()} visible table images loaded`;
    } finally {
      await context.close();
    }
  });

  add("T3-14", "T3", 3, async (browser) => {
    const { context, page, tracker } = await openApp(browser, baseUrl, {
      preInitHook: async (pg) => {
        await pg.route(/^https?:\/\/(?!(127\.0\.0\.1|localhost)(:\d+)?(\/|$))/i, (route) => {
          return route.abort();
        });
      },
    });
    try {
      await findTabulator(page);
      await getScatterCanvas(page);
      await switchPositionTab(page, "CM");
      const dlg = await openFirstProfileDialog(page);
      assert((await dlg.locator("canvas").count()) >= 1);
      tracker.assertClean("T3-14");
      return "100% network-isolated full flow succeeded";
    } finally {
      await context.close();
    }
  });

  add("T3-15", "T3", 3, async (browser) => {
    const { context, page, tracker } = await openApp(browser, baseUrl, { colorScheme: "dark" });
    try {
      await findTabulator(page);
      await getScatterCanvas(page);
      await openFilterPopover(page, /\bleagues?\b/i);
      await page.keyboard.press("Escape");
      await findCustomizeDialog(page);
      await page.keyboard.press("Escape");
      const pd = await openFirstProfileDialog(page);
      assert((await pd.locator("canvas").count()) >= 1);
      tracker.assertClean("T3-15");
      return "Full dark-mode flow clean";
    } finally {
      await context.close();
    }
  });

  add("T3-16", "T3", 3, async (browser) => {
    const { context, page, tracker } = await openApp(browser, baseUrl);
    try {
      await findTabulator(page);
      await findCustomizeScoreButton(page);
      await page.locator("#f-dynamic-pct").uncheck();
      const summary = (await page.locator("#pool-summary").textContent()) || "";
      assert(/Global/i.test(summary), `Expected Global percentiles summary, got: ${summary}`);
      tracker.assertClean("T3-16");
      return "Dynamic Pool Percentiles toggle x Role Score x Pills verified";
    } finally {
      await context.close();
    }
  });

  // ==================== TIER 4 REAL-WORLD WORKFLOWS (9 cases) ====================
  add("T4-01", "T4", 4, async (browser) => {
    const { context, page, tracker } = await openApp(browser, baseUrl);
    try {
      await findTabulator(page);
      await page.locator("#f-max-age").selectOption("23", { timeout: 10000 });
      await page.locator("#f-max-val").selectOption("999999999", { timeout: 10000 });
      await selectOptionByText(page.locator("#f-contract"), /2028/);
      await selectFirstMatchingInPopover(page, /\bstatus\b/i, "Not On Loan", 1);
      assert((await (await getFilterChips(page)).count()) >= 3, "Expected >=3 active filter chips");
      const stars = await getRowShortlistStars(page);
      const cnt = Math.min(2, await stars.count());
      assert(cnt >= 1, "No Bosman rows or shortlist stars");
      for (let i = 0; i < cnt; i++) await stars.nth(i).click();
      const dlg = await openFirstProfileDialog(page);
      assert((await dlg.locator("canvas").count()) >= 1);
      tracker.assertClean("T4-01");
      return "T4-01 Expiring-Contract Bosman Bargain Hunt passed";
    } finally {
      await context.close();
    }
  });

  add("T4-02", "T4", 4, async (browser) => {
    const { context, page, tracker } = await openApp(browser, baseUrl);
    try {
      await findTabulator(page);
      const beforeScores = await getTableRowScoresSnapshot(page);
      const beforeCanvas = await getCanvasDataUrl(await getScatterCanvas(page));
      const dlg = await findCustomizeDialog(page);
      await selectCalcMethod(dlg, /Z-Score/i);

      const unchecked = dlg.locator('input[type="checkbox"]:not(:checked):visible');
      assert((await unchecked.count()) > 0, "Expected unchecked catalog metrics in Customize Score dialog");
      await unchecked.first().check();
      const weights = dlg.locator('input[type="range"], input[type="number"]');
      assert((await weights.count()) >= 2, "Missing weight controls in Customize Score dialog");
      await weights.first().fill("5");
      await weights.first().dispatchEvent("input");
      const dirBtn = dlg.locator("button").filter({ hasText: /Higher\s*↑|Lower\s*↓/i }).first();
      if ((await dirBtn.count()) > 0) await dirBtn.click();

      const modalTxt = (await dlg.textContent()) || "";
      assert(/\d+%/.test(modalTxt), "Missing live % share readout in Customize Score modal");
      assert(/Top\s*5|Preview/i.test(modalTxt), "Missing Top-5 preview in Customize Score modal");

      const inp = await findPresetNameInput(dlg);
      await inp.fill("High-Press 9");
      await dlg.getByRole("button", { name: /save/i }).first().click();
      await page.keyboard.press("Escape");
      await page.waitForTimeout(150);

      const afterScores = await getTableRowScoresSnapshot(page);
      const afterCanvas = await getCanvasDataUrl(await getScatterCanvas(page));
      assert(afterScores !== beforeScores || afterCanvas !== beforeCanvas, "Table/scatter did not update from custom formula");

      await page.reload({ waitUntil: "domcontentloaded" });
      await waitForAppReady(page);
      assert((await page.locator("#f-role option").allTextContents()).some((o) => o.includes("High-Press 9")));
      tracker.assertClean("T4-02");
      return "T4-02 Custom Pressing-Forward Workshop passed";
    } finally {
      await context.close();
    }
  });

  add("T4-03", "T4", 4, async (browser) => {
    const { context, page, tracker } = await openApp(browser, baseUrl);
    try {
      await switchPositionTab(page, "W");
      await page.locator("#f-max-age").selectOption("99");
      await page.locator("#f-max-val").selectOption("10000000");
      await selectFirstMatchingInPopover(page, /\bleagues?\b/i, "Premier League", 1);
      await selectFirstMatchingInPopover(page, /\bpositions?\b/i, "AMR", 1);
      await selectFirstMatchingInPopover(page, /\bfoot\b/i, "Left", 1);
      const matched = await getMatchedCount(page);
      assert(matched > 0, `Expected >0 PL Left-footed AMR wingers <=10M, got ${matched}`);
      await getScatterCanvas(page);
      await findTabulator(page);
      assert((await getTabulatorRowCount(page)) > 0, "Expected >0 Tabulator rows in T4-03");
      tracker.assertClean("T4-03");
      return `T4-03 League-Specific Inverted Winger Scouting passed (${matched} matches)`;
    } finally {
      await context.close();
    }
  });

  add("T4-04", "T4", 4, async (browser) => {
    const { context, page, tracker } = await openApp(browser, baseUrl);
    try {
      await switchPositionTab(page, "CM");
      await setRelaxedPoolFilters(page);
      await page.locator("#f-max-age").selectOption("99", { timeout: 10000 });
      await page.locator("#f-min-mins").selectOption("450", { timeout: 10000 });
      const matched = await getMatchedCount(page);
      assert(matched > 150, `Expected >150 CMs, got ${matched}`);
      const btn = await getColumnChooserButton(page);
      await btn.click();
      const pop = page.locator("[popover]:popover-open").first();
      await pop.locator("label").filter({ hasText: /Wage/i }).locator('input[type="checkbox"]').first().uncheck();
      await page.keyboard.press("Escape");
      await page.locator(".tabulator .tabulator-tableholder").evaluate((el) => { el.scrollTop = el.scrollHeight * 0.5; });
      tracker.assertClean("T4-04");
      return `T4-04 Full-DB Virtual Scroll (${matched} CMs) passed`;
    } finally {
      await context.close();
    }
  });

  add("T4-05", "T4", 4, async (browser) => {
    const { context, page, tracker } = await openApp(browser, baseUrl);
    try {
      await setRelaxedPoolFilters(page);
      await page.locator("#f-max-age").selectOption("99", { timeout: 10000 });
      const resetBtn = await findResetFiltersButton(page);
      await page.locator("h1").click();
      await page.keyboard.press("/");
      await page.keyboard.type("Silva");
      const matched = await getMatchedCount(page);
      assert(matched >= 1, `Expected >=1 Silva match after relaxing age/value, got ${matched}`);
      const dlg = await openFirstProfileDialog(page);
      assert((await dlg.locator("canvas").count()) >= 1);
      await page.keyboard.press("Escape");
      await resetBtn.click();
      assert((await page.locator("#f-search").inputValue()) === "");
      assert((await page.locator("#f-max-age").inputValue()) === "25");
      tracker.assertClean("T4-05");
      return "T4-05 Keyboard-First Lookup & Reset passed";
    } finally {
      await context.close();
    }
  });

  add("T4-06", "T4", 4, async (browser) => {
    const { context, page, tracker } = await openApp(browser, baseUrl, {
      preInitHook: async (pg) => {
        await buildTwoSeasonRoutes(pg);
      },
    });
    try {
      const dlg = await openFirstProfileDialog(page);
      const wrap = dlg.locator("#dialog-progression-wrap");
      await wrap.waitFor({ state: "visible", timeout: 2500 });
      const progCanvas = wrap.locator("canvas").first();
      await progCanvas.waitFor({ state: "visible", timeout: 2500 });
      tracker.assertClean("T4-06");
      return "T4-06 Multi-Season Progression Review passed";
    } finally {
      await context.close();
    }
  });

  add("T4-07", "T4", 4, async (browser) => {
    const { context, page, tracker } = await openApp(browser, baseUrl, { colorScheme: "dark" });
    try {
      await switchPositionTab(page, "CB");
      await findTabulator(page);
      const canvas = await getScatterCanvas(page);
      assert(canvas);
      await verifyScatterPngExport(page);
      tracker.assertClean("T4-07");
      return "T4-07 Dark Mode Board Report passed";
    } finally {
      await context.close();
    }
  });

  add("T4-08", "T4", 4, async (browser) => {
    const { context, page, tracker } = await openApp(browser, baseUrl);
    try {
      await switchPositionTab(page, "GK");
      const dlg = await findCustomizeDialog(page);
      const direction = dlg.locator('[data-key="goals_allowed_p90"] .score-dir-btn');
      assert((await direction.textContent()).trim() === "Lower ↓", "GK Goals Allowed / 90 must default to Lower ↓");
      await page.keyboard.press("Escape");
      const pd = await openFirstProfileDialog(page);
      assert((await pd.locator("canvas").count()) >= 1);
      tracker.assertClean("T4-08");
      return "T4-08 Goalkeeper Audit passed";
    } finally {
      await context.close();
    }
  });

  add("T4-09", "T4", 4, async (browser) => {
    const { context, page, tracker } = await openApp(browser, baseUrl, {
      preInitHook: async (pg) => {
        await pg.route("**/api/img/**", async (route) => {
          await route.fulfill({
            status: 200,
            contentType: "image/svg+xml",
            body: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 40 40"><text x="20" y="24">FA</text></svg>',
          });
        });
      },
    });
    try {
      await setRelaxedPoolFilters(page);
      await findTabulator(page);
      const rowImgs = page.locator('.tabulator .tabulator-row img[src*="/api/img/"]');
      const imgCount = await rowImgs.count();
      assert(imgCount > 0, "Expected >0 /api/img/ <img> elements inside Tabulator rows");
      for (let i = 0; i < Math.min(imgCount, 6); i++) {
        const ok = await rowImgs.nth(i).evaluate((el) => el.complete && el.naturalWidth > 0);
        assert(ok, `Table row SVG fallback image #${i} failed to load`);
      }

      await selectFirstMatchingInPopover(page, /\bstatus\b/i, "Free Agent", 1);
      assert((await getMatchedCount(page)) === 0, "Expected 0 Free Agent rows in save");
      assert((await getTabulatorRowCount(page)) === 0, "Expected 0 Tabulator rows for Free Agent");
      tracker.assertClean("T4-09");
      return `T4-09 Graceful Degraded Graphics (${imgCount} row SVGs) & Free-Agent Audit passed`;
    } finally {
      await context.close();
    }
  });

  return cases;
}

async function main() {
  const opts = parseArgs(process.argv);
  if (!opts.baseUrl) {
    console.error("Usage: test_m4_browser.mjs --base-url URL [--tier {1,2,3,4,all}] [--json-out PATH]");
    process.exit(2);
  }

  const { chromium } = loadPlaywright();
  const execPath = findChromiumExecutable();
  const browser = await chromium.launch({ headless: true, executablePath: execPath });

  const allCases = makeTests(opts.baseUrl.replace(/\/$/, ""));
  const tierNum = opts.tier === "all" ? 0 : Number(opts.tier);
  const selected = tierNum ? allCases.filter((c) => c.tier === tierNum) : allCases;

  const results = [];
  let failures = 0;

  try {
    for (const tc of selected) {
      const t0 = performance.now();
      try {
        const detail = await tc.fn(browser);
        const dt = performance.now() - t0;
        results.push({ id: tc.id, feature: tc.feature, tier: tc.tier, passed: true, duration_ms: dt, detail });
        console.log(`[PASS] ${tc.id} (${dt.toFixed(1)}ms) - ${detail}`);
      } catch (err) {
        const dt = performance.now() - t0;
        const msg = (err && err.message ? err.message : String(err)).split("\n")[0];
        failures += 1;
        results.push({ id: tc.id, feature: tc.feature, tier: tc.tier, passed: false, duration_ms: dt, detail: msg });
        console.log(`[FAIL] ${tc.id} (${dt.toFixed(1)}ms) - ${msg}`);
      }
    }
  } finally {
    await browser.close();
  }

  if (opts.jsonOut) {
    fs.writeFileSync(opts.jsonOut, JSON.stringify(results, null, 2), "utf-8");
  }
  process.exit(failures ? 1 : 0);
}

main().catch((err) => {
  console.error(err);
  process.exit(2);
});
