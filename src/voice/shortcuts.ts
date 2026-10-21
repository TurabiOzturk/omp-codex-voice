import type { ExtensionAPI, ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import {
	isKeyRelease,
	isKeyRepeat,
	type KeyId,
	matchesKey,
	parseKey,
} from "@oh-my-pi/pi-tui";
import type { VoiceControlConfig } from "../config.ts";

const INITIAL_RELEASE_FALLBACK_MS = 650;
const REPEAT_RELEASE_FALLBACK_MS = 120;
const DOUBLE_SPACE_SHORTCUT = "double-space";
export const DOUBLE_SPACE_WINDOW_MS = 400;

export interface CodexVoiceShortcutActions {
	dictationActive?(): boolean;
	/** Resolves whether dictation is active once the start settles. */
	startDictation(ctx: ExtensionContext): Promise<boolean>;
	finishDictation(ctx: ExtensionContext): Promise<void>;
	toggleDictation(ctx: ExtensionContext): Promise<void>;
	toggleRealtime(ctx: ExtensionContext): Promise<void>;
	realtimeStartPending(): boolean;
	/** Cancels at once; resolves after the cancelled start's teardown settles. */
	cancelRealtimeStart(ctx: ExtensionContext): Promise<void>;
	toggleInputMute(ctx: ExtensionContext): void;
	toggleServer(ctx: ExtensionContext): Promise<void>;
}

export function registerCodexVoiceShortcuts(
	pi: ExtensionAPI,
	initialConfig: VoiceControlConfig,
	getConfig: () => VoiceControlConfig,
	actions: CodexVoiceShortcutActions,
): void {
	const dictationShortcut = initialConfig.voice.dictationShortcut as KeyId;
	const realtimeShortcut = initialConfig.voice.realtimeShortcut as KeyId;
	const muteShortcut = initialConfig.voice.muteShortcut as KeyId;
	const serverShortcut = initialConfig.voice.serverShortcut as KeyId;
	const usesDoubleSpace =
		initialConfig.voice.dictationShortcut === DOUBLE_SPACE_SHORTCUT;
	const dictationKey = keyIdentity(dictationShortcut);
	let operation = Promise.resolve();
	let removeTerminalInput: (() => void) | undefined;
	let lastSpaceAt = 0;
	// The held push-to-dictate key, from press until release or fallback.
	let dictationPress: { started: boolean } | undefined;
	let releaseFallbackTimer: ReturnType<typeof setTimeout> | undefined;

	const notifyFailure = (ctx: ExtensionContext, error: unknown): void => {
		ctx.ui.notify(
			error instanceof Error ? error.message : String(error),
			"error",
		);
	};
	// Resource acquisition and everything ordered after it run one at a time.
	const enqueue = (
		ctx: ExtensionContext,
		action: () => Promise<void>,
	): Promise<void> => {
		const next = operation.then(action, action);
		operation = next.catch((error: unknown) => notifyFailure(ctx, error));
		return operation;
	};
	// Runs now, but later actions wait for it as well as the current queue.
	const runFenced = (
		ctx: ExtensionContext,
		action: () => Promise<void>,
	): Promise<void> => {
		const done = action().catch((error: unknown) => notifyFailure(ctx, error));
		operation = Promise.all([operation, done]).then(() => undefined);
		return done;
	};
	const clearReleaseFallback = (): void => {
		if (releaseFallbackTimer) clearTimeout(releaseFallbackTimer);
		releaseFallbackTimer = undefined;
	};
	const endDictationPress = (): void => {
		dictationPress = undefined;
		clearReleaseFallback();
	};
	const finishPushDictation = (ctx: ExtensionContext): void => {
		const press = dictationPress;
		if (!press) return;
		endDictationPress();
		void enqueue(ctx, async () => {
			if (press.started) await actions.finishDictation(ctx);
		});
	};
	const armReleaseFallback = (ctx: ExtensionContext, delay: number): void => {
		clearReleaseFallback();
		releaseFallbackTimer = setTimeout(() => finishPushDictation(ctx), delay);
	};

	if (!usesDoubleSpace)
		pi.registerShortcut(dictationShortcut, {
			description: "Pi Voice push-to-dictate",
			handler: (ctx) => {
				if (getConfig().voice.dictationShortcutMode === "toggle") {
					endDictationPress();
					return enqueue(ctx, () => actions.toggleDictation(ctx));
				}
				// Track the key from the press itself so a release that arrives while
				// the start is still queued finishes it right after the start settles.
				const press = { started: false };
				dictationPress = press;
				armReleaseFallback(ctx, INITIAL_RELEASE_FALLBACK_MS);
				return enqueue(ctx, async () => {
					try {
						press.started = await actions.startDictation(ctx);
					} finally {
						if (!press.started && dictationPress === press) endDictationPress();
					}
				});
			},
		});

	if (!usesDoubleSpace) {
		pi.registerShortcut(realtimeShortcut, {
			description: "Toggle Pi Voice realtime voice",
			// Cancelling a pending start must not wait behind that start, and the
			// next start must not overlap the cancelled start's teardown.
			handler: (ctx) =>
				actions.realtimeStartPending()
					? runFenced(ctx, () => actions.cancelRealtimeStart(ctx))
					: enqueue(ctx, () => actions.toggleRealtime(ctx)),
		});
		pi.registerShortcut(muteShortcut, {
			description: "Toggle Pi Voice realtime microphone mute",
			handler: (ctx) => enqueue(ctx, async () => actions.toggleInputMute(ctx)),
		});
		pi.registerShortcut(serverShortcut, {
			description: "Toggle Pi Voice control server",
			handler: (ctx) => enqueue(ctx, () => actions.toggleServer(ctx)),
		});
	}

	pi.on("session_start", (_event, ctx) => {
		removeTerminalInput?.();
		endDictationPress();
		lastSpaceAt = 0;
		removeTerminalInput = ctx.ui.onTerminalInput((data) => {
			if (actions.dictationActive?.()) {
				lastSpaceAt = 0;
				return undefined;
			}
			if (usesDoubleSpace) {
				if (
					matchesKey(data, "space") &&
					!isKeyRepeat(data) &&
					!isKeyRelease(data)
				) {
					const now = Date.now();
					if (lastSpaceAt && now - lastSpaceAt <= DOUBLE_SPACE_WINDOW_MS) {
						lastSpaceAt = 0;
						const text = ctx.ui.getEditorText();
						if (text.endsWith(" ")) ctx.ui.setEditorText(text.slice(0, -1));
						void enqueue(ctx, () => actions.toggleDictation(ctx));
						return { consume: true };
					}
					lastSpaceAt = now;
					return undefined;
				}
				lastSpaceAt = 0;
				return undefined;
			}
			if (
				(matchesKey(data, realtimeShortcut) ||
					matchesKey(data, muteShortcut) ||
					matchesKey(data, serverShortcut)) &&
				isKeyRepeat(data)
			)
				return { consume: true };
			const mode = getConfig().voice.dictationShortcutMode;
			if (mode !== "push") endDictationPress();
			if (
				mode === "push" &&
				dictationPress &&
				keyIdentity(parseKey(data)) === dictationKey
			) {
				if (isKeyRelease(data)) finishPushDictation(ctx);
				else if (matchesKey(data, dictationShortcut))
					armReleaseFallback(ctx, REPEAT_RELEASE_FALLBACK_MS);
				return { consume: true };
			}
			if (!matchesKey(data, dictationShortcut)) return undefined;
			if (isKeyRepeat(data) || isKeyRelease(data)) return { consume: true };
			return undefined;
		});
	});

	pi.on("session_shutdown", () => {
		removeTerminalInput?.();
		removeTerminalInput = undefined;
		endDictationPress();
		lastSpaceAt = 0;
	});
}

function keyIdentity(key: string | undefined): string | undefined {
	return key?.replace(/^(?:(?:ctrl|shift|alt|super)\+)+/, "");
}
