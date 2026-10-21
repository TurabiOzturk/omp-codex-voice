import { expect, test } from "bun:test";
import { CodexDictationTranscriber } from "../src/voice/dictation/transcriber.ts";
import { FakeSocket } from "./helpers/fake-socket.ts";

const auth = {
	headers: new Headers({ authorization: "Bearer test" }),
	baseUrl: "https://chatgpt.com/backend-api/codex",
	officialCodex: true,
};

test("uses live transcription and publishes deltas before committing the utterance", async () => {
	const socket = new FakeSocket();
	const transcripts: string[] = [];
	const transcriber = new CodexDictationTranscriber(
		{
			onError: (error) => {
				throw error;
			},
			onStatus: () => {},
			onTranscript: (text: string) => transcripts.push(text),
		},
		async () => socket,
	);

	await transcriber.start(auth);
	expect(
		JSON.parse(socket.sent[0]).session.audio.input.transcription.model,
	).toBe("gpt-live-transcribe");
	transcriber.append(Buffer.alloc(100_000));

	expect(socket.sent.map((message) => JSON.parse(message).type)).not.toContain(
		"input_audio_buffer.commit",
	);
	socket.emit("message", {
		data: JSON.stringify({
			type: "conversation.item.input_audio_transcription.delta",
			delta: "hello",
		}),
	});
	expect(transcripts).toEqual(["hello"]);

	socket.emit("message", {
		data: JSON.stringify({
			type: "conversation.item.input_audio_transcription.completed",
			transcript: "hello world",
		}),
	});
	expect(transcripts).toEqual(["hello", "hello world"]);
	await transcriber.close();
});

test("waits for every segment and keeps audio order when completions arrive out of order", async () => {
	const socket = new FakeSocket();
	const previews: string[] = [];
	const transcriber = new CodexDictationTranscriber(
		{
			onError: (error) => {
				throw error;
			},
			onStatus: () => {},
			onTranscript: (text) => previews.push(text),
		},
		async () => socket,
	);
	await transcriber.start(auth);
	transcriber.append(Buffer.alloc(96_000));
	transcriber.flush();
	transcriber.append(Buffer.alloc(96_000));
	transcriber.flush();
	for (const item_id of ["first", "second"])
		socket.emit("message", {
			data: JSON.stringify({ type: "input_audio_buffer.committed", item_id }),
		});
	let finished = false;
	const result = transcriber.finish().then((text) => {
		finished = true;
		return text;
	});
	socket.emit("message", {
		data: JSON.stringify({
			type: "conversation.item.input_audio_transcription.completed",
			item_id: "second",
			transcript: "second sentence",
		}),
	});
	await Promise.resolve();
	expect(finished).toBe(false);
	socket.emit("message", {
		data: JSON.stringify({
			type: "conversation.item.input_audio_transcription.completed",
			item_id: "first",
			transcript: "first sentence",
		}),
	});
	expect(await result).toBe("first sentence second sentence");
	expect(previews.at(-1)).toBe("first sentence second sentence");
});

test("flushes a short final tail before sending", async () => {
	const socket = new FakeSocket();
	const transcriber = new CodexDictationTranscriber(
		{
			onError: (error) => {
				throw error;
			},
			onStatus: () => {},
		},
		async () => socket,
	);
	await transcriber.start(auth);
	transcriber.append(Buffer.alloc(960));
	const result = transcriber.finish();
	const messages = socket.sent.map((message) => JSON.parse(message));
	expect(messages.at(-1).type).toBe("input_audio_buffer.commit");
	expect(Buffer.from(messages.at(-2).audio, "base64").length).toBe(3840);
	socket.emit("message", {
		data: JSON.stringify({
			type: "conversation.item.input_audio_transcription.completed",
			transcript: "last word",
		}),
	});
	expect(await result).toBe("last word");
});

test("flushes preview words on mute without ending the stream", async () => {
	const socket = new FakeSocket();
	const transcriber = new CodexDictationTranscriber(
		{
			onError: (error) => {
				throw error;
			},
			onStatus: () => {},
		},
		async () => socket,
	);
	await transcriber.start(auth);
	transcriber.append(Buffer.alloc(960));
	transcriber.flush();
	expect(socket.sent.map((message) => JSON.parse(message).type).at(-1)).toBe(
		"input_audio_buffer.commit",
	);
	transcriber.append(Buffer.alloc(960));
	expect(JSON.parse(socket.sent.at(-1)!).type).toBe(
		"input_audio_buffer.append",
	);
	await transcriber.close();
});
