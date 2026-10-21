import type { VoiceControlConfig } from "../../config.ts";

export const MAX_REALTIME_SDP_BYTES = 256 * 1024;

export type CodexRealtimePeerEvent =
	| { type: "state"; state: string }
	| { type: "data"; message: unknown }
	| { type: "playback_activity" }
	| { type: "error"; message: string };

interface CodexRealtimePeerBase {
	onEvent(listener: (event: CodexRealtimePeerEvent) => void): () => void;
	onExit(listener: (error: Error) => void): () => void;
	sendData(message: unknown): void;
	setInputMuted(muted: boolean): void;
	setSpeakerSuppressed(suppressed: boolean): void;
	close(): Promise<void>;
}

export interface CodexRealtimeWebRtcPeer extends CodexRealtimePeerBase {
	readonly kind: "webrtc";
	/** Milliseconds from spawning the helper until it reported ready, once known. */
	readonly spawnToReadyMs?: number | undefined;
	start(config: VoiceControlConfig): Promise<string>;
	applyAnswer(sdp: string): void;
}

export type CodexRealtimePeer = CodexRealtimeWebRtcPeer;
