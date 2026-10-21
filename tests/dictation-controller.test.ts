import { expect, test } from "bun:test";
import type { ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import { DEFAULT_VOICE_CONTROL_CONFIG } from "../src/config.ts";
import { DictationController } from "../src/voice/dictation/controller.ts";
import type { DictationPanel } from "../src/voice/dictation/panel.ts";
import type { CodexDictationCallbacks } from "../src/voice/dictation/session.ts";

function setup() {
	let panel!: DictationPanel;
	let callbacks!: CodexDictationCallbacks;
	let draft = "Existing draft";
	const sent: string[] = [];
	const mutes: boolean[] = [];
	const notices: string[] = [];
	const final = Promise.withResolvers<void>();
	let finishCalls = 0;
	let closes = 0;
	const utterances: Array<{
		callbacks: CodexDictationCallbacks;
		final: ReturnType<typeof Promise.withResolvers<void>>;
		transcript: string;
	}> = [];
	const controller = new DictationController(
		(text) => sent.push(text),
		(next) => {
			callbacks = next;
			const utterance = {
				callbacks: next,
				final: utterances.length ? Promise.withResolvers<void>() : final,
				transcript: utterances.length
					? "Second message."
					: "All the final words.",
			};
			utterances.push(utterance);
			return {
				start: async () => {
					next.onStatus("listening");
				},
				setInputMuted: (value) => mutes.push(value),
				finish: async () => {
					finishCalls++;
					await utterance.final.promise;
					next.onTranscript(utterance.transcript);
				},
				close: async () => {
					closes++;
				},
			};
		},
		async () => ({
			headers: new Headers(),
			baseUrl: "https://chatgpt.com/backend-api/codex",
			officialCodex: true,
		}),
	);
	const ctx = {
		hasUI: true,
		mode: "tui",
		ui: {
			getEditorText: () => draft,
			setEditorText: (text: string) => {
				draft = text;
			},
			notify: (text: string) => notices.push(text),
			custom: (factory: Function) => {
				const savedDraft = draft;
				return new Promise((done) => {
					panel = factory(
						{ terminal: { rows: 40 }, requestRender: () => {} },
						{ fg: (_color: string, text: string) => text },
						{},
						(result: unknown) => {
							draft = savedDraft;
							done(result);
						},
					);
				});
			},
		},
	} as unknown as ExtensionContext;
	const running = controller.open(ctx, DEFAULT_VOICE_CONTROL_CONFIG);
	return {
		controller,
		running,
		sent,
		mutes,
		notices,
		final,
		panel: () => panel,
		preview: (text: string) => callbacks.onPreview?.(text),
		fail: (error: Error) => callbacks.onError(error),
		draft: () => draft,
		finishCalls: () => finishCalls,
		closes: () => closes,
		utterances,
	};
}

test("Enter waits for final words and sends once, including the existing draft", async () => {
	const h = setup();
	await Bun.sleep(0);
	h.preview("Some partial words");
	const visible = h.panel().render(80).join("\n");
	expect(visible).toContain("Existing draft");
	expect(visible).toContain("Some partial words");
	h.panel().handleInput(" ");
	h.panel().handleInput("\x1b[D");
	h.panel().handleInput(" ");
	expect(h.mutes).toEqual([false, true, false]);
	h.panel().handleInput("\r");
	h.panel().handleInput("\r");
	await Bun.sleep(0);
	expect(h.sent).toEqual([]);
	expect(h.finishCalls()).toBe(1);
	h.final.resolve();
	await Bun.sleep(0);
	expect(h.sent).toEqual(["Existing draft\n\nAll the final words."]);
	expect(h.draft()).toBe("");
	expect(h.controller.active).toBe(true);
	expect(h.utterances.length).toBe(2);
	expect(h.panel().render(80).join("\n")).not.toContain("All the final words.");
	h.controller.cancel();
	await h.running;
	expect(h.controller.active).toBe(false);
});

test("continues previewing and sending a second utterance without reopening the panel", async () => {
	const h = setup();
	await Bun.sleep(0);
	const original = h.panel();
	h.panel().handleInput("\r");
	h.final.resolve();
	await Bun.sleep(0);
	expect(h.utterances.length).toBe(2);
	h.preview("Another thought while the agent is answering");
	expect(h.panel()).toBe(original);
	expect(original.render(80).join("\n")).toContain("Another thought while");
	h.utterances[0].callbacks.onPreview?.("STALE PREVIEW");
	h.utterances[0].callbacks.onError(new Error("stale socket closed"));
	expect(h.controller.active).toBe(true);
	expect(original.render(80).join("\n")).not.toContain("STALE PREVIEW");
	original.handleInput("\r");
	h.utterances[1].final.resolve();
	await Bun.sleep(0);
	expect(h.sent).toEqual([
		"Existing draft\n\nAll the final words.",
		"Second message.",
	]);
	h.controller.cancel();
	await h.running;
	expect(h.draft()).toBe("");
});

test("a muted send remains muted when the next utterance starts", async () => {
	const h = setup();
	await Bun.sleep(0);
	h.panel().handleInput(" ");
	h.panel().handleInput("\r");
	h.final.resolve();
	await Bun.sleep(0);
	expect(h.utterances.length).toBe(2);
	expect(h.mutes.at(-1)).toBe(true);
	expect(h.panel().render(80).join("\n")).toContain("Muted");
	h.controller.cancel();
	await h.running;
});

test("Enter without speech keeps voice mode open and does not send the saved draft alone", async () => {
	const h = setup();
	await Bun.sleep(0);
	h.utterances[0].transcript = "";
	h.panel().handleInput("\r");
	h.final.resolve();
	await Bun.sleep(0);
	expect(h.sent).toEqual([]);
	expect(h.controller.active).toBe(true);
	expect(h.utterances.length).toBe(2);
	expect(h.notices).toContain("No speech was transcribed. Nothing sent.");
	h.controller.cancel();
	await h.running;
	expect(h.draft()).toBe("Existing draft");
});

test("Escape during finalization discards dictation and preserves the existing draft", async () => {
	const h = setup();
	await Bun.sleep(0);
	h.preview("Private unfinished text");
	h.panel().handleInput("\r");
	await Bun.sleep(0);
	h.panel().handleInput("\x1b");
	await h.running;
	h.final.resolve();
	await Bun.sleep(0);
	expect(h.sent).toEqual([]);
	expect(h.draft()).toBe("Existing draft");
	expect(h.closes()).toBeGreaterThan(0);
});

test("a connection failure preserves already transcribed words for recovery", async () => {
	const h = setup();
	await Bun.sleep(0);
	h.preview("Words already recognized");
	h.fail(new Error("connection lost"));
	await h.running;
	expect(h.sent).toEqual([]);
	expect(h.draft()).toBe("Existing draft\n\nWords already recognized");
	expect(h.notices).toContain("connection lost");
});

test("double-Space waits for final words and leaves an editable unsent draft", async () => {
	const h = setup();
	await Bun.sleep(0);
	h.preview("Partial words");
	h.panel().handleInput(" ");
	h.panel().handleInput(" ");
	h.panel().handleInput("\r");
	await Bun.sleep(0);
	expect(h.finishCalls()).toBe(1);
	expect(h.sent).toEqual([]);
	expect(h.controller.active).toBe(true);
	h.final.resolve();
	await Bun.sleep(0);
	expect(h.controller.active).toBe(false);
	expect(h.draft()).toBe("Existing draft\n\nAll the final words.");
	expect(h.sent).toEqual([]);
	expect(h.utterances.length).toBe(1);
	expect(h.closes()).toBeGreaterThan(0);
	h.preview("Late words must not replace the editable draft");
	expect(h.draft()).toBe("Existing draft\n\nAll the final words.");
	h.controller.cancel();
	await h.running;
});

test("Escape cancels finishing to the editor without restoring late transcript text", async () => {
	const h = setup();
	await Bun.sleep(0);
	h.preview("Unsent words");
	h.panel().handleInput(" ");
	h.panel().handleInput(" ");
	await Bun.sleep(0);
	h.panel().handleInput("\x1b");
	await h.running;
	h.final.resolve();
	await Bun.sleep(0);
	expect(h.controller.active).toBe(false);
	expect(h.sent).toEqual([]);
	expect(h.draft()).toBe("Existing draft");
});
