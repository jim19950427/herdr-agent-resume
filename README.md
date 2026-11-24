# herdr-agent-resume

A [Herdr](https://herdr.dev) desktop-app mod that brings **Claude Code** and **Codex** conversations back
after herdr-core loses its programs (core restart, `hc server stop`, crash).

(中文：當 herdr-core 重啟、程式被換成新 shell 時，自動用「精確 session ID」續接 Claude Code / Codex。)

## What it does

- It records, for every terminal running Claude Code or Codex, the command that resumes that exact conversation:
  - **Claude Code**: `claude --resume <sessionId>`, read from `~/.claude/sessions/<pid>.json`. Your original flags are kept.
  - **Codex**: `codex resume <threadId>`, looked up by pid in Codex's local `logs_2.sqlite` / `state_5.sqlite`
    (needs the `sqlite3` command, present on macOS).
- If the terminal later gets a **new shell** (the program was lost), it types the resume command into it
  and posts a notification.
- Quitting the agent yourself is left alone: the shell is the same, so nothing is typed.
- Until an exact ID is known (for example a Codex that was just started and has not done anything yet),
  it falls back to `claude --continue` / `codex resume --last`. The status bar shows how many panes have an exact ID.

## When it saves

| When | Why it is shown in the status bar |
| --- | --- |
| every 5 minutes | `every 5 min` |
| a workspace is created or closed | `workspace created` / `workspace closed` |
| a pane is created, closed or exits | `pane created` / `pane closed` / `pane exited` |
| an agent is detected, or ends | `agent detected` / `agent ended` |
| you ask for it | `manual` |
| the mod starts | `start` |

Changes are noticed by comparing Herdr's live data once a second (in memory, no process and no disk), and a burst of
changes is saved once, about 2 seconds after it settles.

**Save manually** with the **Save now** button in the status bar, the command palette entry
`Agent resume: save now`, or bind a key in `keys.json`, for example
`"global": { "ctrl-alt-s": "agent-resume.save" }`.

Between two saves, a change nothing announces (for example `/resume` to another Claude session inside the same
pane) is not recorded until the next save. Press **Save now** to record it right away.

## Install

```sh
git clone https://github.com/jim19950427/herdr-agent-resume ~/.config/herdr-app/mods/agent-resume
```

Herdr's shipped layouts are read-only and a mod only runs while it is in the shown layout, so use your own layout:

```sh
herdr-app do layout.clone '{"name":"main","as":"main-resume"}'
```

Then add this block as the last child of the `work` column in `~/.config/herdr-app/layouts/main-resume.json`
(next to the `status` block):

```json
{ "id": "resume-bar", "type": "block", "size": { "px": 22 }, "content": { "mod": "agent-resume" } }
```

Check it with `herdr-app check ~/.config/herdr-app/mods/agent-resume`.

## Limits

- It only records and watches while the window is open with a layout that contains the mod.
- When Codex was not started as `codex resume <id>`, the resume command drops its other flags.
- Reads Claude's and Codex's local state files; these are internal formats and may change between versions.
- Only tested on macOS.

## License

MIT
