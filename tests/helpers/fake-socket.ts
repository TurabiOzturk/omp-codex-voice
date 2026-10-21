import type { WebSocketLike } from "../../src/openai/types.ts";

export class FakeSocket implements WebSocketLike {
	readonly sent: string[] = [];
	readonly listeners = new Map<string, Array<(event: unknown) => void>>();
	bufferedAmount = 0;
	send(data: string): void {
		this.sent.push(data);
	}
	close(): void {}
	addEventListener(type: string, listener: (event: unknown) => void): void {
		const listeners = this.listeners.get(type) ?? [];
		listeners.push(listener);
		this.listeners.set(type, listeners);
	}
	removeEventListener(type: string, listener: (event: unknown) => void): void {
		this.listeners.set(
			type,
			(this.listeners.get(type) ?? []).filter(
				(candidate) => candidate !== listener,
			),
		);
	}
	emit(type: string, event: unknown): void {
		for (const listener of this.listeners.get(type) ?? []) listener(event);
	}
}
