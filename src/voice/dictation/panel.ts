import {
	isKeyRelease,
	isKeyRepeat,
	matchesKey,
	stripTerminalSequences,
	truncateToWidth,
	visibleWidth,
	wrapTextWithAnsi,
} from "@oh-my-pi/pi-tui";
import { DOUBLE_SPACE_WINDOW_MS } from "../shortcuts.ts";

export type DictationPhase = "connecting" | "listening" | "muted" | "finishing";

interface PanelOptions {
	theme: {
		fg(
			color: "accent" | "success" | "warning" | "dim" | "text",
			text: string,
		): string;
	};
	rows(): number;
	requestRender(): void;
	onToggleMute(): void;
	onCancel(): void;
	onSend(): void;
	onFinishToEditor(): void;
}

const PHASE_LABELS = {
	connecting: "○ Connecting…",
	listening: "● Listening",
	muted: "Ⅱ Muted",
	finishing: "○ Finishing last words…",
} as const;

/** Editor-replacing panel, using the status colors and rounded frame of OMP /live. */
export class DictationPanel {
	private transcript = "";
	private phase: DictationPhase = "connecting";
	private scroll = 0;
	private pageSize = 8;
	private lastSpaceAt: number | undefined;

	constructor(private readonly options: PanelOptions) {}

	setTranscript(text: string): void {
		this.transcript = stripTerminalSequences(text).replace(
			/[\x00-\x09\x0b-\x1f\x7f-\x9f]/g,
			"",
		);
		this.options.requestRender();
	}

	setPhase(phase: DictationPhase): void {
		this.phase = phase;
		this.options.requestRender();
	}

	handleInput(data: string): void {
		if (isKeyRelease(data)) return;
		if (matchesKey(data, "space") && !isKeyRepeat(data)) {
			const now = Date.now();
			if (
				this.lastSpaceAt !== undefined &&
				now - this.lastSpaceAt <= DOUBLE_SPACE_WINDOW_MS
			) {
				this.lastSpaceAt = undefined;
				this.options.onFinishToEditor();
			} else {
				this.lastSpaceAt = now;
				this.options.onToggleMute();
			}
			return;
		}
		this.lastSpaceAt = undefined;
		if (matchesKey(data, "escape") || matchesKey(data, "ctrl+c"))
			this.options.onCancel();
		else if (matchesKey(data, "enter") && !isKeyRepeat(data))
			this.options.onSend();
		else if (matchesKey(data, "pageUp") || matchesKey(data, "up")) {
			this.scroll += matchesKey(data, "up") ? 1 : this.pageSize;
			this.options.requestRender();
		} else if (
			matchesKey(data, "pageDown") ||
			matchesKey(data, "down") ||
			matchesKey(data, "end")
		) {
			this.scroll = matchesKey(data, "end")
				? 0
				: Math.max(
						0,
						this.scroll - (matchesKey(data, "down") ? 1 : this.pageSize),
					);
			this.options.requestRender();
		}
	}

	invalidate(): void {}

	render(width: number): string[] {
		const { theme } = this.options;
		const rows = Math.max(6, this.options.rows());
		const height = Math.min(rows - 2, Math.max(8, Math.floor(rows * 0.61)));
		const inner = Math.max(1, width - 4);
		const bodyHeight = Math.max(1, height - 7);
		this.pageSize = bodyHeight;
		const wrapped = wrapTextWithAnsi(
			this.transcript || "Your words will appear here as you speak…",
			inner,
		);
		this.scroll = Math.min(
			this.scroll,
			Math.max(0, wrapped.length - bodyHeight),
		);
		const start = Math.max(0, wrapped.length - bodyHeight - this.scroll);
		const visible = wrapped.slice(start, start + bodyHeight);
		const words = this.transcript.trim()
			? this.transcript.trim().split(/\s+/).length
			: 0;
		const phaseColor =
			this.phase === "listening"
				? "success"
				: this.phase === "connecting"
					? "dim"
					: "warning";
		const line = (content: string): string => {
			const fitted = truncateToWidth(content, inner);
			return (
				theme.fg("accent", "│") +
				" " +
				fitted +
				" ".repeat(Math.max(0, inner - visibleWidth(fitted))) +
				" " +
				theme.fg("accent", "│")
			);
		};
		const border = (left: string, label: string, right: string): string => {
			const fitted = truncateToWidth(label, Math.max(0, width - 2));
			return theme.fg(
				"accent",
				left +
					fitted +
					"─".repeat(Math.max(0, width - 2 - visibleWidth(fitted))) +
					right,
			);
		};
		const output = [
			border("╭", "─ Dictation · Codex ", "╮"),
			line(
				theme.fg(phaseColor, PHASE_LABELS[this.phase]) +
					theme.fg("dim", `   ${words} words`),
			),
			line(""),
			...visible.map((text) =>
				line(theme.fg(this.transcript ? "text" : "dim", text)),
			),
			...Array.from({ length: Math.max(0, bodyHeight - visible.length) }, () =>
				line(""),
			),
			line(""),
			line(
				theme.fg(
					"dim",
					this.scroll
						? "↑↓ scroll · End follows live text"
						: "Live preview · ↑↓ scroll",
				),
			),
			line(
				theme.fg(
					"accent",
					`Space ${this.phase === "muted" ? "unmute" : "mute"}`,
				) +
					theme.fg("dim", "  ·  ") +
					theme.fg("accent", "Space×2 edit") +
					theme.fg("dim", "  ·  ") +
					theme.fg("success", "Enter send") +
					theme.fg("dim", "  ·  ") +
					theme.fg("warning", "Esc cancel"),
			),
			border("╰", "", "╯"),
		];
		return output.map((text) => truncateToWidth(text, Math.max(1, width)));
	}
}
