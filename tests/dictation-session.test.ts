import { expect, test } from "bun:test";
import { DEFAULT_VOICE_CONTROL_CONFIG } from "../src/config.ts";
import { CodexDictationSession } from "../src/voice/dictation/session.ts";
import type { VoiceHelperEvent } from "../src/voice/helper.ts";
import { FakeSocket } from "./helpers/fake-socket.ts";

test("mute flushes earlier audio and discards new microphone frames locally", async () => {
	let captured!: (event: VoiceHelperEvent) => void;
	const helper = {
		start: async () => {},
		stop: async () => {},
		close: async () => {},
		send: () => {},
		onEvent: (listener: typeof captured) => {
			captured = listener;
			return () => {};
		},
		onExit: () => () => {},
	};
	const socket = new FakeSocket();
	const previews: string[] = [];
	const session = new CodexDictationSession(
		{
			onStatus: () => {},
			onError: (error) => {
				throw error;
			},
			onCaptureStopped: () => {},
			onTranscript: () => {},
			onPreview: (text) => previews.push(text),
		},
		helper,
		async () => socket,
	);
	await session.start(
		{
			headers: new Headers(),
			baseUrl: "https://chatgpt.com/backend-api/codex",
			officialCodex: true,
		},
		DEFAULT_VOICE_CONTROL_CONFIG,
	);
	const pcm = {
		type: "pcm",
		audio: Buffer.alloc(960).toString("base64"),
		sample_rate: 24_000,
		num_channels: 1,
	} as const;
	captured(pcm);
	session.setInputMuted(true);
	expect(JSON.parse(socket.sent.at(-1)!).type).toBe(
		"input_audio_buffer.commit",
	);
	const sentAtMute = socket.sent.length;
	captured(pcm);
	captured(pcm);
	expect(socket.sent.length).toBe(sentAtMute);
	socket.emit("message", {
		data: JSON.stringify({
			type: "conversation.item.input_audio_transcription.delta",
			delta: "earlier words",
		}),
	});
	expect(previews).toEqual(["earlier words"]);
	session.setInputMuted(false);
	captured(pcm);
	expect(JSON.parse(socket.sent.at(-1)!).type).toBe(
		"input_audio_buffer.append",
	);
	await session.close();
});
