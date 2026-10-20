# limits-aware

A Claude Code plugin that keeps Claude aware of your subscription's **session (5-hour)** and
**weekly** limits while it works, so it wraps up, saves its notes and compacts before a limit
cuts it off, instead of stopping mid-task with unverified work and a cold cache.

Checking costs nothing: no model call, no tokens unless there's something to act on.

## Install

At the prompt of a Claude Code session:

```
/plugin install limits-aware --marketplace Ilja-Garbuz/claude-limits-aware
```

Answer `y` to add the marketplace, then pick the user scope. From a shell instead:

```bash
claude plugin marketplace add Ilja-Garbuz/claude-limits-aware
claude plugin install limits-aware@limits-aware --scope user
```

In the desktop app, where `/plugin` does not run: click **+** next to the prompt box, then
**Plugins**, **Add marketplace** with `Ilja-Garbuz/claude-limits-aware`, then **Add plugin**.

Requirements: Node 18+ on `PATH` (`node --version`), and a Claude Pro or Max subscription
(API-key users have no session/weekly limits to watch). Works on Windows (Git Bash), Linux and macOS.

Several accounts with separate config dirs (`CLAUDE_CONFIG_DIR=~/.claude-work`)? Install the
plugin in each; every config dir keeps its own readings.

### Optional: status line

The plugin works without it, but a status line makes readings instant (Claude Code hands it the
limits after every response) and shows them to you:

```bash
node ~/.claude/plugins/marketplaces/limits-aware/scripts/install.mjs --statusline-only
```

It shows `5h 42% ↻14:20 · 7d 20% · ctx 31% · cache ↻13:40`. An existing status line of
yours is kept; add `--statusline` to replace it.

## What it does

**Reads the limits for free**, from two sources that make no model call:
- the status line feed (`rate_limits`), after every response in the session;
- `claude -p /usage --safe-mode --no-session-persistence` in the background when the last
  reading is over 3 minutes old. This one sees the whole account, including other sessions,
  Claude Desktop and claude.ai.

**Nudges Claude by band.** A hook checks the reading after tool calls (at most every 30 s, ~30 ms)
and adds one line to Claude's context only when it matters: the band went up, a new prompt
arrives above OK, every 10 minutes near the limit, or once when a window resets.

| Band | Session (5h) | Weekly | Claude... |
|-|-|-|-|
| OK | < 70% | < 80% | works normally |
| CAUTION | 70% | 80% | finishes units, checkpoints, avoids subagents and big new work |
| WRAP | 85% | 90% (or 100% projected within 20 min) | finishes the step, verifies, saves notes, compacts |
| STOP | 93% | 96% | saves state in as few calls as possible, compacts, stops |

**Compacts after the notes.** The bundled `limits-aware-workflow` skill has Claude go through a
pre-compact checklist (handoff note, memory notes, skill lessons, git state, open questions,
temporary files), then call the plugin's `compact_after_turn` tool. `/compact` runs as soon as
the turn ends. If a turn ends in WRAP/STOP without that, the plugin asks Claude to do it, and
compacts on its own if the next turn still doesn't (once per 5-hour window, large contexts only).

**`/limits`** shows the live figures any time.

## Settings

`/plugin` > limits-aware > configure:
- **Compaction near the limit**: `fallback` (default), `agent` (only when Claude asks), `off`.
- **Minimum context for fallback compaction**: 30% by default.

Thresholds are environment variables (set them in `settings.json` under `env`):
`CLAUDE_LIMITS_5H_CAUTION|WRAP|STOP` (70/85/93), `CLAUDE_LIMITS_7D_CAUTION|WRAP|STOP` (80/90/96),
`CLAUDE_LIMITS_STALE_S` (180), `CLAUDE_LIMITS_THROTTLE_S` (30), `CLAUDE_LIMITS_REMIND_S` (600),
`CLAUDE_LIMITS_ETA_WRAP_MIN` (20).

## Without the plugin system

`scripts/claude-limits.mjs` runs on its own:

```bash
node scripts/claude-limits.mjs check          # reading + band
node scripts/claude-limits.mjs check --live   # force a /usage read
node scripts/install.mjs [config dirs...]     # wire hooks + status line into settings.json
node scripts/install.mjs --remove [dirs...]
```

Claude Desktop chat and Cowork have no hooks: there the skill has Claude run `check` through a
shell tool at milestones.

## Files

```
.claude-plugin/plugin.json        manifest and settings
.claude-plugin/marketplace.json   makes this repo installable
hooks/hooks.json                  the limits hook + the compaction module
hooks/register.ts                 compact_after_turn tool, fallback, /limits
scripts/claude-limits.mjs         readings, bands, status line, hook (Node, no dependencies)
scripts/install.mjs               settings.json wiring without the plugin system
skills/limits-aware-workflow/     what Claude does in each band
tests/                            claude plugin test .
```

## License

MIT
