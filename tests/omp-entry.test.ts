import { expect, test } from "bun:test";
import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import codexDictation from "../index.ts";

test("loads against OMP's extension API without Pi-only renderer methods", () => {
	const commands: string[] = [];
	const events: string[] = [];
	const pi = {
		registerCommand(name: string) {
			commands.push(name);
		},
		on(event: string) {
			events.push(event);
		},
	} as unknown as ExtensionAPI;

	expect(() => codexDictation(pi)).not.toThrow();
	expect(commands).toContain("voice");
	expect(events).toContain("session_start");
	expect(events).toContain("session_shutdown");
});
