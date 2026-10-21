import { expect, setSystemTime, test } from "bun:test";
import {
	setKittyProtocolActive,
	stripTerminalSequences,
	visibleWidth,
} from "@oh-my-pi/pi-tui";
import { DictationPanel } from "../src/voice/dictation/panel.ts";

function panelSetup() {
	const actions: string[] = [];
	const panel = new DictationPanel({
		theme: { fg: (_color: string, text: string) => text },
		rows: () => 40,
		requestRender: () => {},
		onToggleMute: () => actions.push("mute"),
		onCancel: () => actions.push("cancel"),
		onSend: () => actions.push("send"),
		onFinishToEditor: () => actions.push("edit"),
	});
	return { panel, actions };
}

test("Space toggles mute, Escape cancels, and Enter submits the live transcript", () => {
	const { panel, actions } = panelSetup();
	panel.handleInput(" ");
	panel.handleInput("\x1b");
	panel.handleInput("\r");
	expect(actions).toEqual(["mute", "cancel", "send"]);
});

test("two quick Space presses finish to the editor instead of unmuting", () => {
	setKittyProtocolActive(true);
	try {
		const { panel, actions } = panelSetup();
		panel.handleInput(" ");
		panel.handleInput("\x1b[32;1:3u");
		panel.handleInput(" ");
		expect(actions).toEqual(["mute", "edit"]);
	} finally {
		setKittyProtocolActive(false);
	}
});

test("Space presses separated by another key do not finish dictation", () => {
	const { panel, actions } = panelSetup();
	panel.handleInput(" ");
	panel.handleInput("\x1b[D");
	panel.handleInput(" ");
	expect(actions).toEqual(["mute", "mute"]);
});

test("slow Space presses and held-key repeats do not finish dictation", () => {
	setKittyProtocolActive(true);
	try {
		setSystemTime(new Date(0));
		const { panel, actions } = panelSetup();
		panel.handleInput(" ");
		setSystemTime(new Date(401));
		panel.handleInput(" ");
		panel.handleInput("\x1b[32;1:2u");
		expect(actions).toEqual(["mute", "mute"]);
	} finally {
		setSystemTime();
		setKittyProtocolActive(false);
	}
});

test("renders a large wrapped transcript and keeps long dictation inside the screen", () => {
	const { panel } = panelSetup();
	panel.setTranscript(
		"This is a long spoken sentence with several words. ".repeat(60) +
			"LATEST WORDS",
	);
	const lines = panel.render(60);
	expect(lines.length).toBeGreaterThan(20);
	expect(lines.length).toBeLessThanOrEqual(24);
	expect(lines.every((line) => visibleWidth(line) <= 60)).toBe(true);
	expect(lines.map(stripTerminalSequences).join("\n")).toContain(
		"LATEST WORDS",
	);
	panel.handleInput("\x1b[5~");
	expect(panel.render(60).map(stripTerminalSequences).join("\n")).not.toContain(
		"LATEST WORDS",
	);
});

test("displays muted state and removes terminal controls from recognized speech", () => {
	const { panel } = panelSetup();
	panel.setPhase("muted");
	panel.setTranscript("hello\x1b[2Jworld\x07");
	const output = panel.render(80).join("\n");
	expect(output).toContain("Muted");
	expect(output).toContain("helloworld");
	expect(output).not.toContain("\x1b[2J");
	expect(output).not.toContain("\x07");
});
