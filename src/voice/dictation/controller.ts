import type { ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import type { VoiceControlConfig } from "../../config.ts";
import { resolveCodexVoiceAuth } from "../auth.ts";
import { DictationPanel } from "./panel.ts";
import {
	type CodexDictationCallbacks,
	CodexDictationSession,
} from "./session.ts";

type Session = Pick<
	CodexDictationSession,
	"start" | "finish" | "close" | "setInputMuted"
>;
type Outcome = "cancel" | "error" | "edit";
interface Run {
	abort: AbortController;
	text: string;
	draft: string;
	generation: number;
	muted: boolean;
	finishing: boolean;
	settled: boolean;
	session?: Session;
	panel?: DictationPanel;
	starting?: Promise<void>;
	done?: (outcome: Outcome) => void;
	error?: Error;
}

export class DictationController {
	private run: Run | undefined;

	constructor(
		private readonly send: (text: string) => void,
		private readonly createSession = (
			callbacks: CodexDictationCallbacks,
		): Session => new CodexDictationSession(callbacks),
		private readonly resolveAuth = resolveCodexVoiceAuth,
	) {}

	get active(): boolean {
		return this.run !== undefined;
	}

	async open(ctx: ExtensionContext, config: VoiceControlConfig): Promise<void> {
		if (this.run) return;
		if (!ctx.hasUI) {
			ctx.ui.notify("Dictation requires an interactive terminal.", "warning");
			return;
		}
		const run: Run = {
			abort: new AbortController(),
			text: "",
			draft: ctx.ui.getEditorText(),
			generation: 0,
			muted: false,
			finishing: false,
			settled: false,
		};
		this.run = run;
		try {
			const outcome = await ctx.ui.custom<Outcome>(
				(tui, theme, _keys, done) => {
					run.done = done;
					const panel = new DictationPanel({
						theme,
						rows: () => tui.terminal.rows,
						requestRender: () => tui.requestRender(),
						onToggleMute: () => {
							if (run.settled || run.finishing) return;
							run.muted = !run.muted;
							run.session?.setInputMuted(run.muted);
							panel.setPhase(run.muted ? "muted" : "listening");
						},
						onCancel: () => this.cancel(),
						onSend: () => {
							void this.finish(run, ctx, config, "send");
						},
						onFinishToEditor: () => {
							void this.finish(run, ctx, config, "edit");
						},
					});
					run.panel = panel;
					panel.setTranscript(content(run));
					if (run.settled) done("cancel");
					else this.startUtterance(run, ctx, config);
					return panel;
				},
			);
			// OMP restores the draft saved when custom() opened; do not resurrect
			// a draft already included in a successfully sent utterance.
			ctx.ui.setEditorText(outcome === "edit" ? content(run) : run.draft);
			if (outcome === "error") {
				if (run.text.trim()) ctx.ui.setEditorText(content(run));
				ctx.ui.notify(run.error?.message ?? "Dictation failed", "error");
			}
		} catch (error) {
			if (!run.abort.signal.aborted) {
				if (run.text.trim()) ctx.ui.setEditorText(content(run));
				ctx.ui.notify(asError(error).message, "error");
			}
		} finally {
			run.settled = true;
			run.abort.abort();
			await run.session?.close();
			if (this.run === run) this.run = undefined;
		}
	}

	cancel(): void {
		const run = this.run;
		if (!run || run.settled) return;
		run.settled = true;
		run.abort.abort();
		run.done?.("cancel");
		void run.session?.close();
	}

	private startUtterance(
		run: Run,
		ctx: ExtensionContext,
		config: VoiceControlConfig,
	): void {
		const generation = ++run.generation;
		const current = () => !run.settled && run.generation === generation;
		const update = (text: string) => {
			if (!current()) return;
			run.text = text;
			run.panel?.setTranscript(content(run));
		};
		run.panel?.setPhase(run.muted ? "muted" : "connecting");
		const session = this.createSession({
			onError: (error) => {
				if (current()) this.fail(run, error);
			},
			onStatus: (status) => {
				if (!current() || run.finishing) return;
				run.panel?.setPhase(
					run.muted
						? "muted"
						: status === "listening"
							? "listening"
							: "connecting",
				);
			},
			onCaptureStopped: () => {
				if (current()) run.panel?.setPhase("finishing");
			},
			onPreview: update,
			onTranscript: (text) => update(text ?? ""),
		});
		run.session = session;
		session.setInputMuted(run.muted);
		run.starting = (async () => {
			const auth = await this.resolveAuth(ctx, run.abort.signal);
			if (current()) await session.start(auth, config);
		})().catch((error: unknown) => {
			if (current()) this.fail(run, asError(error));
		});
	}

	private async finish(
		run: Run,
		ctx: ExtensionContext,
		config: VoiceControlConfig,
		destination: "send" | "edit",
	): Promise<void> {
		if (run.settled || run.finishing) return;
		run.finishing = true;
		run.panel?.setPhase("finishing");
		try {
			await run.starting;
			if (run.settled) return;
			await run.session?.finish();
			if (run.settled) return;
			await run.session?.close();
			if (run.settled) return;
			if (destination === "edit") {
				run.settled = true;
				run.done?.("edit");
				return;
			}
			if (run.text.trim()) {
				this.send(content(run));
				run.draft = "";
				ctx.ui.setEditorText("");
			} else {
				ctx.ui.notify("No speech was transcribed. Nothing sent.", "warning");
			}
			run.text = "";
			run.finishing = false;
			run.panel?.setTranscript(content(run));
			this.startUtterance(run, ctx, config);
		} catch (error) {
			this.fail(run, asError(error));
		}
	}

	private fail(run: Run, error: Error): void {
		if (run.settled) return;
		run.error = error;
		run.settled = true;
		run.done?.("error");
	}
}

function content(run: Run): string {
	return [run.draft, run.text.trim()]
		.filter((text) => text.trim())
		.join("\n\n");
}

function asError(error: unknown): Error {
	return error instanceof Error ? error : new Error(String(error));
}
