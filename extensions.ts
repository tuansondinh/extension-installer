import { execSync, spawn } from "child_process";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface PiUi {
  input(prompt: string): Promise<string>;
  confirm(message: string): Promise<boolean>;
}

interface PiContext {
  ui: PiUi;
  notify(message: string): void;
  registerCommand(name: string, description: string, handler: () => Promise<void>): void;
}

// ---------------------------------------------------------------------------
// Package catalog
// ---------------------------------------------------------------------------

interface Package {
  id: number;
  name: string;
  category: string;
  description: string;
}

const PACKAGES: Package[] = [
  // Agents
  {
    id: 1,
    name: "@nicopreme/pi-subagents",
    category: "Agents",
    description: "Delegate tasks to subagents with chains & parallel execution",
  },
  {
    id: 6,
    name: "git:github.com/ruizrica/agent-pi",
    category: "Agents",
    description: "43 extensions — multi-agent orchestration suite",
  },
  {
    id: 7,
    name: "git:github.com/sids/pi-extensions",
    category: "Agents",
    description: "plan-md, diff review, subagent delegation",
  },
  // Web / Research
  {
    id: 2,
    name: "@nicopreme/pi-web",
    category: "Web/Research",
    description: "Web search, URL fetch, GitHub clone, PDF, YouTube",
  },
  // Code Quality
  {
    id: 3,
    name: "@nicopreme/pi-dev-pipeline",
    category: "Code Quality",
    description: "TDD, code review, architecture workflows",
  },
  // Workflow
  {
    id: 4,
    name: "@plannotator/pi-extension",
    category: "Workflow",
    description: "Plan mode with browser UI for review/approval",
  },
  {
    id: 5,
    name: "@aliou/pi-extension-dev",
    category: "Workflow",
    description: "Tools for developing & updating extensions",
  },
  // Fun
  {
    id: 8,
    name: "git:github.com/badlogic/pi-doom",
    category: "Fun",
    description: "Doom. In your terminal. While you wait.",
  },
];

const CATEGORY_ORDER = ["Agents", "Web/Research", "Code Quality", "Workflow", "Fun"];

// ---------------------------------------------------------------------------
// TUI rendering
// ---------------------------------------------------------------------------

const RESET  = "\x1b[0m";
const BOLD   = "\x1b[1m";
const DIM    = "\x1b[2m";
const CYAN   = "\x1b[36m";
const YELLOW = "\x1b[33m";
const GREEN  = "\x1b[32m";
const RED    = "\x1b[31m";

function renderCatalog(): string {
  const lines: string[] = [
    "",
    `${BOLD}${CYAN}  Pi Community Extensions${RESET}`,
    `${DIM}  ─────────────────────────────────────────────────────────────${RESET}`,
  ];

  const byCategory = new Map<string, Package[]>();
  for (const pkg of PACKAGES) {
    if (!byCategory.has(pkg.category)) byCategory.set(pkg.category, []);
    byCategory.get(pkg.category)!.push(pkg);
  }

  for (const category of CATEGORY_ORDER) {
    const pkgs = byCategory.get(category);
    if (!pkgs) continue;

    lines.push("");
    lines.push(`  ${BOLD}${YELLOW}${category}${RESET}`);

    for (const pkg of pkgs) {
      const num   = `${BOLD}${pkg.id}${RESET}`.padEnd(2);
      const name  = `${GREEN}${pkg.name}${RESET}`;
      const desc  = `${DIM}${pkg.description}${RESET}`;
      lines.push(`    ${num}  ${name}`);
      lines.push(`         ${desc}`);
    }
  }

  lines.push("");
  lines.push(`${DIM}  ─────────────────────────────────────────────────────────────${RESET}`);
  lines.push("");

  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Selection parsing
// ---------------------------------------------------------------------------

function parseSelection(input: string): Package[] {
  const ids = input
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
    .map(Number)
    .filter((n) => !isNaN(n));

  const selected: Package[] = [];
  const seen = new Set<number>();

  for (const id of ids) {
    if (seen.has(id)) continue;
    seen.add(id);
    const pkg = PACKAGES.find((p) => p.id === id);
    if (pkg) selected.push(pkg);
  }

  return selected;
}

// ---------------------------------------------------------------------------
// Installation
// ---------------------------------------------------------------------------

function installPackage(pkg: Package, notify: (msg: string) => void): boolean {
  notify(`${BOLD}Installing${RESET} ${GREEN}${pkg.name}${RESET} …`);

  return new Promise<boolean>((resolve) => {
    const child = spawn("pi", ["install", pkg.name], {
      stdio: ["ignore", "pipe", "pipe"],
      shell: false,
    });

    child.stdout.on("data", (chunk: Buffer) => {
      for (const line of chunk.toString().split("\n").filter(Boolean)) {
        notify(`  ${DIM}${line}${RESET}`);
      }
    });

    child.stderr.on("data", (chunk: Buffer) => {
      for (const line of chunk.toString().split("\n").filter(Boolean)) {
        notify(`  ${RED}${line}${RESET}`);
      }
    });

    child.on("close", (code) => resolve(code === 0));
    child.on("error", (err) => {
      notify(`  ${RED}Failed to spawn pi: ${err.message}${RESET}`);
      resolve(false);
    });
  }) as unknown as boolean;
}

// ---------------------------------------------------------------------------
// Command handler
// ---------------------------------------------------------------------------

async function extensionsCommand(ctx: PiContext): Promise<void> {
  ctx.notify(renderCatalog());

  // --- Selection ---
  const raw = await ctx.ui.input(
    "Enter package numbers to install (comma-separated, e.g. 1,3,5):"
  );

  if (!raw.trim()) {
    ctx.notify(`${DIM}No selection made. Exiting.${RESET}`);
    return;
  }

  const selected = parseSelection(raw);

  if (selected.length === 0) {
    ctx.notify(`${RED}No valid package numbers found in your input.${RESET}`);
    return;
  }

  // --- Confirmation ---
  const summary = selected
    .map((p) => `  • ${GREEN}${p.name}${RESET}`)
    .join("\n");

  ctx.notify(`\n${BOLD}You selected:${RESET}\n${summary}\n`);

  const ok = await ctx.ui.confirm("Proceed with installation?");
  if (!ok) {
    ctx.notify(`${DIM}Installation cancelled.${RESET}`);
    return;
  }

  // --- Install ---
  const results: Array<{ pkg: Package; ok: boolean }> = [];

  for (const pkg of selected) {
    const success = await (installPackage(pkg, ctx.notify) as unknown as Promise<boolean>);
    results.push({ pkg, ok: success });
  }

  // --- Report ---
  ctx.notify(`\n${BOLD}Results${RESET}`);
  ctx.notify(`${DIM}──────────────────────────────────────${RESET}`);
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
    ctx.notify(
      `${YELLOW}${failures.length} package(s) failed. You can retry them manually with:${RESET}`
    );
    for (const { pkg } of failures) {
      ctx.notify(`  ${DIM}pi install ${pkg.name}${RESET}`);
    }
  }
}

// ---------------------------------------------------------------------------
// Extension entry point
// ---------------------------------------------------------------------------

export default function register(ctx: PiContext): void {
  ctx.registerCommand(
    "/extensions",
    "Browse and install curated Pi community packages",
    () => extensionsCommand(ctx)
  );
}
