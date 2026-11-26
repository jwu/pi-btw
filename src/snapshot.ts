/** Frozen copy of the main branch that seeds the btw agent. */
import type { SessionEntry } from "@earendil-works/pi-coding-agent";

export interface Snapshot {
	entries: SessionEntry[];
	/** Conversation messages in the snapshot (entries also hold model changes and the like). */
	messages: number;
	/** Entries dropped from the end because a tool call there had no result yet (main was busy). */
	trimmed: number;
}

/**
 * Copy the main branch, cutting it before the first assistant message whose tool calls are not
 * all answered. While main is running a tool, its branch ends with such a message, and a model
 * request with an unanswered tool call is rejected by most providers.
 */
export function takeSnapshot(branch: readonly SessionEntry[]): Snapshot {
	const entries = structuredClone(branch) as SessionEntry[];
	const answered = new Set<string>();
	for (const entry of entries) {
		if (entry.type === "message" && entry.message.role === "toolResult") answered.add(entry.message.toolCallId);
	}
	const cut = entries.findIndex(
		(entry) =>
			entry.type === "message" &&
			entry.message.role === "assistant" &&
			entry.message.content.some((part) => part.type === "toolCall" && !answered.has(part.id)),
	);
	const kept = cut === -1 ? entries : entries.slice(0, cut);
	return {
		entries: kept,
		messages: kept.filter((entry) => entry.type === "message").length,
		trimmed: entries.length - kept.length,
	};
}
