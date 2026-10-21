import { describe, expect, test } from "bun:test";
import type { ExtensionAPI, ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import type { VoiceControlConfig } from "../src/config.ts";
import {
	type CodexVoiceShortcutActions,
	registerCodexVoiceShortcuts,
} from "../src/voice/shortcuts.ts";

function setup() {
	let editorText = "hello";
	let terminalInput:
		| ((data: string) => { consume?: boolean } | undefined)
		| undefined;
	let sessionStart:
		| ((event: unknown, ctx: ExtensionContext) => void)
		| undefined;
	const registeredShortcuts: string[] = [];
	let toggles = 0;
	let active = false;

	const pi = {
		registerShortcut(shortcut: string) {
			registeredShortcuts.push(shortcut);
		},
		on(
			event: string,
			handler: (event: unknown, ctx: ExtensionContext) => void,
		) {
			if (event === "session_start") sessionStart = handler;
		},
	} as unknown as ExtensionAPI;
	const config = {
		voice: {
			dictationShortcut: "double-space",
			dictationShortcutMode: "toggle",
			realtimeShortcut: "ctrl+alt+space",
			muteShortcut: "ctrl+alt+m",
			serverShortcut: "ctrl+alt+g",
		},
	} as VoiceControlConfig;
	const actions = {
		dictationActive: () => active,
		toggleDictation: async () => {
			toggles++;
		},
		startDictation: async () => false,
		finishDictation: async () => {},
		toggleRealtime: async () => {},
		realtimeStartPending: () => false,
		cancelRealtimeStart: async () => {},
		toggleInputMute: () => {},
		toggleServer: async () => {},
	} satisfies CodexVoiceShortcutActions;
	const ctx = {
		ui: {
			onTerminalInput(handler: typeof terminalInput) {
				terminalInput = handler;
				return () => {};
			},
			getEditorText: () => editorText,
			setEditorText: (text: string) => {
				editorText = text;
			},
			notify: () => {},
		},
	} as unknown as ExtensionContext;

	registerCodexVoiceShortcuts(pi, config, () => config, actions);
	sessionStart?.({}, ctx);

	return {
		input(data: string) {
			if (!terminalInput)
				throw new Error("terminal listener was not registered");
			return terminalInput(data);
		},
		insert(text: string) {
			editorText += text;
		},
		registeredShortcuts,
		text: () => editorText,
		toggles: () => toggles,
		activate: () => {
			active = true;
		},
	};
}

describe("double-Space dictation gesture", () => {
	test("leaves Space, Escape, and Enter to the focused panel while dictation is active", async () => {
		const harness = setup();
		harness.activate();
		for (const key of [" ", " ", "\x1b", "\r"])
			expect(harness.input(key)).toBeUndefined();
		await Promise.resolve();
		expect(harness.toggles()).toBe(0);
		expect(harness.text()).toBe("hello");
	});
	test("toggles dictation and removes the gesture space from the editor", async () => {
		const harness = setup();

		expect(harness.input(" ")).toBeUndefined();
		harness.insert(" ");
		expect(harness.input(" ")).toEqual({ consume: true });
		await Promise.resolve();

		expect(harness.text()).toBe("hello");
		expect(harness.toggles()).toBe(1);
		expect(harness.registeredShortcuts).toEqual([]);
	});

	test("does not trigger when another key occurs between spaces", async () => {
		const harness = setup();

		harness.input(" ");
		harness.insert(" ");
		harness.input("x");
		harness.insert("x");
		expect(harness.input(" ")).toBeUndefined();
		await Promise.resolve();

		expect(harness.text()).toBe("hello x");
		expect(harness.toggles()).toBe(0);
	});
});
