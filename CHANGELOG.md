# Changelog

## 0.5.0

- **Ultracompact**, the new default: the whole HUD on one line in Claude Code's status line, under the prompt, with no frame and nothing drawn above the prompt. It fits the line to the terminal by priority (context, then the 5h limit, then the 7d limit, then model, cost, agents, windows, current action and turns, as many as fit) and spends any room left on reset times and bars. The mod writes the line to `~/.claude/spark-hud/line/<session>.ansi` and `scripts/statusline.mjs` prints it; see *Status line* in the README.
- `/hud` cycles one line → card → full dashboard; `▿ line` in the card or the dashboard goes back to one line.

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
