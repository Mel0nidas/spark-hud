# Changelog

## 0.7.0

- **Chat temperature (TEMP).** A new gauge in the compact card shows whether the prompt cache is still warm: it drains like a thermometer from the last reply, orange to blue, with the time left and then `cold`, and stays full while Claude works. A cold cache makes the next message write the whole context again, about 12× the input of a warm one.
- The expanded view's session section says what the next message will cost, warm or cold.
- One toast a couple of minutes before the cache goes cold (a minute ahead on a 5-minute cache), once per reply.
- **New setting** `cacheTtl` (`1h` / `5m`, default `1h`): Claude Code does not report the cache lifetime.
- On a narrow terminal TEMP is the first gauge to go.

## 0.6.0

Built for the Claude desktop app as well as the terminal.

- **Native drawing in the desktop app.** The app draws text in a proportional face, where block and box-drawing characters leave gaps and do not line up. There the mascot and every bar (context, plan limits, context breakdown) are now vector art, with the same gradients, glint and animation; the frame lines become a plain title.
- **Readable in the app's light theme.** Body and secondary text follow the app's own theme colors instead of the terminal palette's light grey; the dark chips become semibold figures.
- **Lighter on the app.** Gradient titles and rules were one styled node per letter, sent again on every frame; in the app each is now one node.
- The gauges wrap onto a second line when the app window is narrow, and the plan-limit bars line up in a fixed-width label column.
- The terminal looks and works exactly as before.

## 0.5.0

Privacy and footprint, after a review that flagged what 0.4 wrote to disk.

- **Pixel-art avatar with animated transitions.** The mascot is now pixel art (half-block pixels, 11×8, theme colors) and every state change is animated: idle glances; on a prompt it crouches and hops into a dance with notes; when the turn ends it jumps, bursts into sparks, a thumbs-up rises, a glint sweeps across it, it sinks away and the mascot pops back up and blinks (about 5.5 s, then it is gone on its own). An interrupted turn shakes its head; a nearly full context makes it sweat. With `animation: off` every state is a still picture.
- **DONE sign.** A green `✔ DONE` pill next to "ready for the next task" (or "N agents still running"), shown from the end of a turn until the next prompt; an interrupted turn shows none.
- Fixed: when many agents run, Claude Code's agent list below the prompt takes rows from the band and squashed the HUD. The card now fits 4, 3, 2 or 1 rows (frame first, then gauges, go), and the expanded view falls back to the card when it has fewer than 8.
- **No more command text on disk.** The status file other windows read used to carry the last action, which could be the first 48 characters of a Bash command, a file name, a URL or a search term. It now carries only the bare tool name (`Bash`, `Read`, `MCP`). Commands still show in your own HUD, on screen only.
- **Old files are scrubbed.** On start, every stale file in `~/.claude/spark-hud/sessions/` is overwritten with `{"ended":true}`, so whatever 0.4 left behind is gone.
- **No pile-up.** A new window reuses the file of a closed one instead of adding a new file, and an unchanged status is not rewritten.
- **Untrusted peer files.** Files from other windows are validated: types checked, numbers clamped, text cut and stripped of control characters and bidi overrides, big files skipped, at most 8 listed.
- **Lighter timer.** It runs fast only while something moves, and once a second at rest (it used to tick ~4.5 times a second all session).
- **The agent viewer stops reading** its agent's transcript as soon as you close it (it used to keep polling).
- **New settings** in `/config`: `animation` (`full` / `calm` / `off`) and `shareWithOtherWindows` (off: nothing is written or read).
- Limit and context toasts fire once per threshold crossing instead of on every update; the 75% one used to fire only at exactly 75%.
- Fixed: Chinese, Japanese and Korean text (and emoji) in agent rows overflowed the line, as text was cut by characters instead of terminal cells.
- Fixed: on narrow terminals, empty-state lines wrapped onto a second row and pushed the band past its height.
- Fixed: the agent viewer lost the agent's task once a transcript passed 300 steps, and a multi-line agent description broke its header.
- Fixed: a used-up limit said "runs out in ~0s"; it now says "limit reached, back in …". A reading past its reset says "resetting", and unknown limit kinds no longer push the bars out of line.
- New test suite: every view laid out as text across 10 widths, 6 states and both surfaces, plus footprint, privacy and edge-case tests.
- Works with `CLAUDE_CONFIG_DIR`; "PLAN MAX" is now "PLAN LIMITS", for Pro and Max alike; the theme button uses `◐` instead of an emoji that misaligned in some terminals.

## 0.4.1

- Fixed: when a docked pane narrowed the HUD, its rows split into stacked columns (`⬢` over the model, `$` over the cost). Every row is now one line that truncates.
- Fixed: the expanded view no longer runs past the band in fullscreen; it fits the rows it is given and keeps AGENTS visible first.
- Fixed: agent rows no longer wrap onto two lines; the tool count, time and `⤢` stay visible and the description is cut instead.
- Fixed: the engine's own forks (compaction, classifiers) no longer show up as phantom `agent` rows.
- Agent viewer: dropped the duplicate `✕` (the pane frame has one, and Esc closes it), failed agents show `✘`, and an empty viewer says there are no agents yet.

## 0.4.0

- **Claude's mascot** replaces the spark logo: an animated avatar on the right side of the HUD (blinks at rest, dances while Claude works, celebrates when a turn ends, sweats when the context is nearly full), tinted by the theme.
- New default theme **Claude** (orange).
- Themes no longer rotate on a timer: they change only when you press `🎨 theme` or run `/hud-theme`, and the pick is kept between sessions.
- More breathing room between gauges, their readings and the session chips.

## 0.3.0

- **Agent viewer**: click any agent (or run `/hud-agents`) to open a live panel with its task, messages and every tool call with its result.
- Per-agent context usage and model, read from each model request.
- `◀ ▶` to flip between agents, `Esc` to close.

## 0.2.0

- Full English UI: labels, tips, toasts and command descriptions.
- `/hud-tema` renamed to `/hud-theme`.
- Six calm themes (Black & Red, Graphite & Amber, Slate & Blue, Forest, Ink & Bone, Wine) that rotate every 15 minutes, in sync across windows.
- Animated gradient rules above and below the widget.
- Gradient bars with 1/8-cell precision and a soft glint while Claude works.

## 0.1.0

- First release: context window, Max plan 5h/7d limits with pace forecast, cost, live agents, other windows, dancing spark logo.
