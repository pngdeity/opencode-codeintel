#!/usr/bin/env bun
// codeintel — the installer and diagnostic entry point for
// @pngdeity/opencode-codeintel.
//
// This exists because npm cannot do the installation for you. OpenCode installs
// plugins with @npmcli/arborist configured `ignoreScripts: true` (hardcoded), so
// a `postinstall` in this package would never run. Rather than ship a dead hook,
// the package exposes this CLI and leaves the decision with you:
//
//   codeintel install   copy the systemd user units into place
//   codeintel doctor    check this machine can actually answer a language query
//
// `doctor` deliberately does more than a handshake. mcpls answers MCP
// initialize in milliseconds and only then starts language servers in the
// background, so a successful handshake says nothing about whether any language
// is served. The real question is what `get_tool_support` reports: a language
// whose routes are all `no_server` is a backend that cannot answer.

import { chmod, copyFile, mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { CCLSP, SERENA } from "../src/codeintel/descriptors";
import { readConfs, systemctl } from "../src/codeintel/core";

const PACKAGE_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const UNITS_DIR = join(PACKAGE_ROOT, "share", "systemd", "user");
const SCRIPTS_DIR = join(PACKAGE_ROOT, "bin");

const xdgConfig = process.env.XDG_CONFIG_HOME || join(homedir(), ".config");
const xdgData = process.env.XDG_DATA_HOME || join(homedir(), ".local", "share");
// systemd resolves the user unit directory from $XDG_CONFIG_HOME, so installing
// to a computed ~/.config drops the units where the manager never looks.
const userUnits = join(xdgConfig, "systemd", "user");

const UNIT_GLOBS = [".service", ".socket", ".timer"];

// Where `codeintel install` puts the two maintenance scripts. The units carry
// the token below instead of a path, and install substitutes it, so a package
// that lands anywhere (a store path, a versioned prefix) still produces working
// units without a drop-in.
const SCRIPTS_DEST = join(xdgData, "opencode-codeintel", "bin");
const SCRIPTS_TOKEN = "@CODEINTEL_SCRIPTS@";

function fail(message: string): never {
  console.error(`codeintel: ${message}`);
  process.exit(1);
}

async function listUnits(): Promise<string[]> {
  try {
    const entries = await readdir(UNITS_DIR);
    return entries.filter((e) => UNIT_GLOBS.some((s) => e.endsWith(s))).sort();
  } catch {
    fail(`no units found in ${UNITS_DIR} (is the package complete?)`);
  }
}

async function listScripts(): Promise<string[]> {
  try {
    const entries = await readdir(SCRIPTS_DIR);
    return entries.filter((e) => e.endsWith(".py")).sort();
  } catch {
    return [];
  }
}

// ---------------------------------------------------------------------------
// install
// ---------------------------------------------------------------------------

async function install(argv: string[]): Promise<void> {
  const dryRun = argv.includes("--dry-run");
  const units = await listUnits();
  const scriptDest = SCRIPTS_DEST;

  console.log(`units : ${UNITS_DIR}`);
  console.log(`scripts: ${scriptDest}`);
  console.log(`target: ${userUnits}`);
  if (dryRun) console.log("(dry run: nothing will be written)");

  if (!dryRun) await mkdir(userUnits, { recursive: true });

  const replaced: string[] = [];

  for (const unit of units) {
    const dest = join(userUnits, unit);
    if (dryRun) {
      console.log(`  would write ${unit}`);
      continue;
    }
    const source = await readFile(join(UNITS_DIR, unit), "utf8");
    const rendered = source.replaceAll(SCRIPTS_TOKEN, scriptDest);
    if (rendered.includes(SCRIPTS_TOKEN)) {
      fail(`unit ${unit} still contains ${SCRIPTS_TOKEN} after substitution`);
    }
    // A previous install, or a hand edit, is about to be replaced. Say so rather
    // than reporting "wrote" for a file whose contents changed under the user.
    const previous = await readFile(dest, "utf8").catch(() => null);
    if (previous !== null && previous !== rendered) replaced.push(unit);
    await writeFile(dest, rendered);
    console.log(`  wrote ${unit}`);
  }

  // The two maintenance scripts are invoked by path from the units, which carry
  // the @CODEINTEL_SCRIPTS@ token that the loop above substitutes. Installing
  // them here rather than to ~/.local/bin keeps them off the user's interactive
  // PATH and out of a directory other tools believe they own.
  const scripts = await listScripts();
  if (!dryRun && scripts.length > 0) await mkdir(scriptDest, { recursive: true });
  for (const script of scripts) {
    const dest = join(scriptDest, script);
    if (dryRun) {
      console.log(`  would write ${dest}`);
      continue;
    }
    await copyFile(join(SCRIPTS_DIR, script), dest);
    await chmod(dest, 0o755);
    console.log(`  wrote ${dest}`);
  }

  if (dryRun) return;

  const reload = systemctl(["daemon-reload"]);
  if (reload.code !== 0) {
    fail(`systemctl --user daemon-reload failed: ${reload.out.trim()}`);
  }
  console.log("daemon-reload: ok");
  if (replaced.length > 0) {
    console.log(
      `\nreplaced ${replaced.length} existing unit(s): ${replaced.join(", ")}\n` +
        "  Their previous contents were overwritten. Per-unit overrides belong in\n" +
        "  a drop-in; use `systemctl --user edit <unit>` so they survive reinstall.",
    );
  }
  console.log(
    "\nUnits are installed but no instance is enabled yet. Enable one per project\n" +
      "with the `codeintel` tool (action=enable) or `mcp-instance`, then run\n" +
      "`codeintel doctor` to confirm a language server actually attached.",
  );
}

// ---------------------------------------------------------------------------
// doctor
// ---------------------------------------------------------------------------

type Line = { status: "ok" | "warn" | "fail"; text: string };

function render(lines: Line[]): number {
  const mark = { ok: "ok  ", warn: "warn", fail: "FAIL" } as const;
  for (const line of lines) console.log(`  ${mark[line.status]}  ${line.text}`);
  return lines.some((l) => l.status === "fail") ? 1 : 0;
}

async function commandExists(name: string): Promise<string | null> {
  const r = systemctl([]); // touch systemctl so the import is not tree-shaken oddly
  void r;
  const which = Bun.which(name);
  return which ?? null;
}

async function checkPrerequisites(): Promise<Line[]> {
  const lines: Line[] = [];

  for (const bin of ["supergateway", "mcpls", "serena"]) {
    const found = Bun.which(bin);
    lines.push(
      found
        ? { status: "ok", text: `${bin} -> ${found}` }
        : {
            status: "warn",
            text: `${bin} not on PATH (needed only for the server that uses it)`,
          },
    );
  }

  const sockets = await readdir(userUnits).catch(() => [] as string[]);
  const installed = sockets.filter(
    (f) => f.startsWith("cclsp-mcp@") || f.startsWith("serena-mcp@"),
  );
  lines.push(
    installed.length > 0
      ? { status: "ok", text: `${installed.length} instance unit template(s) installed` }
      : {
          status: "fail",
          text: `no instance unit templates in ${userUnits} — run \`codeintel install\``,
        },
  );

  const linger = systemctl(["show-environment"]);
  if (linger.code !== 0) {
    lines.push({
      status: "fail",
      text: "cannot reach the systemd user manager (no user session bus?)",
    });
  }

  return lines;
}

// The check that distinguishes a working installation from a handshake: ask
// mcpls what it can actually answer with. `no_server` means the backend is up
// but no language server attached -- which happens when the language server is
// missing from PATH, or when it is a proxy (rustup shims) that needs an env
// variable mcpls's reduced environment does not forward.
//
// The tool call is what makes this worth running. A handshake completes before
// any language server starts, so it reports healthy on a backend that will
// answer no query at all.
type ToolSupport = {
  languages?: string[];
  tools?: Array<{ name: string; coverage: string; routes?: Array<{ status: string }> }>;
};

async function callGetToolSupport(port: number): Promise<ToolSupport | null> {
  const base = `http://127.0.0.1:${port}/mcp`;
  const headers: Record<string, string> = {
    "content-type": "application/json",
    accept: "application/json, text/event-stream",
  };

  const post = (body: unknown, sid?: string): Promise<Response> =>
    fetch(base, {
      method: "POST",
      headers: sid ? { ...headers, "mcp-session-id": sid } : headers,
      body: JSON.stringify(body),
    });

  const unwrap = async (res: Response): Promise<any> => {
    const text = await res.text();
    const data = text
      .split("\n")
      .filter((l) => l.startsWith("data: "))
      .map((l) => l.slice(6));
    return JSON.parse(data.length > 0 ? data[data.length - 1] : text);
  };

  try {
    const init = await post({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2024-11-05",
        capabilities: {},
        clientInfo: { name: "codeintel-doctor", version: "0" },
      },
    });
    if (!init.ok) return null;
    const sid = init.headers.get("mcp-session-id") ?? undefined;
    await unwrap(init);
    await post({ jsonrpc: "2.0", method: "notifications/initialized", params: {} }, sid);

    let out: ToolSupport | null = null;
    // A cold backend starts its language servers in the background after the
    // handshake, so the first answers are `initializing` (mcpls's retryable
    // state) and only later become `available`. Poll long enough to cross a cold
    // start, and treat `initializing` as "not yet", never as failure.
    const deadline = Date.now() + 30_000;
    while (Date.now() < deadline) {
      const res = await post(
        {
          jsonrpc: "2.0",
          id: 10,
          method: "tools/call",
          params: { name: "get_tool_support", arguments: {} },
        },
        sid,
      );
      if (!res.ok) break;
      const body = await unwrap(res);
      const sc = body?.result?.structuredContent as ToolSupport | undefined;
      if (sc) {
        out = sc;
        if (!isStillStarting(sc)) break;
      }
      await Bun.sleep(1000);
    }

    if (sid) {
      await fetch(base, { method: "DELETE", headers: { "mcp-session-id": sid } }).catch(() => {});
    }
    return out;
  } catch {
    return null;
  }
}

// Reduce a get_tool_support answer to the one fact a human needs: for each
// language, did any route leave `no_server`/`initializing`?
//
// Three outcomes, because collapsing them is what makes a health check lie:
//   still starting -- every route `initializing`; wait, do not report
//   attached       -- some route reached a state that can answer
//   dead           -- languages detected, every route `no_server`
function isStillStarting(sc: ToolSupport): boolean {
  const statuses = new Set<string>();
  for (const tool of sc.tools ?? []) {
    for (const route of tool.routes ?? []) statuses.add(route.status);
  }
  return statuses.has("initializing") && statuses.size === 1;
}

function summariseSupport(sc: ToolSupport): { attached: string[]; dead: string[] } {
  const statuses = new Set<string>();
  for (const tool of sc.tools ?? []) {
    for (const route of tool.routes ?? []) statuses.add(route.status);
  }
  const languages = sc.languages ?? [];
  const healthy = [...statuses].filter((s) => s !== "no_server" && s !== "initializing");
  if (healthy.length > 0) return { attached: languages, dead: [] };
  if (statuses.has("initializing")) return { attached: languages, dead: [] };
  return { attached: [], dead: languages };
}

async function checkAttachment(): Promise<Line[]> {
  const lines: Line[] = [];
  const confs = [
    ...(await readConfs(SERENA)).map((c) => ({ conf: c, descriptor: SERENA })),
    ...(await readConfs(CCLSP)).map((c) => ({ conf: c, descriptor: CCLSP })),
  ];
  if (confs.length === 0) {
    lines.push({ status: "warn", text: "no instances enabled yet" });
    return lines;
  }

  for (const { conf, descriptor } of confs) {
    const unit = `${descriptor.unit}@${conf.proxyPort}.socket`;
    if (systemctl(["is-active", unit]).code !== 0) {
      // A conf with no live socket is an instance that was enabled once and is
      // not running now. Reporting it as a failure would make a healthy machine
      // look broken; it is a fact about state, not health.
      lines.push({
        status: "warn",
        text: `${descriptor.name}/${conf.instanceName} (${conf.proxyPort}): not running`,
      });
      continue;
    }

    const support = await callGetToolSupport(conf.proxyPort);
    if (!support) {
      // Serena exposes no get_tool_support, so the absence of the tool is not a
      // defect there. Say what was actually checked rather than implying health.
      lines.push(
        descriptor.name === "serena"
          ? {
              status: "ok",
              text: `${descriptor.name}/${conf.instanceName} (${conf.proxyPort}): answering (no attachment probe available for this server)`,
            }
          : {
              status: "fail",
              text: `${descriptor.name}/${conf.instanceName} (${conf.proxyPort}): no answer from get_tool_support`,
            },
      );
      continue;
    }
    const { attached, dead } = summariseSupport(support);
    if (dead.length > 0) {
      lines.push({
        status: "fail",
        text: `${descriptor.name}/${conf.instanceName} (${conf.proxyPort}): ${dead.join(", ")} detected but no language server attached`,
      });
    } else if (attached.length > 0) {
      lines.push({
        status: "ok",
        text: `${descriptor.name}/${conf.instanceName} (${conf.proxyPort}): ${attached.join(", ")}`,
      });
    } else {
      lines.push({
        status: "ok",
        text: `${descriptor.name}/${conf.instanceName} (${conf.proxyPort}): no language markers in this project`,
      });
    }
  }
  return lines;
}

async function doctor(): Promise<void> {
  console.log("prerequisites:");
  const prereq = await checkPrerequisites();
  let code = render(prereq);

  console.log("\ninstances:");
  const attach = await checkAttachment();
  code = render(attach) || code;

  console.log(
    "\nA socket answering its handshake is not proof a language is served.\n" +
      "If a project reports no language, check the backend log:\n" +
      "  journalctl --user -u cclsp-backend@<port> -n 50",
  );
  process.exit(code);
}

// ---------------------------------------------------------------------------

const [, , sub, ...rest] = process.argv;

switch (sub) {
  case "install":
    await install(rest);
    break;
  case "doctor":
    await doctor();
    break;
  case undefined:
  case "-h":
  case "--help":
    console.log(
      "codeintel <command>\n\n" +
        "  install [--dry-run]   copy systemd user units and maintenance scripts\n" +
        "  doctor                check binaries, units, and whether a language attached\n",
    );
    break;
  default:
    fail(`unknown command '${sub}' (try --help)`);
}
