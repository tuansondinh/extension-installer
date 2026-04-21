import { spawn } from "child_process";

// =============================================================================
// Types
// =============================================================================

interface PiUi {
  input(prompt: string): Promise<string>;
  confirm(message: string): Promise<boolean>;
}

interface PiContext {
  ui: PiUi;
  notify(message: string): void;
  registerCommand(name: string, description: string, handler: () => Promise<void>): void;
}

// A package entry as used throughout the UI. IDs are 1-based within the
// current page, so they reset on every page/search change.
interface Package {
  id: number;
  name: string;
  description: string;
  npm?: string;    // npmjs.com URL
  github?: string; // GitHub repo URL
}

// Partial shape of the npm registry search response we care about.
interface NpmSearchObject {
  package: {
    name: string;
    description?: string;
    links: {
      npm?: string;
      repository?: string;
    };
  };
}

interface NpmSearchResponse {
  total: number;
  objects: NpmSearchObject[];
}

// =============================================================================
// ANSI / terminal helpers
// =============================================================================

const RESET  = "\x1b[0m";
const BOLD   = "\x1b[1m";
const DIM    = "\x1b[2m";
const CYAN   = "\x1b[36m";
const YELLOW = "\x1b[33m";
const GREEN  = "\x1b[32m";
const RED    = "\x1b[31m";

// OSC 8 terminal hyperlinks — clickable in iTerm2, Kitty, VS Code terminal,
// modern gnome-terminal. Invisible escape sequences in unsupported terminals,
// so the URL text still shows and remains copy-pasteable.
function hyperlink(label: string, url: string): string {
  return `\x1b]8;;${url}\x1b\\${label}\x1b]8;;\x1b\\`;
}

function rule(): string {
  return `${DIM}  ${"─".repeat(62)}${RESET}`;
}

// Word-wrap at `width` chars. Needed for readme previews and narrow terminals.
function wrapText(text: string, width: number): string[] {
  const words = text.split(" ");
  const lines: string[] = [];
  let current = "";

  for (const word of words) {
    const wouldFit = current.length + (current ? 1 : 0) + word.length <= width;
    if (current && !wouldFit) {
      lines.push(current);
      current = word;
    } else {
      current = current ? `${current} ${word}` : word;
    }
  }
  if (current) lines.push(current);
  return lines;
}

// =============================================================================
// Curated fallback packages
// Shown when the npm registry is unreachable. Kept in sync with the npm
// keyword `pi-package` — update as new notable packages appear.
// =============================================================================

const FALLBACK: Omit<Package, "id">[] = [
  {
    name: "@nicopreme/pi-subagents",
    description: "Delegate tasks to subagents with chains & parallel execution",
    npm: "https://www.npmjs.com/package/@nicopreme/pi-subagents",
  },
  {
    name: "@nicopreme/pi-web",
    description: "Web search, URL fetch, GitHub clone, PDF, YouTube",
    npm: "https://www.npmjs.com/package/@nicopreme/pi-web",
  },
  {
    name: "@nicopreme/pi-dev-pipeline",
    description: "TDD, code review, architecture workflows",
    npm: "https://www.npmjs.com/package/@nicopreme/pi-dev-pipeline",
  },
  {
    name: "@plannotator/pi-extension",
    description: "Plan mode with browser UI for review/approval",
    npm: "https://www.npmjs.com/package/@plannotator/pi-extension",
  },
  {
    name: "@aliou/pi-extension-dev",
    description: "Tools for developing & updating extensions",
    npm: "https://www.npmjs.com/package/@aliou/pi-extension-dev",
  },
  {
    name: "git:github.com/ruizrica/agent-pi",
    description: "43 extensions — multi-agent orchestration suite",
    github: "https://github.com/ruizrica/agent-pi",
  },
  {
    name: "git:github.com/sids/pi-extensions",
    description: "plan-md, diff review, subagent delegation",
    github: "https://github.com/sids/pi-extensions",
  },
  {
    name: "git:github.com/badlogic/pi-doom",
    description: "Doom. In your terminal. While you wait.",
    github: "https://github.com/badlogic/pi-doom",
  },
];

// =============================================================================
// npm registry API
// =============================================================================

const PAGE_SIZE = 20;
const NPM_SEARCH = "https://registry.npmjs.org/-/v1/search";
const NPM_PKG    = "https://registry.npmjs.org"; // /<name> for full doc + readme

// Searches npm for packages tagged `keywords:pi-package`, optionally filtered
// by an extra query string. Results are ordered by popularity (download weight
// = 1, quality = 0, maintenance = 0) — the closest the search API gets to
// "most downloaded" without making per-package download-count requests.
async function searchNpm(
  query: string,
  page: number
): Promise<{ packages: Package[]; total: number }> {
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

  const packages: Package[] = data.objects.map((obj, i) => {
    const repo   = obj.package.links.repository ?? "";
    const github = repo.includes("github.com") ? repo : undefined;

    return {
      id:          i + 1,
      name:        obj.package.name,
      description: obj.package.description ?? "(no description)",
      npm:         obj.package.links.npm,
      github,
    };
  });

  return { packages, total: data.total };
}

// Fetches the readme for a single package from the full npm package document.
// This is intentionally lazy — only called when the user opens a detail pane —
// to avoid hammering the registry on every page load.
// Returns null if the fetch fails or the package has no readme.
async function fetchReadme(packageName: string): Promise<string | null> {
  try {
    const res = await fetch(`${NPM_PKG}/${encodeURIComponent(packageName)}`, {
      headers: { Accept: "application/json" },
      signal:  AbortSignal.timeout(8_000),
    });
    if (!res.ok) return null;
    const data = (await res.json()) as { readme?: string };
    return data.readme ?? null;
  } catch {
    return null;
  }
}

// =============================================================================
// Catalog page view
// =============================================================================

function renderPage(
  packages: Package[],
  page: number,
  totalPages: number,
  total: number,
  query: string
): string {
  const queryTag = query ? `  ${DIM}· filter: "${query}"${RESET}` : "";
  const pageTag  = `${DIM}${total.toLocaleString()} packages · page ${page}/${totalPages}${RESET}`;

  const lines: string[] = [
    "",
    `${BOLD}${CYAN}  Pi Extensions${RESET}   ${pageTag}${queryTag}`,
    rule(),
    "",
  ];

  for (const pkg of packages) {
    lines.push(`    ${BOLD}${pkg.id}${RESET}  ${GREEN}${pkg.name}${RESET}`);
    lines.push(`       ${DIM}${pkg.description}${RESET}`);
  }

  lines.push("");
  lines.push(rule());
  // Keep the hint compact — one line, tab-separated so it reads as a quick ref.
  lines.push(
    `${DIM}  n·p=page   ?<n>=preview   1,3,5=install   /<terms>=search   ↵=exit${RESET}`
  );
  lines.push("");

  return lines.join("\n");
}

// =============================================================================
// Detail pane  (readme fetched on demand)
// =============================================================================

async function showDetail(pkg: Package, notify: (msg: string) => void): Promise<void> {
  notify(`${DIM}  Fetching readme…${RESET}`);

  const raw = await fetchReadme(pkg.name);

  // Strip the most common markdown syntax for a readable plain-text preview.
  // We don't need a full markdown parser here — stripping headers, fences,
  // and inline links is enough to make the first ~600 chars usable.
  const readme = raw
    ? raw
        .replace(/^#{1,6}\s+/gm, "")             // ## headers
        .replace(/```[\s\S]*?```/gm, "[code]")   // fenced code blocks
        .replace(/`[^`]+`/g, (m) => m.slice(1, -1)) // inline code
        .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1") // [label](url) → label
        .replace(/\n{3,}/g, "\n\n")              // collapse blank lines
        .trim()
        .slice(0, 600)
    : "(no readme available)";

  const truncated = raw && raw.length > 600;

  const lines: string[] = [
    "",
    rule(),
    `  ${BOLD}${GREEN}${pkg.name}${RESET}`,
    "",
    ...wrapText(readme, 60).map((line) => `  ${line}`),
  ];

  if (truncated) lines.push(`  ${DIM}… (truncated — full readme on npm)${RESET}`);
  lines.push("");

  if (pkg.npm || pkg.github) {
    lines.push(`  ${BOLD}Links${RESET}`);
    if (pkg.npm)    lines.push(`    npm     ${CYAN}${hyperlink(pkg.npm, pkg.npm)}${RESET}`);
    if (pkg.github) lines.push(`    GitHub  ${CYAN}${hyperlink(pkg.github, pkg.github)}${RESET}`);
    lines.push("");
  }

  lines.push(`  ${BOLD}Install${RESET}`);
  lines.push(`    ${DIM}pi install ${pkg.name}${RESET}`);
  lines.push("");
  lines.push(rule());
  lines.push("");

  notify(lines.join("\n"));
}

// =============================================================================
// Selection parsing
// =============================================================================

// IDs are relative to the current page, so we resolve against `currentPage`.
function parseSelection(input: string, currentPage: Package[]): Package[] {
  const ids = input
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
    .map(Number)
    .filter((n) => Number.isInteger(n));

  const seen     = new Set<number>();
  const selected: Package[] = [];

  for (const id of ids) {
    if (seen.has(id)) continue;
    seen.add(id);
    const pkg = currentPage.find((p) => p.id === id);
    if (pkg) selected.push(pkg);
  }

  return selected;
}

// =============================================================================
// Installation
// =============================================================================

async function installPackage(
  pkg: Package,
  notify: (msg: string) => void
): Promise<boolean> {
  notify(`${BOLD}Installing${RESET} ${GREEN}${pkg.name}${RESET} …`);

  return new Promise<boolean>((resolve) => {
    const child = spawn("pi", ["install", pkg.name], {
      stdio: ["ignore", "pipe", "pipe"],
      shell: false,
    });

    child.stdout.on("data", (chunk: Buffer) =>
      chunk.toString().split("\n").filter(Boolean).forEach((l) =>
        notify(`  ${DIM}${l}${RESET}`)
      )
    );

    // pi install writes progress to stderr, so show it rather than suppress it.
    child.stderr.on("data", (chunk: Buffer) =>
      chunk.toString().split("\n").filter(Boolean).forEach((l) =>
        notify(`  ${RED}${l}${RESET}`)
      )
    );

    child.on("close", (code) => resolve(code === 0));
    child.on("error", (err) => {
      notify(`  ${RED}Could not spawn pi: ${err.message}${RESET}`);
      resolve(false);
    });
  });
}

// =============================================================================
// Command handler
// =============================================================================

async function extensionsCommand(ctx: PiContext): Promise<void> {
  // Mutable browsing state — updated by loadPage() and user commands.
  let page           = 1;
  let query          = "";
  let currentPage:     Package[] = [];
  let totalPages     = 1;
  let total          = 0;

  // Fetches the current (page, query) combination from npm, updates state,
  // and re-renders the catalog. Returns false on network failure.
  async function loadPage(): Promise<boolean> {
    ctx.notify(`${DIM}  Loading…${RESET}`);
    try {
      const result = await searchNpm(query, page);
      currentPage  = result.packages;
      total        = result.total;
      totalPages   = Math.max(1, Math.ceil(total / PAGE_SIZE));
      ctx.notify(renderPage(currentPage, page, totalPages, total, query));
      return true;
    } catch {
      ctx.notify(`${RED}  Network error — could not reach npm.${RESET}`);
      return false;
    }
  }

  // ── Initial load ───────────────────────────────────────────────────────────
  ctx.notify(`${DIM}  Fetching packages from npm…${RESET}`);
  const online = await loadPage();

  // If npm was unreachable on the very first load, fall back to the curated
  // list so the user still has something useful to work with.
  if (!online) {
    ctx.notify(`${YELLOW}  Showing curated offline picks instead.${RESET}`);
    currentPage = FALLBACK.map((p, i) => ({ ...p, id: i + 1 }));
    total       = currentPage.length;
    totalPages  = 1;
    ctx.notify(renderPage(currentPage, page, totalPages, total, query));
  }

  // ── Browse loop ────────────────────────────────────────────────────────────
  // Stays open until the user enters a valid selection list (1,3,5) or blanks.
  // Navigation and preview commands loop back without breaking out.
  let selected: Package[] = [];

  while (true) {
    const raw     = await ctx.ui.input("→");
    const trimmed = raw.trim();

    // blank → exit
    if (!trimmed) {
      ctx.notify(`${DIM}Exiting.${RESET}`);
      return;
    }

    // n → next page
    if (trimmed === "n") {
      if (page >= totalPages) {
        ctx.notify(`${YELLOW}  Already on the last page.${RESET}`);
        continue;
      }
      page++;
      await loadPage();
      continue;
    }

    // p → previous page
    if (trimmed === "p") {
      if (page <= 1) {
        ctx.notify(`${YELLOW}  Already on the first page.${RESET}`);
        continue;
      }
      page--;
      await loadPage();
      continue;
    }

    // /<terms> → filter search, reset to page 1
    if (trimmed.startsWith("/")) {
      query = trimmed.slice(1).trim();
      page  = 1;
      await loadPage();
      continue;
    }

    // ?<n> → open detail pane for item n on the current page, then loop back
    const previewMatch = trimmed.match(/^\?(\d+)$/);
    if (previewMatch) {
      const id  = parseInt(previewMatch[1], 10);
      const pkg = currentPage.find((p) => p.id === id);
      if (pkg) {
        await showDetail(pkg, ctx.notify.bind(ctx));
      } else {
        ctx.notify(`${RED}  No item ${id} on this page.${RESET}`);
      }
      continue;
    }

    // 1,3,5 → parse as a selection list and break out of the browse loop
    selected = parseSelection(trimmed, currentPage);
    if (selected.length === 0) {
      ctx.notify(
        `${RED}  Unknown input. Use n/p (pages), ?3 (preview), 1,3,5 (install), /doom (search).${RESET}`
      );
      continue;
    }

    break;
  }

  // ── Confirm ────────────────────────────────────────────────────────────────
  const summary = selected.map((p) => `  • ${GREEN}${p.name}${RESET}`).join("\n");
  ctx.notify(`\n${BOLD}You selected:${RESET}\n${summary}\n`);

  const confirmed = await ctx.ui.confirm("Proceed with installation?");
  if (!confirmed) {
    ctx.notify(`${DIM}Installation cancelled.${RESET}`);
    return;
  }

  // ── Install ────────────────────────────────────────────────────────────────
  const results: Array<{ pkg: Package; ok: boolean }> = [];

  for (const pkg of selected) {
    const ok = await installPackage(pkg, ctx.notify.bind(ctx));
    results.push({ pkg, ok });
  }

  // ── Report ─────────────────────────────────────────────────────────────────
  ctx.notify(`\n${BOLD}Results${RESET}`);
  ctx.notify(`${DIM}  ${"─".repeat(38)}${RESET}`);

  for (const { pkg, ok } of results) {
    const icon   = ok ? `${GREEN}✓${RESET}` : `${RED}✗${RESET}`;
    const status = ok ? `${GREEN}installed${RESET}` : `${RED}failed${RESET}`;
    ctx.notify(`  ${icon}  ${pkg.name}  ${DIM}(${status})${RESET}`);
  }

  ctx.notify("");

  const failures = results.filter((r) => !r.ok);
  if (failures.length === 0) {
    ctx.notify(`${GREEN}${BOLD}All packages installed successfully.${RESET}`);
  } else {
    ctx.notify(`${YELLOW}${failures.length} package(s) failed. Retry with:${RESET}`);
    for (const { pkg } of failures) {
      ctx.notify(`  ${DIM}pi install ${pkg.name}${RESET}`);
    }
  }
}

// =============================================================================
// Extension entry point
// =============================================================================

export default function register(ctx: PiContext): void {
  ctx.registerCommand(
    "/extensions",
    "Browse and install Pi community packages",
    () => extensionsCommand(ctx)
  );
}
