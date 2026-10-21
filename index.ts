import type { ExtensionAPI, ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import { readVoiceControlConfig } from "./src/config-store.ts";
import { DictationController } from "./src/voice/dictation/controller.ts";
import { registerCodexVoiceShortcuts } from "./src/voice/shortcuts.ts";

export default function codexDictation(pi: ExtensionAPI): void {
	const state = { config: readVoiceControlConfig() };
	const controller = new DictationController((text) =>
		pi.sendUserMessage(text),
	);
	const start = async (ctx: ExtensionContext): Promise<boolean> => {
		if (controller.active) return false;
		state.config = readVoiceControlConfig();
		void controller.open(ctx, state.config);
		return controller.active;
	};

	registerCodexVoiceShortcuts(pi, state.config, () => state.config, {
		dictationActive: () => controller.active,
		startDictation: start,
		finishDictation: async () => controller.cancel(),
		toggleDictation: async (ctx) => {
			await start(ctx);
		},
		toggleRealtime: async () => {},
		realtimeStartPending: () => false,
		cancelRealtimeStart: async () => {},
		toggleInputMute: () => {},
		toggleServer: async () => {},
	});

	pi.registerCommand("voice", {
		description:
			"Live Codex dictation · Space mute · Space×2 edit · Enter send · Esc cancel",
		handler: async (_args, ctx) => {
			state.config = readVoiceControlConfig();
			void controller.open(ctx, state.config);
		},
	});

	pi.on("session_shutdown", () => controller.cancel());
}
