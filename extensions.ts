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

// A package in the curated catalog.
interface Package {
  id: number;
  name: string;        // exact string passed to `pi install`
  category: string;
  description: string; // one-liner shown in the catalog list
  readme: string;      // paragraph shown in the detail pane
  npm?: string;        // npmjs.com URL — present for @scope/pkg packages
  github?: string;     // GitHub repo URL — present for git: packages (derived from name)
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

// OSC 8 is the de-facto standard for terminal hyperlinks (RFC-like).
// Supported by iTerm2, Kitty, VS Code integrated terminal, modern gnome-terminal.
// In unsupported terminals the escape sequences are invisible, so it degrades
// gracefully to plain text — the URL is still visible right below.
// Format:  ESC ] 8 ; <params> ; <uri>  ST  <label>  ESC ] 8 ; ;  ST
// where ST (String Terminator) is ESC followed by backslash.
function hyperlink(label: string, url: string): string {
  return `\x1b]8;;${url}\x1b\\${label}\x1b]8;;\x1b\\`;
}

// A horizontal rule sized to fit the catalog layout.
function rule(): string {
  return `${DIM}  ${"─".repeat(62)}${RESET}`;
}

// Naive word-wrap at `width` characters. We need this because readme strings
// are long prose and terminals may be narrow — better to wrap in code than
// rely on the terminal's own wrapping, which can split mid-word.
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
// Curated package catalog
// =============================================================================

const PACKAGES: Package[] = [

  // ── Agents ─────────────────────────────────────────────────────────────────

  {
    id: 1,
    name: "@nicopreme/pi-subagents",
    category: "Agents",
    description: "Delegate tasks to subagents with chains & parallel execution",
    readme:
      "Lets you spin up parallel or chained sub-agents from within a Pi session. " +
      "Define agent chains in YAML or JSON, pass a goal, and the orchestrator " +
      "breaks it into sub-tasks dispatched to separate Pi instances. Results are " +
      "merged back and surfaced as a single response.",
    npm: "https://www.npmjs.com/package/@nicopreme/pi-subagents",
  },

  {
    id: 6,
    name: "git:github.com/ruizrica/agent-pi",
    category: "Agents",
    description: "43 extensions — multi-agent orchestration suite",
    readme:
      "A mega-bundle of 43 extensions covering multi-agent orchestration: task " +
      "decomposition, role assignment, result aggregation, and a supervisor agent " +
      "that monitors sub-agent health and retries failures automatically.",
    github: "https://github.com/ruizrica/agent-pi",
  },

  {
    id: 7,
    name: "git:github.com/sids/pi-extensions",
    category: "Agents",
    description: "plan-md, diff review, subagent delegation",
    readme:
      "A focused set of extensions: plan-md saves Pi plans as markdown files for " +
      "version control, diff-review does stage-aware code review, and delegate " +
      "forwards sub-tasks to a fresh Pi agent and collects the results.",
    github: "https://github.com/sids/pi-extensions",
  },

  // ── Web / Research ──────────────────────────────────────────────────────────

  {
    id: 2,
    name: "@nicopreme/pi-web",
    category: "Web/Research",
    description: "Web search, URL fetch, GitHub clone, PDF, YouTube",
    readme:
      "Adds web-aware tools: keyword search (returns ranked snippets), full-page " +
      "fetch (returns cleaned markdown), GitHub repo clone, PDF text extraction, " +
      "and YouTube transcript retrieval. All results feed directly into Pi's context.",
    npm: "https://www.npmjs.com/package/@nicopreme/pi-web",
  },

  // ── Code Quality ────────────────────────────────────────────────────────────

  {
    id: 3,
    name: "@nicopreme/pi-dev-pipeline",
    category: "Code Quality",
    description: "TDD, code review, architecture workflows",
    readme:
      "Brings structured engineering workflows: test-driven development (write " +
      "failing test → implement → verify), automated code review with linting " +
      "and smell detection, and architecture review via dependency graphs and " +
      "coupling analysis.",
    npm: "https://www.npmjs.com/package/@nicopreme/pi-dev-pipeline",
  },

  // ── Workflow ────────────────────────────────────────────────────────────────

  {
    id: 4,
    name: "@plannotator/pi-extension",
    category: "Workflow",
    description: "Plan mode with browser UI for review/approval",
    readme:
      "Intercepts Pi's plan mode and exposes the plan in a local browser UI. " +
      "You read and approve — or reject with comments — each step before Pi " +
      "executes it, giving fine-grained human-in-the-loop control over agentic runs.",
    npm: "https://www.npmjs.com/package/@plannotator/pi-extension",
  },

  {
    id: 5,
    name: "@aliou/pi-extension-dev",
    category: "Workflow",
    description: "Tools for developing & updating extensions",
    readme:
      "A developer toolkit for building Pi extensions. Includes a live-reload " +
      "watcher, scaffolding command, type-checking helpers, and an in-session " +
      "tester so you can iterate on extensions without restarting Pi.",
    npm: "https://www.npmjs.com/package/@aliou/pi-extension-dev",
  },

  // ── Fun ─────────────────────────────────────────────────────────────────────

  {
    id: 8,
    name: "git:github.com/badlogic/pi-doom",
    category: "Fun",
    description: "Doom. In your terminal. While you wait.",
    readme:
      "Runs a WebAssembly port of Doom in your terminal using ASCII art while Pi " +
      "processes a long-running task. Installs a hook that starts the game when a " +
      "task begins and stops it on completion. rip and tear.",
    github: "https://github.com/badlogic/pi-doom",
  },
];

// Determines the order sections appear in the catalog view.
const CATEGORY_ORDER = ["Agents", "Web/Research", "Code Quality", "Workflow", "Fun"];

// =============================================================================
// Catalog view  —  the main list shown on /extensions
// =============================================================================

function renderCatalog(): string {
  const lines: string[] = [
    "",
    `${BOLD}${CYAN}  Pi Community Extensions${RESET}`,
    rule(),
  ];

  // Group packages by category, preserving catalog order within each group.
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
      lines.push(`    ${BOLD}${pkg.id}${RESET}  ${GREEN}${pkg.name}${RESET}`);
      lines.push(`       ${DIM}${pkg.description}${RESET}`);
    }
  }

  lines.push("");
  lines.push(rule());
  lines.push(`${DIM}  Preview a package: ?2    Install packages: 1,3,5    Cancel: (blank)${RESET}`);
  lines.push("");

  return lines.join("\n");
}

// =============================================================================
// Detail pane  —  shown when the user types ?<n>
// =============================================================================

function renderDetail(pkg: Package): string {
  const lines: string[] = [
    "",
    rule(),
    `  ${BOLD}${GREEN}${pkg.name}${RESET}   ${DIM}[${pkg.category}]${RESET}`,
    "",
    // Wrap the readme to 60 chars so it stays readable in narrow terminals.
    ...wrapText(pkg.readme, 60).map((line) => `  ${line}`),
    "",
  ];

  // Only render the Links section when we actually have at least one URL.
  if (pkg.npm || pkg.github) {
    lines.push(`  ${BOLD}Links${RESET}`);
    if (pkg.npm) {
      // The hyperlink() call makes the URL clickable; in terminals that don't
      // support OSC 8 the URL text is still visible and copy-pasteable.
      lines.push(`    npm     ${CYAN}${hyperlink(pkg.npm, pkg.npm)}${RESET}`);
    }
    if (pkg.github) {
      lines.push(`    GitHub  ${CYAN}${hyperlink(pkg.github, pkg.github)}${RESET}`);
    }
    lines.push("");
  }

  lines.push(`  ${BOLD}Install command${RESET}`);
  lines.push(`    ${DIM}pi install ${pkg.name}${RESET}`);
  lines.push("");
  lines.push(rule());
  lines.push("");

  return lines.join("\n");
}

// =============================================================================
// Selection parsing
// =============================================================================

// Accepts "1,3, 5" style input, deduplicates, ignores unknown ids.
function parseSelection(input: string): Package[] {
  const ids = input
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
    .map(Number)
    // Reject NaN and non-integers (e.g. "1.5") — user likely made a typo.
    .filter((n) => Number.isInteger(n));

  const seen = new Set<number>();
  const selected: Package[] = [];

  for (const id of ids) {
    if (seen.has(id)) continue;
    seen.add(id);
    const pkg = PACKAGES.find((p) => p.id === id);
    if (pkg) selected.push(pkg);
  }

  return selected;
}

// =============================================================================
// Installation
// =============================================================================

// Spawns `pi install <name>` and streams its stdout/stderr back via notify.
// Returns true if the process exited with code 0, false otherwise.
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

    child.stdout.on("data", (chunk: Buffer) => {
      chunk.toString().split("\n").filter(Boolean).forEach((line) =>
        notify(`  ${DIM}${line}${RESET}`)
      );
    });

    child.stderr.on("data", (chunk: Buffer) => {
      // pi install writes progress to stderr, so we show it rather than hide it.
      chunk.toString().split("\n").filter(Boolean).forEach((line) =>
        notify(`  ${RED}${line}${RESET}`)
      );
    });

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
  ctx.notify(renderCatalog());

  // ── Selection loop ──────────────────────────────────────────────────────────
  // We loop here so the user can open as many detail panes as they like before
  // committing to an install list. Each iteration either:
  //   ?<n>   → shows the detail pane for package n, then prompts again
  //   1,3,5  → parsed as a selection list, breaks out of the loop
  //   (blank) → cancels and exits

  let selected: Package[] = [];

  while (true) {
    const raw = await ctx.ui.input(
      "Select packages (e.g. 1,3,5) or preview one (e.g. ?2):"
    );
    const trimmed = raw.trim();

    if (!trimmed) {
      ctx.notify(`${DIM}No selection made. Exiting.${RESET}`);
      return;
    }

    // ?<n> → detail pane, then loop back.
    const previewMatch = trimmed.match(/^\?(\d+)$/);
    if (previewMatch) {
      const id  = parseInt(previewMatch[1], 10);
      const pkg = PACKAGES.find((p) => p.id === id);
      ctx.notify(pkg ? renderDetail(pkg) : `${RED}No package with id ${id}.${RESET}\n`);
      continue;
    }

    // Otherwise treat as a selection list.
    selected = parseSelection(trimmed);
    if (selected.length === 0) {
      ctx.notify(
        `${RED}No valid package numbers found — try again, or leave blank to exit.${RESET}`
      );
      continue;
    }

    break; // valid selection obtained
  }

  // ── Confirmation ────────────────────────────────────────────────────────────

  const summary = selected.map((p) => `  • ${GREEN}${p.name}${RESET}`).join("\n");
  ctx.notify(`\n${BOLD}You selected:${RESET}\n${summary}\n`);

  const confirmed = await ctx.ui.confirm("Proceed with installation?");
  if (!confirmed) {
    ctx.notify(`${DIM}Installation cancelled.${RESET}`);
    return;
  }

  // ── Install ─────────────────────────────────────────────────────────────────

  const results: Array<{ pkg: Package; ok: boolean }> = [];

  for (const pkg of selected) {
    const ok = await installPackage(pkg, ctx.notify.bind(ctx));
    results.push({ pkg, ok });
  }

  // ── Report ──────────────────────────────────────────────────────────────────

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
    "Browse and install curated Pi community packages",
    () => extensionsCommand(ctx)
  );
}
