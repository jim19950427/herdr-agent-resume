// agent-resume: remembers which terminals run Claude Code / Codex, and when herdr-core
// replaces a lost program with a fresh shell (core restart, `hc server stop`, crash),
// types the resume command into that new shell.
//
// How a "lost" program is told apart from the person quitting the agent: quitting leaves the
// same shell running (same shell pid); a loss gives the terminal a new shell (new pid).

import { View, div } from "gpui-kit";
import { h_flex } from "gpui-base";
import * as fs from "fs/promises";
import { hc, exec, home, notify, theme, checking } from "herdr";

const KEY = "records"; // { [address]: { kind, cmd, cwd, shellPid } }
const EVERY_MS = 5000;
const SETTLE_MS = 1500; // let the new shell print its prompt before typing

const AGENTS = new Set(["claude-code", "claude", "codex"]);

const base = (p) => String(p ?? "").split("/").pop();
const quote = (a) => (/^[A-Za-z0-9_@%+=:,./-]+$/.test(a) ? a : `'${a.replace(/'/g, `'\\''`)}'`);

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Claude Code writes ~/.claude/sessions/<pid>.json for each running process.
async function claudeSessionId(pid, cwd) {
  try {
    const j = JSON.parse(await fs.readFile(`${home()}/.claude/sessions/${pid}.json`, "utf8"));
    if (j.pid === pid && UUID.test(j.sessionId ?? "") && (!cwd || !j.cwd || j.cwd === cwd)) return j.sessionId;
  } catch {}
  return null;
}

// Codex logs every process as `pid:<pid>:<uuid>` with the thread it works on. Sub-agent
// threads have an agent_path or a parent, so only the top-level thread counts.
async function codexThreadId(pid) {
  if (!Number.isInteger(pid)) return null;
  const sql = `attach '${home()}/.codex/state_5.sqlite' as s; ` +
    `select l.thread_id from logs l join s.threads t on t.id = l.thread_id ` +
    `where l.process_uuid like 'pid:${pid}:%' and t.attached_thread_parent_id is null and t.agent_path is null ` +
    `order by l.id desc limit 1;`;
  try {
    const r = await exec("sqlite3", ["-readonly", `${home()}/.codex/logs_2.sqlite`, sql]);
    const id = r.stdout.trim();
    return UUID.test(id) ? id : null;
  } catch {}
  return null;
}

// Drop the flags that pick a session, so the one we add is the only one.
function withoutSession(rest) {
  const out = [];
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i];
    if (a === "--continue" || a === "-c" || a === "--fork-session") continue;
    if (["--resume", "-r", "--session-id"].includes(a)) {
      if (rest[i + 1] && !rest[i + 1].startsWith("-")) i++;
      continue;
    }
    if (a.startsWith("--resume=") || a.startsWith("--session-id=")) continue;
    out.push(a);
  }
  return out;
}

// What to type to bring the conversation back, and whether the id is exact.
// `known` is what we stored before for this same shell: never trade an exact id for a guess.
async function resumeFor(info, known) {
  const argv = info.foreground?.argv ?? [];
  const pid = info.foreground?.pid;
  const cwd = info.foreground?.cwd;
  const prog = base(argv[0]);
  const rest = argv.slice(1);

  if (prog === "claude") {
    const id = (await claudeSessionId(pid, cwd)) ?? known?.id ?? null;
    if (id) return { kind: "claude", id, exact: true, cmd: [prog, ...withoutSession(rest), "--resume", id].map(quote).join(" ") };
    return { kind: "claude", id: null, exact: false, cmd: [prog, ...withoutSession(rest), "--continue"].map(quote).join(" ") };
  }

  if (prog === "codex") {
    const given = rest[0] === "resume" ? rest.slice(1).find((a) => UUID.test(a)) : null;
    const id = given ?? (await codexThreadId(pid)) ?? known?.id ?? null;
    if (id) return { kind: "codex", id, exact: true, cmd: `${quote(prog)} resume ${id}` };
    return { kind: "codex", id: null, exact: false, cmd: "codex resume --last" };
  }
  return null;
}

async function json(args) {
  const r = await hc(args);
  return JSON.parse(r.stdout);
}

// No setTimeout in mods: wait through the machine.
const sleep = (ms) => exec("sleep", [String(ms / 1000)]);

export default class AgentResume extends View {
  init(_props, cx) {
    this.records = {};
    try { this.records = JSON.parse(localStorage.getItem(KEY) ?? "{}"); } catch { this.records = {}; }
    this.busy = false;
    this.last = "";
    if (checking()) return; // a check must not start helpers or type into terminals
    this.tick(cx);
    cx.timer.every(EVERY_MS, (cx) => this.tick(cx));
  }

  save() {
    localStorage.setItem(KEY, JSON.stringify(this.records));
  }

  tick(cx) {
    if (this.busy) return;
    this.busy = true;
    cx.spawn(async (cx) => {
      try {
        await this.scan();
      } catch (e) {
        this.last = `error: ${String(e?.message ?? e).slice(0, 80)}`;
      } finally {
        this.busy = false;
        cx.notify();
      }
    });
  }

  async scan() {
    const { terminals } = await json(["ls", "--json"]);
    const live = new Map(terminals.map((t) => [t.address, t]));

    // Terminals that are gone for good: forget them.
    for (const addr of Object.keys(this.records)) {
      if (!live.has(addr)) delete this.records[addr];
    }

    for (const [addr, t] of live) {
      const rec = this.records[addr];
      const isAgent = AGENTS.has(t.agent);

      if (isAgent) {
        // Remember (or refresh) what is running here.
        const info = await json(["get", addr, "--json"]);
        const known = rec && rec.shellPid === info.pid ? rec : null;
        const r = await resumeFor(info, known);
        if (r) {
          this.records[addr] = { ...r, cwd: info.foreground?.cwd ?? t.cwd, shellPid: info.pid };
        }
      } else if (rec) {
        // An agent was here and none is now. Same shell pid: the person quit it, leave it alone.
        // New shell pid: the program was lost and herdr-core gave a fresh shell, so resume.
        const info = await json(["get", addr, "--json"]);
        if (info.pid !== rec.shellPid) {
          delete this.records[addr];
          this.save();
          await sleep(SETTLE_MS);
          await hc(["send", addr, rec.cmd]);
          this.last = `resumed ${addr}: ${rec.cmd}`;
          notify({ title: "Agent resumed", body: `${addr}: ${rec.cmd}`, level: "info" });
        } else if (t.state === "live") {
          // Quit on purpose; stop tracking.
          delete this.records[addr];
        }
      }
    }
    this.save();
  }

  render(_cx) {
    const t = theme();
    const recs = Object.values(this.records);
    const n = recs.length;
    const exact = recs.filter((r) => r.exact).length;
    return h_flex()
      .size_full()
      .px(10)
      .gap(8)
      .items_center()
      .bg(t.chrome)
      .text_size(11)
      .text_color(t.muted)
      .child(`↻ agent-resume: tracking ${n} agent${n === 1 ? "" : "s"} (${exact} with exact session id)`)
      .when(Boolean(this.last), (el) => el.child(div().truncate().text_color(t.dim).child(this.last)));
  }
}
