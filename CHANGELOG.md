# Changelog

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
