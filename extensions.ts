import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { spawnSync } from "child_process";
import { readFileSync, writeFileSync } from "fs";
import { homedir } from "os";
import { join } from "path";
import { Key, matchesKey, truncateToWidth } from "@mariozechner/pi-tui";

// =============================================================================
// Types
// =============================================================================

interface Package {
  name: string;
  description: string;
  downloads?: number;
  npm?: string;
  github?: string;
}

interface NpmSearchObject {
  package: {
    name: string;
    description?: string;
    links: { npm?: string; repository?: string };
  };
}

interface NpmSearchResponse {
  total: number;
  objects: NpmSearchObject[];
}

// =============================================================================
// npm registry
// =============================================================================

const PAGE_SIZE  = 15;
const NPM_SEARCH = "https://registry.npmjs.org/-/v1/search";
const NPM_PKG    = "https://registry.npmjs.org";
const NPM_DL     = "https://api.npmjs.org/downloads/point/last-month";

function formatDownloads(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M/mo`;
  if (n >= 1_000)     return `${(n / 1_000).toFixed(1)}k/mo`;
  return `${n}/mo`;
}

async function fetchDownloads(names: string[]): Promise<Map<string, number>> {
  const counts = new Map<string, number>();
  await Promise.all(names.map(async (name) => {
    try {
      const res = await fetch(`${NPM_DL}/${encodeURIComponent(name)}`, { signal: AbortSignal.timeout(5_000) });
      if (!res.ok) return;
      const data = (await res.json()) as { downloads?: number };
      if (typeof data.downloads === "number") counts.set(name, data.downloads);
    } catch { /* non-critical */ }
  }));
  return counts;
}

async function searchNpm(query: string, page: number): Promise<{ packages: Package[]; total: number }> {
  const params = new URLSearchParams({
    text:        `keywords:pi-package ${query}`.trim(),
    size:        String(PAGE_SIZE),
    from:        String((page - 1) * PAGE_SIZE),
    popularity:  "1",
    quality:     "0",
    maintenance: "0",
  });
  const res = await fetch(`${NPM_SEARCH}?${params}`, {
    headers: { Accept: "application/json" },
    signal:  AbortSignal.timeout(8_000),
  });
  if (!res.ok) throw new Error(`npm search HTTP ${res.status}`);
  const data = (await res.json()) as NpmSearchResponse;
  const packages: Package[] = data.objects.map((obj) => {
    const repo = obj.package.links.repository ?? "";
    return {
      name:        obj.package.name,
      description: obj.package.description ?? "(no description)",
      npm:         obj.package.links.npm,
      github:      repo.includes("github.com") ? repo : undefined,
    };
  });
  const counts = await fetchDownloads(packages.map((p) => p.name));
  for (const pkg of packages) pkg.downloads = counts.get(pkg.name);
  return { packages, total: data.total };
}

async function fetchReadme(name: string): Promise<string | null> {
  try {
    const res = await fetch(`${NPM_PKG}/${encodeURIComponent(name)}`, {
      headers: { Accept: "application/json" },
      signal:  AbortSignal.timeout(8_000),
    });
    if (!res.ok) return null;
    const data = (await res.json()) as { readme?: string };
    return data.readme ?? null;
  } catch { return null; }
}

function stripMarkdown(text: string): string {
  return text
    .replace(/^#{1,6}\s+/gm, "")
    .replace(/```[\s\S]*?```/gm, "[code]")
    .replace(/`[^`]+`/g, (m) => m.slice(1, -1))
    .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

// =============================================================================
// Settings / installed packages
// =============================================================================

const SETTINGS_PATH = join(homedir(), ".pi", "agent", "settings.json");

function readSettings(): Record<string, unknown> {
  try { return JSON.parse(readFileSync(SETTINGS_PATH, "utf8")); } catch { return {}; }
}

function writeSettings(settings: Record<string, unknown>): void {
  writeFileSync(SETTINGS_PATH, JSON.stringify(settings, null, 2));
}

/** Strip npm: prefix + trailing @version, preserving @scope prefix. */
function stripPkgEntry(raw: string): string {
  const name = raw.trim().replace(/^npm:/, "");
  if (name.startsWith("@")) {
    // @scope/pkg or @scope/pkg@1.2.3 — version starts after the slash part
    const slash = name.indexOf("/");
    if (slash === -1) return name;
    const afterSlash = name.slice(slash + 1);
    const ver = afterSlash.indexOf("@");
    return ver === -1 ? name : name.slice(0, slash + 1 + ver);
  }
  // plain pkg or pkg@1.2.3
  const ver = name.indexOf("@");
  return ver === -1 ? name : name.slice(0, ver);
}

/** Returns package names registered in settings.json. */
function getSettingsPackages(): string[] {
  const settings = readSettings();
  const pkgs = Array.isArray(settings.packages) ? (settings.packages as string[]) : [];
  return pkgs
    .filter((p) => typeof p === "string" && p.startsWith("npm:"))
    .map(stripPkgEntry)
    .filter(Boolean);
}

/** Returns set of globally npm-installed pi packages (from pi list). */
function getInstalledPackages(): Set<string> {
  try {
    const result = spawnSync("pi", ["list"], { encoding: "utf8", timeout: 5_000 });
    if (result.status !== 0 || !result.stdout) return new Set();
    return new Set(
      result.stdout.split("\n").map(stripPkgEntry).filter(Boolean)
    );
  } catch { return new Set(); }
}

function addToSettings(name: string): void {
  const settings = readSettings();
  const packages = Array.isArray(settings.packages) ? (settings.packages as string[]) : [];
  const entry = `npm:${name}`;
  if (!packages.includes(entry)) {
    packages.push(entry);
    settings.packages = packages;
    writeSettings(settings);
  }
}

function removeFromSettings(name: string): void {
  const settings = readSettings();
  const packages = Array.isArray(settings.packages) ? (settings.packages as string[]) : [];
  settings.packages = packages.filter(
    (p) => p !== `npm:${name}` && p !== name
  );
  writeSettings(settings);
}

// =============================================================================
// Install / uninstall
// =============================================================================

async function installPackages(
  pi: ExtensionAPI,
  names: string[],
  onLine: (line: string) => void
): Promise<Map<string, boolean>> {
  const results        = new Map<string, boolean>();
  const alreadyInstalled = getInstalledPackages();

  for (const name of names) {
    if (alreadyInstalled.has(name)) {
      onLine(`${name} already installed — registering in settings`);
      addToSettings(name);
      results.set(name, true);
      continue;
    }
    onLine(`Installing ${name}…`);
    try {
      const result = await pi.exec("npm", ["install", "-g", name], { timeout: 120_000 });
      if (result.stdout) result.stdout.split("\n").filter(Boolean).forEach(onLine);
      if (result.stderr) result.stderr.split("\n").filter(Boolean).forEach(onLine);
      const ok = result.code === 0;
      if (ok) addToSettings(name);
      results.set(name, ok);
    } catch (e: unknown) {
      onLine(`Error: ${e instanceof Error ? e.message : String(e)}`);
      results.set(name, false);
    }
  }
  return results;
}

async function uninstallPackages(
  pi: ExtensionAPI,
  names: string[],
  onLine: (line: string) => void
): Promise<Map<string, boolean>> {
  const results = new Map<string, boolean>();

  for (const name of names) {
    onLine(`Uninstalling ${name}…`);
    try {
      const result = await pi.exec("npm", ["uninstall", "-g", name], { timeout: 60_000 });
      if (result.stdout) result.stdout.split("\n").filter(Boolean).forEach(onLine);
      if (result.stderr) result.stderr.split("\n").filter(Boolean).forEach(onLine);
      const ok = result.code === 0;
      if (ok) removeFromSettings(name);
      results.set(name, ok);
    } catch (e: unknown) {
      onLine(`Error: ${e instanceof Error ? e.message : String(e)}`);
      results.set(name, false);
    }
  }
  return results;
}

// =============================================================================
// Browser component
// =============================================================================

type ViewMode = "browse" | "manage";

interface BrowserResult {
  action: "install" | "uninstall";
  selected: string[];
}

function createBrowserComponent(
  tui: { requestRender: () => void },
  theme: { fg: (color: string, text: string) => string; bold: (text: string) => string; bg: (color: string, text: string) => string },
  done: (result: BrowserResult | null) => void
) {
  // ── Browse state ──────────────────────────────────────────────────────────
  let viewMode: ViewMode  = "browse";
  let packages: Package[] = [];
  let total               = 0;
  let totalPages          = 1;
  let page                = 1;
  let browseCursor        = 0;
  let query               = "";
  let searchMode          = false;
  let searchBuffer        = "";
  let loading             = false;
  let error               = "";
  let previewPkg: Package | null = null;
  let previewText         = "";
  const browseSelected    = new Set<string>();

  // ── Manage state ──────────────────────────────────────────────────────────
  let managePkgs: string[]  = [];
  let manageCursor          = 0;
  const manageSelected      = new Set<string>();

  // ── Shared ────────────────────────────────────────────────────────────────
  const installed = getInstalledPackages();
  let cachedLines: string[] | undefined;

  function invalidate() { cachedLines = undefined; }
  function refresh()    { invalidate(); tui.requestRender(); }

  // ── Load helpers ──────────────────────────────────────────────────────────

  async function loadPage() {
    loading = true; error = ""; refresh();
    try {
      const result = await searchNpm(query, page);
      packages   = result.packages;
      total      = result.total;
      totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));
      browseCursor = 0;
      previewPkg   = null;
    } catch (e: unknown) {
      error = e instanceof Error ? e.message : String(e);
    } finally {
      loading = false; refresh();
    }
  }

  function loadManage() {
    managePkgs   = getSettingsPackages();
    manageCursor = 0;
    manageSelected.clear();
    refresh();
  }

  async function loadPreview(pkg: Package) {
    previewPkg  = pkg;
    previewText = "Loading readme…";
    refresh();
    const raw   = await fetchReadme(pkg.name);
    previewText = raw ? stripMarkdown(raw).slice(0, 800) : "(no readme available)";
    refresh();
  }

  // Initial load
  loadPage();

  // ── Input ─────────────────────────────────────────────────────────────────

  function handleInput(data: string) {
    // ── Manage view ────────────────────────────────────────────────────────
    if (viewMode === "manage") {
      if (matchesKey(data, Key.escape) || data === "u") {
        viewMode = "browse";
        refresh();
        return;
      }
      if (matchesKey(data, Key.up)) {
        manageCursor = Math.max(0, manageCursor - 1);
        refresh();
        return;
      }
      if (matchesKey(data, Key.down)) {
        manageCursor = Math.min(managePkgs.length - 1, manageCursor + 1);
        refresh();
        return;
      }
      if (data === " ") {
        const name = managePkgs[manageCursor];
        if (!name) return;
        if (manageSelected.has(name)) manageSelected.delete(name);
        else manageSelected.add(name);
        refresh();
        return;
      }
      if (matchesKey(data, Key.enter)) {
        if (manageSelected.size === 0) {
          // Select item under cursor
          const name = managePkgs[manageCursor];
          if (name) manageSelected.add(name);
        }
        done({ action: "uninstall", selected: [...manageSelected] });
        return;
      }
      return;
    }

    // ── Search mode ────────────────────────────────────────────────────────
    if (searchMode) {
      if (matchesKey(data, Key.escape)) {
        searchMode   = false;
        searchBuffer = query;
        refresh();
        return;
      }
      if (matchesKey(data, Key.enter)) {
        query      = searchBuffer.trim();
        searchMode = false;
        page       = 1;
        loadPage();
        return;
      }
      if (matchesKey(data, Key.backspace)) {
        searchBuffer = searchBuffer.slice(0, -1);
        refresh();
        return;
      }
      if (data.length === 1 && data >= " ") {
        searchBuffer += data;
        refresh();
        return;
      }
      return;
    }

    // ── Preview mode ───────────────────────────────────────────────────────
    if (previewPkg) {
      previewPkg = null;
      refresh();
      return;
    }

    // ── Browse mode ────────────────────────────────────────────────────────
    if (matchesKey(data, Key.escape)) { done(null); return; }

    if (matchesKey(data, Key.up)) {
      browseCursor = Math.max(0, browseCursor - 1);
      refresh();
      return;
    }
    if (matchesKey(data, Key.down)) {
      browseCursor = Math.min(packages.length - 1, browseCursor + 1);
      refresh();
      return;
    }
    if (matchesKey(data, Key.right) || data === "n") {
      if (page < totalPages) { page++; loadPage(); }
      return;
    }
    if (matchesKey(data, Key.left) || data === "p") {
      if (page > 1) { page--; loadPage(); }
      return;
    }
    if (data === " ") {
      const pkg = packages[browseCursor];
      if (!pkg) return;
      if (browseSelected.has(pkg.name)) browseSelected.delete(pkg.name);
      else browseSelected.add(pkg.name);
      refresh();
      return;
    }
    if (matchesKey(data, Key.enter)) {
      const pkg = packages[browseCursor];
      if (pkg) loadPreview(pkg);
      return;
    }
    if (data === "i" || data === "I") {
      if (browseSelected.size === 0) {
        const pkg = packages[browseCursor];
        if (pkg) browseSelected.add(pkg.name);
      }
      done({ action: "install", selected: [...browseSelected] });
      return;
    }
    if (data === "/") {
      searchMode   = true;
      searchBuffer = query;
      refresh();
      return;
    }
    if (data === "u" || data === "U") {
      viewMode = "manage";
      loadManage();
      return;
    }
  }

  // ── Render ────────────────────────────────────────────────────────────────

  function render(width: number): string[] {
    if (cachedLines) return cachedLines;
    const lines: string[] = [];
    const add = (s: string) => lines.push(truncateToWidth(s, width));
    const sep = theme.fg("dim", "─".repeat(width));

    if (viewMode === "manage") {
      renderManage(lines, add, sep, width);
    } else {
      renderBrowse(lines, add, sep, width);
    }

    cachedLines = lines;
    return lines;
  }

  function renderBrowse(
    lines: string[],
    add: (s: string) => void,
    sep: string,
    _width: number
  ) {
    add(sep);
    const headerRight = loading
      ? theme.fg("dim", " Loading…")
      : error
      ? theme.fg("error", ` Error: ${error}`)
      : theme.fg("dim", ` ${total.toLocaleString()} pkgs · page ${page}/${totalPages}`);
    add(`${theme.bold(theme.fg("accent", " Pi Extensions"))}${headerRight}   ${theme.fg("dim", "[u]=uninstall packages")}`);
    if (query) add(theme.fg("dim", ` search: `) + theme.fg("warning", query));
    add(sep);

    if (searchMode) {
      add(theme.fg("accent", " /") + searchBuffer + theme.fg("dim", "█"));
      add(theme.fg("dim", " Enter=confirm  Esc=cancel"));
      add(sep);
      return;
    }

    if (previewPkg) {
      const pkg = previewPkg;
      add(theme.bold(theme.fg("success", ` ${pkg.name}`)) +
        (pkg.downloads !== undefined ? theme.fg("dim", `  ${formatDownloads(pkg.downloads)}`) : "") +
        (installed.has(pkg.name) ? theme.fg("success", "  ✓ installed") : ""));
      add(theme.fg("muted", ` ${pkg.description}`));
      lines.push("");
      const textLines = previewText.split("\n");
      for (const l of textLines.slice(0, 20)) add(` ${l}`);
      if (textLines.length > 20) add(theme.fg("dim", ` … (${textLines.length - 20} more lines)`));
      lines.push("");
      if (pkg.npm)    add(theme.fg("dim", " npm:    ") + theme.fg("accent", pkg.npm));
      if (pkg.github) add(theme.fg("dim", " github: ") + theme.fg("accent", pkg.github));
      add(sep);
      add(theme.fg("dim", " Any key to close preview"));
      add(sep);
      return;
    }

    if (loading) {
      add(theme.fg("dim", " Loading…"));
    } else if (packages.length === 0) {
      add(theme.fg("dim", " No packages found"));
    } else {
      for (let i = 0; i < packages.length; i++) {
        const pkg      = packages[i];
        const isCursor = i === browseCursor;
        const isSel    = browseSelected.has(pkg.name);
        const isInst   = installed.has(pkg.name);
        const dlTag    = pkg.downloads !== undefined ? ` ${formatDownloads(pkg.downloads)}` : "";

        if (isCursor) {
          add(theme.bg("selectedBg", theme.fg("text",  ` ${isSel ? "●" : isInst ? "✓" : " "} ${pkg.name}${dlTag}`)));
          add(theme.bg("selectedBg", theme.fg("muted", `   ${pkg.description}`)));
        } else {
          const check = isSel ? theme.fg("accent", "●") : isInst ? theme.fg("success", "✓") : " ";
          const name  = theme.fg(isSel ? "accent" : isInst ? "success" : "text", pkg.name);
          add(` ${check} ${name}${theme.fg("dim", dlTag)}`);
          add(theme.fg("muted", `   ${pkg.description}`));
        }
      }
    }

    add(sep);
    if (browseSelected.size > 0) {
      add(theme.fg("accent", ` ${browseSelected.size} selected: `) + theme.fg("dim", [...browseSelected].join(", ")));
    }
    add(` ${["↑↓=move","Space=select","Enter=preview","←→/n·p=page","i=install","/=search","u=uninstall packages","Esc=exit"].map((h) => theme.fg("dim", h)).join(theme.fg("dim", "  "))}`);
    add(sep);
  }

  function renderManage(
    lines: string[],
    add: (s: string) => void,
    sep: string,
    _width: number
  ) {
    add(sep);
    add(`${theme.bold(theme.fg("warning", " Manage Installed"))}   ${theme.fg("dim", `${managePkgs.length} packages`)}`);
    add(sep);

    if (managePkgs.length === 0) {
      add(theme.fg("dim", " No packages installed"));
    } else {
      for (let i = 0; i < managePkgs.length; i++) {
        const name     = managePkgs[i];
        const isCursor = i === manageCursor;
        const isSel    = manageSelected.has(name);

        if (isCursor) {
          add(theme.bg("selectedBg", theme.fg("text",  ` ${isSel ? "●" : "○"} ${name}`)));
        } else {
          const mark = isSel ? theme.fg("error", "●") : theme.fg("dim", "○");
          add(` ${mark} ${theme.fg("text", name)}`);
        }
      }
    }

    add(sep);
    if (manageSelected.size > 0) {
      add(theme.fg("error", ` ${manageSelected.size} to remove: `) + theme.fg("dim", [...manageSelected].join(", ")));
    }
    add(` ${["↑↓=move","Space=select","Enter=uninstall","u·Esc=back"].map((h) => theme.fg("dim", h)).join(theme.fg("dim", "  "))}`);
    add(sep);
  }

  return { render, invalidate, handleInput };
}

// =============================================================================
// Command handler
// =============================================================================

type PiCtx = {
  hasUI: boolean;
  ui: {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    custom: <T>(cb: (...args: any[]) => any) => Promise<T | null>;
    notify: (msg: string, level: string) => void;
    confirm: (title: string, msg: string) => Promise<boolean>;
  };
};

async function runExtensionsCommand(pi: ExtensionAPI, ctx: PiCtx): Promise<void> {
  if (!ctx.hasUI) {
    ctx.ui.notify("Extensions browser requires interactive mode.", "error");
    return;
  }

  const result = await ctx.ui.custom<BrowserResult | null>(
    (tui: { requestRender: () => void }, theme: { fg: (c: string, t: string) => string; bold: (t: string) => string; bg: (c: string, t: string) => string }, _kb: unknown, done: (v: BrowserResult | null) => void) =>
      createBrowserComponent(tui, theme, done)
  );

  if (!result) return;

  if (result.action === "install" && result.selected.length > 0) {
    const confirmed = await ctx.ui.confirm("Install packages?", result.selected.join(", "));
    if (!confirmed) return;

    ctx.ui.notify(`Installing ${result.selected.length} package(s)…`, "info");
    const results = await installPackages(pi, result.selected, (l) => ctx.ui.notify(l, "info"));
    const failed  = [...results.entries()].filter(([, ok]) => !ok).map(([n]) => n);
    const success = [...results.entries()].filter(([, ok]) =>  ok).map(([n]) => n);
    if (success.length) ctx.ui.notify(`✓ Installed: ${success.join(", ")}`, "info");
    if (failed.length)  ctx.ui.notify(`✗ Failed: ${failed.join(", ")}`, "error");
    if (success.length) ctx.ui.notify("Run /reload to activate newly installed extensions.", "info");
  }

  if (result.action === "uninstall" && result.selected.length > 0) {
    const confirmed = await ctx.ui.confirm(
      "Uninstall packages?",
      `This will remove: ${result.selected.join(", ")}`
    );
    if (!confirmed) return;

    ctx.ui.notify(`Uninstalling ${result.selected.length} package(s)…`, "info");
    const results = await uninstallPackages(pi, result.selected, (l) => ctx.ui.notify(l, "info"));
    const failed  = [...results.entries()].filter(([, ok]) => !ok).map(([n]) => n);
    const success = [...results.entries()].filter(([, ok]) =>  ok).map(([n]) => n);
    if (success.length) ctx.ui.notify(`✓ Removed: ${success.join(", ")}`, "info");
    if (failed.length)  ctx.ui.notify(`✗ Failed: ${failed.join(", ")}`, "error");
    if (success.length) ctx.ui.notify("Run /reload to apply changes.", "info");
  }
}

// =============================================================================
// Extension entry point
// =============================================================================

export default function (pi: ExtensionAPI): void {
  pi.registerCommand("extensions", {
    description: "Browse and install Pi community packages",
    handler: async (_args, ctx) => {
      await runExtensionsCommand(pi, ctx as unknown as PiCtx);
    },
  });
}
