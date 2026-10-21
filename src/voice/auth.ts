import type { ExtensionContext } from "@oh-my-pi/pi-coding-agent";

const CODEX_PROVIDER = "openai-codex";
const CODEX_BASE_URL = "https://chatgpt.com/backend-api/codex";

export interface CodexVoiceAuth {
	headers: Headers;
	baseUrl: string;
	officialCodex: boolean;
	env?: Record<string, string>;
}

interface OAuthAccess {
	accessToken: string;
	accountId?: string;
}

interface OmpAuthContext {
	modelRegistry: {
		authStorage: {
			oauth: {
				access(
					provider: string,
					sessionId?: string,
					options?: { signal?: AbortSignal },
				): Promise<OAuthAccess | undefined>;
			};
		};
	};
	sessionManager: {
		getSessionId(): string;
	};
}

export async function resolveCodexVoiceAuth(
	ctx: ExtensionContext,
	signal?: AbortSignal,
): Promise<CodexVoiceAuth> {
	const omp = ctx as unknown as OmpAuthContext;
	const sessionId = omp.sessionManager.getSessionId();
	const access = await omp.modelRegistry.authStorage.oauth.access(
		CODEX_PROVIDER,
		sessionId,
		signal ? { signal } : undefined,
	);
	if (!access)
		throw new Error(
			"No OMP Codex OAuth credential is available. Run /login openai-codex.",
		);
	const token = access.accessToken;
	const headers = new Headers();
	headers.set("authorization", `Bearer ${token}`);
	const accountId = access.accountId ?? readAccountId(token);
	if (accountId) headers.set("chatgpt-account-id", accountId);
	headers.set("originator", "pi");
	headers.set("x-session-id", sessionId);
	headers.set("user-agent", "pi-gpt-voice");
	return {
		headers,
		baseUrl: CODEX_BASE_URL,
		officialCodex: true,
	};
}

function readAccountId(token: string): string | undefined {
	try {
		const parts = token.split(".");
		if (parts.length !== 3) return undefined;
		const payload = JSON.parse(
			Buffer.from(parts[1] ?? "", "base64").toString("utf8"),
		) as Record<string, unknown>;
		const auth = payload["https://api.openai.com/auth"];
		if (!auth || typeof auth !== "object") return undefined;
		const accountId = (auth as Record<string, unknown>)["chatgpt_account_id"];
		return typeof accountId === "string" && accountId ? accountId : undefined;
	} catch {
		return undefined;
	}
}
