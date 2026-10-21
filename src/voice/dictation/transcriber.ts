import type { WebSocketLike } from "../../openai/types.ts";
import {
	closeWebSocketSilently,
	connectWebSocket,
	extractWebSocketError,
	webSocketBufferedAmount,
} from "../../openai/websocket-connection.ts";
import type { CodexVoiceAuth } from "../auth.ts";

const MIN_AUDIO_BYTES = 4_800;
const COMPLETION_TIMEOUT_MS = 10_000;
const MAX_TRANSCRIPTION_EVENT_BYTES = 72 * 1024;
const MAX_TRANSCRIPT_BYTES = 64 * 1024;
// 24 kHz mono PCM16 is 48 bytes/ms. Base64 inflates it by 4/3 and each 20 ms
// append adds a 47-byte JSON envelope: 66,350 wire bytes per second of audio.
const PCM_BYTES_PER_MS = 48;
const UPLOAD_WIRE_BYTES_PER_SECOND = 66_350;
// Five seconds of unsent audio rides out a brief Wi-Fi or mobile stall while
// bounding memory to ~330 kB and leaving post-release latency in the same range
// as the completion window, instead of accumulating minutes of speech.
const MAX_UPLOAD_BACKLOG_SECONDS = 5;
export const MAX_UPLOAD_BACKLOG_BYTES =
	MAX_UPLOAD_BACKLOG_SECONDS * UPLOAD_WIRE_BYTES_PER_SECOND;
const MAX_UPLOAD_BACKLOG_AGE_MS = MAX_UPLOAD_BACKLOG_SECONDS * 1_000;
// A full five-second backlog still uploads at half the real-time rate.
export const UPLOAD_DRAIN_TIMEOUT_MS = 10_000;
const UPLOAD_DRAIN_POLL_MS = 50;
export const DICTATION_CONGESTION_MESSAGE = `Codex dictation stopped: audio upload fell more than ${MAX_UPLOAD_BACKLOG_SECONDS} seconds behind. Check your network connection and try again.`;

interface PendingSend {
	/** Cumulative submitted byte offset after this message. */
	end: number;
	sentAt: number;
	/** Estimated drain time when the socket does not report `bufferedAmount`. */
	estimatedDrainedAt: number;
}

type TranscriberState =
	| "idle"
	| "starting"
	| "recording"
	| "finishing"
	| "failed"
	| "closed";

export interface CodexDictationTranscriberCallbacks {
	onError(error: Error): void;
	onStatus(status: string): void;
	onTranscript?(text: string): void;
}

export class CodexDictationTranscriber {
	private readonly callbacks: CodexDictationTranscriberCallbacks;
	private readonly connector: typeof connectWebSocket;
	private state: TranscriberState = "idle";
	private socket: WebSocketLike | undefined;
	private audioBytes = 0;
	private readonly segments: Array<{
		id?: string;
		text: string;
		final: boolean;
	}> = [];
	private submittedBytes = 0;
	private drainedBytes = 0;
	private pendingSends: PendingSend[] = [];
	private estimatedLinkFreeAt = 0;
	private completion:
		| ReturnType<typeof Promise.withResolvers<string | undefined>>
		| undefined;
	private setupAbortController: AbortController | undefined;

	constructor(
		callbacks: CodexDictationTranscriberCallbacks,
		connector: typeof connectWebSocket = connectWebSocket,
	) {
		this.callbacks = callbacks;
		this.connector = connector;
	}

	async start(auth: CodexVoiceAuth): Promise<void> {
		if (!auth.officialCodex)
			throw new Error(
				"Codex dictation does not support custom provider base URLs",
			);
		this.state = "starting";
		const setupAbortController = new AbortController();
		this.setupAbortController = setupAbortController;
		try {
			const socket = await this.connector(
				"wss://api.openai.com/v1/realtime?intent=transcription",
				new Headers(auth.headers),
				setupAbortController.signal,
				10_000,
				auth.env,
			);
			if (this.state !== "starting") {
				closeWebSocketSilently(socket);
				return;
			}
			this.socket = socket;
			socket.addEventListener("message", (event) => this.receive(event));
			socket.addEventListener("error", (event) =>
				this.fail(extractWebSocketError(event)),
			);
			socket.addEventListener("close", (event) => {
				if (this.state !== "closed" && this.state !== "failed")
					this.fail(new Error(`Codex dictation closed${closeReason(event)}`));
			});
			this.send(socket, JSON.stringify(buildDictationSessionUpdate()));
			this.state = "recording";
			this.callbacks.onStatus("listening");
		} catch (error) {
			const failure = error instanceof Error ? error : new Error(String(error));
			this.fail(failure);
			throw failure;
		} finally {
			if (this.setupAbortController === setupAbortController)
				this.setupAbortController = undefined;
		}
	}

	append(pcm: Buffer): void {
		if (this.state !== "recording" || !this.socket || pcm.byteLength === 0)
			return;
		const message = JSON.stringify({
			type: "input_audio_buffer.append",
			audio: pcm.toString("base64"),
		});
		const backlog = this.uploadBacklog(this.socket);
		if (
			backlog.bytes + Buffer.byteLength(message) > MAX_UPLOAD_BACKLOG_BYTES ||
			backlog.ageMs > MAX_UPLOAD_BACKLOG_AGE_MS
		) {
			this.fail(new Error(DICTATION_CONGESTION_MESSAGE));
			return;
		}
		// Live transcription can emit deltas before commit. Track the current
		// utterance as soon as its audio arrives, rather than after slicing it.
		if (this.audioBytes === 0) this.segments.push({ text: "", final: false });
		this.audioBytes += pcm.byteLength;
		this.send(this.socket, message, pcm.byteLength / PCM_BYTES_PER_MS);
	}

	async finish(): Promise<string | undefined> {
		if (this.state !== "recording" || !this.socket) {
			await this.close();
			return undefined;
		}
		this.state = "finishing";
		this.callbacks.onStatus("transcribing");
		if (
			this.audioBytes === 0 &&
			this.segments.every((segment) => segment.final)
		) {
			const transcript = this.transcript();
			await this.close();
			return transcript || undefined;
		}
		const socket = this.socket;
		const completion = Promise.withResolvers<string | undefined>();
		this.completion = completion;
		this.flush();
		let timeout: ReturnType<typeof setTimeout> | undefined;
		try {
			return await Promise.race([
				completion.promise,
				new Promise<never>((_resolve, reject) => {
					// The completion window starts only after audio and commit have
					// left the socket, so it measures server work rather than upload.
					const drainStartedAt = performance.now();
					const waitForUpload = () => {
						if (this.socket !== socket) return;
						if (this.uploadBacklog(socket).bytes === 0) {
							timeout = setTimeout(
								() =>
									reject(new Error("Codex dictation transcription timed out")),
								COMPLETION_TIMEOUT_MS,
							);
							return;
						}
						if (performance.now() - drainStartedAt >= UPLOAD_DRAIN_TIMEOUT_MS) {
							reject(
								new Error(
									`Codex dictation could not finish uploading audio within ${UPLOAD_DRAIN_TIMEOUT_MS / 1_000} seconds`,
								),
							);
							return;
						}
						timeout = setTimeout(waitForUpload, UPLOAD_DRAIN_POLL_MS);
					};
					waitForUpload();
				}),
			]);
		} finally {
			if (timeout) clearTimeout(timeout);
			if (this.completion === completion) this.completion = undefined;
			await this.close();
		}
	}

	/** Flush words spoken before mute, or the final tail before Enter. */
	flush(): void {
		if (
			!this.socket ||
			this.audioBytes === 0 ||
			(this.state !== "recording" && this.state !== "finishing")
		)
			return;
		// A short tail still contains words; pad to the service's 100 ms minimum.
		if (this.audioBytes < MIN_AUDIO_BYTES)
			this.send(
				this.socket,
				JSON.stringify({
					type: "input_audio_buffer.append",
					audio: Buffer.alloc(MIN_AUDIO_BYTES - this.audioBytes).toString(
						"base64",
					),
				}),
			);
		this.commit();
	}

	async close(): Promise<void> {
		if (this.state === "closed") return;
		this.state = "closed";
		this.setupAbortController?.abort();
		this.setupAbortController = undefined;
		this.completion?.resolve(undefined);
		this.completion = undefined;
		if (this.socket) closeWebSocketSilently(this.socket);
		this.socket = undefined;
	}

	private send(socket: WebSocketLike, message: string, audioMs = 0): void {
		socket.send(message);
		const now = performance.now();
		this.submittedBytes += Buffer.byteLength(message);
		this.estimatedLinkFreeAt =
			Math.max(now, this.estimatedLinkFreeAt) + audioMs;
		this.pendingSends.push({
			end: this.submittedBytes,
			sentAt: now,
			estimatedDrainedAt: this.estimatedLinkFreeAt,
		});
	}

	private commit(): void {
		if (!this.socket || this.audioBytes === 0) return;
		this.audioBytes = 0;
		this.send(
			this.socket,
			JSON.stringify({ type: "input_audio_buffer.commit" }),
		);
	}

	private transcript(): string {
		return this.segments
			.map((segment) => segment.text.trim())
			.filter(Boolean)
			.join(" ");
	}

	private segmentFor(event: Record<string, unknown>) {
		const id =
			typeof event["item_id"] === "string" ? event["item_id"] : undefined;
		let segment = id
			? this.segments.find((entry) => entry.id === id)
			: undefined;
		segment ??= this.segments.find((entry) => !entry.id && !entry.final);
		if (segment && id) segment.id = id;
		return segment;
	}

	private publish(): void {
		const transcript = this.transcript();
		if (Buffer.byteLength(transcript) > MAX_TRANSCRIPT_BYTES) {
			this.fail(new Error("Codex dictation returned an oversized transcript"));
			return;
		}
		this.callbacks.onTranscript?.(transcript);
		if (
			this.state === "finishing" &&
			this.segments.every((segment) => segment.final)
		)
			this.completion?.resolve(transcript || undefined);
	}

	/**
	 * Returns submitted bytes the socket has not drained and the age of the
	 * oldest such message. Without `bufferedAmount`, assume the link drains no
	 * faster than real-time audio and count a partly drained message in full.
	 */
	private uploadBacklog(socket: WebSocketLike): {
		bytes: number;
		ageMs: number;
	} {
		const now = performance.now();
		const buffered = webSocketBufferedAmount(socket);
		if (buffered !== undefined)
			this.drainedBytes = Math.max(
				this.drainedBytes,
				this.submittedBytes - buffered,
			);
		let drained = 0;
		for (const pending of this.pendingSends) {
			const sent =
				buffered === undefined
					? pending.estimatedDrainedAt <= now
					: pending.end <= this.drainedBytes;
			if (!sent) break;
			if (buffered === undefined) this.drainedBytes = pending.end;
			drained += 1;
		}
		if (drained > 0) this.pendingSends = this.pendingSends.slice(drained);
		const oldest = this.pendingSends[0];
		return {
			bytes: this.submittedBytes - this.drainedBytes,
			ageMs: oldest ? now - oldest.sentAt : 0,
		};
	}

	private receive(raw: unknown): void {
		if (
			this.state === "idle" ||
			this.state === "closed" ||
			this.state === "failed"
		)
			return;
		if (
			!raw ||
			typeof raw !== "object" ||
			!("data" in raw) ||
			typeof raw.data !== "string"
		) {
			this.fail(new Error("Codex dictation emitted an invalid event"));
			return;
		}
		if (Buffer.byteLength(raw.data) > MAX_TRANSCRIPTION_EVENT_BYTES) {
			this.fail(new Error("Codex dictation emitted an oversized event"));
			return;
		}
		let event: Record<string, unknown>;
		try {
			const value = JSON.parse(raw.data) as unknown;
			if (!value || typeof value !== "object" || Array.isArray(value))
				throw new Error();
			event = value as Record<string, unknown>;
		} catch {
			this.fail(new Error("Codex dictation emitted an invalid event"));
			return;
		}
		if (event["type"] === "error") {
			this.fail(new Error(remoteError(event)));
			return;
		}
		if (event["type"] === "input_audio_buffer.committed") {
			this.segmentFor(event);
			return;
		}
		if (
			event["type"] === "conversation.item.input_audio_transcription.failed"
		) {
			this.fail(new Error(remoteError(event)));
			return;
		}
		if (
			event["type"] === "conversation.item.input_audio_transcription.delta" &&
			typeof event["delta"] === "string"
		) {
			const segment = this.segmentFor(event);
			if (segment && !segment.final) {
				segment.text += event["delta"];
				this.publish();
			}
			return;
		}
		if (
			event["type"] ===
				"conversation.item.input_audio_transcription.completed" ||
			event["type"] === "input_audio_transcription.completed"
		) {
			if (typeof event["transcript"] !== "string") {
				this.fail(new Error("Codex dictation returned an invalid transcript"));
				return;
			}
			const transcript = event["transcript"].trim();
			if (Buffer.byteLength(transcript) > MAX_TRANSCRIPT_BYTES) {
				this.fail(
					new Error("Codex dictation returned an oversized transcript"),
				);
				return;
			}
			const segment = this.segmentFor(event);
			if (segment) {
				segment.text = transcript;
				segment.final = true;
				this.publish();
			}
		}
	}

	private fail(error: Error): void {
		if (
			this.state === "idle" ||
			this.state === "closed" ||
			this.state === "failed"
		)
			return;
		this.state = "failed";
		this.setupAbortController?.abort();
		this.setupAbortController = undefined;
		this.completion?.reject(error);
		this.completion = undefined;
		if (this.socket) closeWebSocketSilently(this.socket);
		this.socket = undefined;
		this.callbacks.onError(error);
	}
}

function buildDictationSessionUpdate(): Record<string, unknown> {
	return {
		type: "session.update",
		session: {
			type: "transcription",
			audio: {
				input: {
					format: { type: "audio/pcm", rate: 24_000 },
					noise_reduction: { type: "near_field" },
					transcription: { model: "gpt-live-transcribe" },
					turn_detection: null,
				},
			},
		},
	};
}

function remoteError(event: Record<string, unknown>): string {
	if (typeof event["message"] === "string") return event["message"];
	const error = event["error"];
	return error &&
		typeof error === "object" &&
		typeof (error as Record<string, unknown>)["message"] === "string"
		? ((error as Record<string, unknown>)["message"] as string)
		: "Codex dictation error";
}

function closeReason(event: unknown): string {
	if (!event || typeof event !== "object") return "";
	const value = event as Record<string, unknown>;
	return `${typeof value["code"] === "number" ? ` (${value["code"]})` : ""}${typeof value["reason"] === "string" && value["reason"] ? `: ${value["reason"]}` : ""}`;
}
