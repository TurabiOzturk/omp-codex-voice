import { expect, test } from "bun:test";
import { resolveCodexVoiceAuth } from "../src/voice/auth.ts";

test("resolves the existing OMP Codex OAuth credential", async () => {
	const calls: unknown[][] = [];
	const ctx = {
		modelRegistry: {
			authStorage: {
				oauth: {
					access: async (...args: unknown[]) => {
						calls.push(args);
						return {
							accessToken: "codex-subscription-token",
							accountId: "account-123",
						};
					},
				},
			},
		},
		sessionManager: {
			getSessionId: () => "session-456",
		},
	};

	const auth = await resolveCodexVoiceAuth(ctx);

	expect(calls).toEqual([["openai-codex", "session-456", undefined]]);
	expect(auth.headers.get("authorization")).toBe(
		"Bearer codex-subscription-token",
	);
	expect(auth.headers.get("chatgpt-account-id")).toBe("account-123");
	expect(auth.baseUrl).toBe("https://chatgpt.com/backend-api/codex");
	expect(auth.officialCodex).toBe(true);
});

test("fails clearly when OMP has no Codex login", async () => {
	const ctx = {
		modelRegistry: {
			authStorage: {
				oauth: {
					access: async () => undefined,
				},
			},
		},
		sessionManager: {
			getSessionId: () => "session-456",
		},
	};

	await expect(resolveCodexVoiceAuth(ctx)).rejects.toThrow(
		"No OMP Codex OAuth credential is available. Run /login openai-codex.",
	);
});
