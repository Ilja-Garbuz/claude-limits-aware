---
name: limits-aware-workflow
description: Keep multi-step work safe from subscription session (5h) and weekly limits: check usage cheaply, then continue, checkpoint or wrap up and compact by band. Use for long tasks, before /compact, and whenever a "Limits:" note appears.
---

# Limits-aware workflow

A subscription has a rolling 5-hour session limit and a weekly limit, shared by every
Claude Code session, Claude Desktop and claude.ai on the account. Hitting one mid-task
leaves work unfinished and unverified, and by the time it resets the prompt cache is cold,
so resuming a big context is expensive. This skill keeps a current reading of the limits and
turns it into a decision: continue, checkpoint, or save notes and compact.

Usage credits / extra usage are out of scope: treat them as disabled.

## 1. Getting a reading (all free: no model call)

The `limits-aware` plugin (github.com/Ilja-Garbuz/claude-limits-aware) does this for Claude Code.
Its script is `scripts/claude-limits.mjs`, found in the plugin's marketplace clone
(`${CLAUDE_CONFIG_DIR:-~/.claude}/plugins/marketplaces/limits-aware/`).
Readings are per Claude config dir, so each account is tracked separately.

| Environment | How the reading arrives | What to do |
|-|-|-|
| Claude Code with the plugin (CLI, Desktop's Code tab) | Automatic. Hooks inject a `Limits: ... Band: X.` note when the band rises, on a new prompt in CAUTION+, every 10 min in WRAP/STOP, and once when a window resets. Silence means OK. The user can type `/limits`. | Act on the note's band (section 3). Don't run checks yourself unless planning a big step. |
| Claude Code without the plugin | none | Run `node <path>/claude-limits.mjs check` with Bash, or `claude -p /usage --safe-mode --no-session-persistence` and read the "Current session" and "Current week" lines. |
| Claude Desktop chat / Cowork | none | Run one of the commands above on the user's machine through a shell tool that reaches it (Desktop Commander, a PowerShell tool). It reads the same pool if Claude Code there is signed in to the same account. |
| Cloud sessions (claude.ai/code, Projects) | none: the account's usage isn't reachable | Work in small verified checkpoints (section 4) and keep a handoff note current. |

Never run `/usage` inside the open session: it is an interactive dialog. The headless
`claude -p /usage ...` form loads no plugins and makes no model call (~2-3 s).

### Cadence

The cost of a check decides how often it may run:

| Method | Cost per check | Cadence |
|-|-|-|
| Hook reading the snapshot | 0 tokens, ~30 ms; a note is ~80 tokens only when it fires | after every tool call, throttled to once per 30 s |
| Status line feed (optional) | 0 | after every API response |
| Background live `/usage` | 0 tokens, ~2.5 s off the critical path | when the snapshot is older than 3 min |
| Manual `check` via a tool call | ~300-600 tokens of context | at task start, before each large step, and at least every ~10 min or ~15 tool calls of work |

Readings older than ~5 min are a guess: other sessions drain the same pool. `check` refreshes
by itself when its snapshot is stale; `check --live` forces it.

## 2. Bands

| Band | Session (5h) | Weekly | Notes |
|-|-|-|-|
| OK | < 70% | < 80% | |
| CAUTION | >= 70% | >= 80% | |
| WRAP | >= 85% | >= 90% | also when the burn rate projects 100% within 20 min, before the reset |
| STOP | >= 93% | >= 96% | |

If a window resets before the projected hit (check "resets ... in N min"), it is safe to keep
going at a moderate pace; say so rather than wrapping.

## 3. What to do in each band

**OK**: work normally. At task start, for anything longer than a few steps, take one reading.

**CAUTION**
- Finish the current unit of work; before starting the next, estimate whether it fits.
- Checkpoint at every milestone: changes saved/committed, a short progress note.
- Prefer cheap moves: targeted greps over reading whole files, no new subagents (each one
  starts cold and re-reads context), no speculative exploration.
- Context size drives burn: each request re-sends the whole conversation, and `/usage`
  usually shows most usage at large contexts. If context is large, suggest `/compact` or a
  fresh session from a handoff note at the next milestone.

**WRAP**
- Do not start new work units. Finish only the step in progress, or back it out if it can't be
  finished cleanly.
- Verify what changed (the quickest test or check that proves it), then save: commit to the
  working branch / write files.
- Run the pre-compact checklist (section 4), then compact (section 5).
- Tell the user what is done, what is left, and when the limit resets.

**STOP**
- No new work. Save state in as few tool calls as possible (one commit, one note), compact
  (section 5), and end the turn with a two-line summary and the reset time.
- Subagents get only STOP notes; a subagent that receives one returns what it has immediately.

**Weekly in WRAP/STOP** (session fine): finish the current task, then ask the user before
starting another; suggest a lighter model or effort for routine work.

## 4. Checkpoints and the pre-compact checklist

Work so that a limit hit at any moment loses little: units small enough to verify and save in a
few tool calls, no half-applied edit across files at the end of a step, WIP committed on a
branch after each verified unit.

Before compacting (or ending a session near a limit), make sure everything the next turn needs
lives outside the conversation. Go through the list and save what isn't saved yet:

1. **Handoff note** where the next session will look (the repo's `HANDOFF.md`, the project's
   notes file, or the thread). Template below.
2. **Memory notes**: update the memory/notes files with facts and decisions learned this
   session; note which sources are live and must be re-read rather than trusted from notes
   (tickets, PR states, anything that changes outside this machine).
3. **Skills**: if this session taught a lesson about a workflow that has a skill, update it.
4. **Git state**: uncommitted changes, local branches with unpushed commits, branches offered
   for cleanup, open PRs and what they wait on.
5. **Open threads with the user**: questions asked, offers made, decisions pending.
6. **Environment caveats**: connector warnings, failing tools, workarounds in use.
7. **Temporary files**: what lives only in a scratchpad or temp folder and will not survive;
   move what matters next to the project or record how to rebuild it.

```
## Handoff <date time>  (limits: 5h 91%, resets 14:20)
Goal: ...
Done and verified: ...
Done, not verified: ...
Next step: <exact command or file:line>
Open questions / offers: ...
Git: <branch>, unpushed: ..., open PRs: ...
Temporary files not kept: ...
```

## 5. Compacting

- With the plugin: after the checklist, call `mcp__limits-aware__compact_after_turn` (with a
  `focus` naming anything special to keep) as the last tool call, then end the turn with the
  summary. The plugin runs `/compact` as soon as the turn ends; it cannot run mid-turn.
- If a turn ends in WRAP/STOP with a large context and no such call, the plugin sends a
  follow-up prompt asking for the checklist and the call; if that turn also ends without it,
  the plugin compacts on its own with notes-keeping instructions (once per 5h window).
- Without the plugin: ask the user to run `/compact` once the checklist is done, naming
  what the summary must keep.
- Compacting is one request over the whole context, so do it once, after the notes, not
  repeatedly. After a reset, the next turn starts from the compacted summary and the notes
  instead of re-reading everything.

## 6. Don'ts

- Don't poll in a loop or with `sleep`; the hooks and the snapshot do the polling.
- Don't run manual checks every few tool calls when the plugin is installed.
- Don't call a band from a stale reading without saying how old it is.
- Don't spend the last few percent on summaries the user didn't need: save state first, talk second.

## Setup reference

- Install: `/plugin install limits-aware --marketplace Ilja-Garbuz/claude-limits-aware`
  (per config dir). Optional status line: `node <marketplace clone>/scripts/install.mjs --statusline-only`.
- Without plugins: `node scripts/install.mjs [config dirs...]` adds the hooks and status line to
  `settings.json` directly (`--remove` takes them out).
- Thresholds: env vars `CLAUDE_LIMITS_5H_CAUTION|WRAP|STOP`, `CLAUDE_LIMITS_7D_*`; compaction
  mode and minimum context in the plugin's settings (`/plugin` > limits-aware > configure).
- Future: usage credits could extend this skill, or live in a separate `spending-awareness-workflow`.
