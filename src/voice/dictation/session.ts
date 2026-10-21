import type { VoiceControlConfig } from "../../config.ts";
import type { CodexVoiceAuth } from "../auth.ts";
import { VoiceHelperClient, type VoiceHelperEvent } from "../helper.ts";
import { CodexDictationTranscriber } from "./transcriber.ts";

type DictationState =
	| "idle"
	| "starting"
	| "recording"
	| "finishing"
	| "failed"
	| "closed";

export interface CodexDictationCallbacks {
	onError(error: Error): void;
	onStatus(status: string): void;
	/** Capture has stopped and the recorded audio is being transcribed. */
	onCaptureStopped(): void;
	/** A completed finish produced this transcript, or none. */
	onTranscript(transcript: string | undefined): void;
	onPreview?(transcript: string): void;
}

export class CodexDictationSession {
	private readonly callbacks: CodexDictationCallbacks;
	private readonly helper: Pick<
		VoiceHelperClient,
		"start" | "stop" | "close" | "send" | "onEvent" | "onExit"
	>;
	private readonly transcriber: CodexDictationTranscriber;
	private state: DictationState = "idle";
	private startupFailure: Error | undefined;
	private muted = false;

	constructor(
		callbacks: CodexDictationCallbacks,
		helper: CodexDictationSession["helper"] = new VoiceHelperClient(),
		connector?: ConstructorParameters<typeof CodexDictationTranscriber>[1],
	) {
		this.callbacks = callbacks;
		this.helper = helper;
		this.transcriber = new CodexDictationTranscriber(
			{
				onError: (error) => this.fail(error),
				onStatus: (status) => this.callbacks.onStatus(status),
				onTranscript: (text) => this.callbacks.onPreview?.(text),
			},
			connector,
		);
		this.helper.onEvent((event) => this.handleHelperEvent(event));
		this.helper.onExit((error) => this.fail(error));
	}

	setInputMuted(muted: boolean): void {
		if (muted === this.muted) return;
		this.muted = muted;
		if (muted && this.state === "recording") this.transcriber.flush();
	}

	async start(auth: CodexVoiceAuth, config: VoiceControlConfig): Promise<void> {
		this.state = "starting";
		this.startupFailure = undefined;
		try {
			await this.helper.start();
			if (this.state !== "starting") {
				if (this.startupFailure) throw this.startupFailure;
				return;
			}
			await this.transcriber.start(auth);
			if (this.state !== "starting") {
				await this.transcriber.close();
				if (this.startupFailure) throw this.startupFailure;
				return;
			}
			this.helper.send({
				type: "start_dictation",
				...(config.voice.inputDevice
					? { microphone: config.voice.inputDevice }
					: {}),
			});
			this.state = "recording";
		} catch (error) {
			const failure = error instanceof Error ? error : new Error(String(error));
			this.fail(failure);
			await this.helper.close();
			throw failure;
		}
	}

	async finish(): Promise<void> {
		if (
			this.state === "closed" ||
			this.state === "failed" ||
			this.state === "idle"
		)
			return;
		this.state = "finishing";
		try {
			await this.helper.stop();
			if (this.state !== "finishing") return;
			this.callbacks.onCaptureStopped();
			const transcript = await this.transcriber.finish();
			// A close or failure while transcribing has no outcome to report.
			if (this.state !== "finishing") return;
			this.callbacks.onTranscript(transcript);
			await this.close();
		} catch (error) {
			this.fail(error instanceof Error ? error : new Error(String(error)));
		}
	}

	async close(): Promise<void> {
		if (this.state === "closed") return;
		this.state = "closed";
		await Promise.all([this.transcriber.close(), this.helper.close()]);
	}

	private handleHelperEvent(event: VoiceHelperEvent): void {
		if (event.type === "error") {
			this.fail(new Error(event.message));
			return;
		}
		if (
			event.type !== "pcm" ||
			this.muted ||
			(this.state !== "recording" && this.state !== "finishing")
		)
			return;
		this.transcriber.append(Buffer.from(event.audio, "base64"));
	}

	private fail(error: Error): void {
		if (
			this.state === "idle" ||
			this.state === "closed" ||
			this.state === "failed"
		)
			return;
		this.state = "failed";
		this.startupFailure = error;
		this.callbacks.onError(error);
		void Promise.all([this.transcriber.close(), this.helper.close()]);
	}
}
