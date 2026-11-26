import assert from "node:assert/strict";
import { test } from "node:test";
import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import { takeSnapshot } from "../src/snapshot.ts";

let n = 0;
const entry = (message: object): SessionEntry =>
	({ type: "message", id: `e${++n}`, parentId: null, timestamp: "", message }) as unknown as SessionEntry;
const user = (text: string) => entry({ role: "user", content: text });
const assistant = (...calls: string[]) =>
	entry({
		role: "assistant",
		content: [{ type: "text", text: "ok" }, ...calls.map((id) => ({ type: "toolCall", id, name: "read", arguments: {} }))],
	});
const result = (id: string) => entry({ role: "toolResult", toolCallId: id, content: [] });
const modelChange = { type: "model_change", id: "m", parentId: null, timestamp: "" } as unknown as SessionEntry;

test("keeps a finished branch whole", () => {
	const branch = [modelChange, user("q"), assistant("a"), result("a"), assistant()];
	const snap = takeSnapshot(branch);
	assert.equal(snap.entries.length, 5);
	assert.equal(snap.messages, 4);
	assert.equal(snap.trimmed, 0);
});

test("cuts before an assistant message with an unanswered tool call", () => {
	const branch = [user("q"), assistant("a"), result("a"), assistant("b", "c"), result("b")];
	const snap = takeSnapshot(branch);
	assert.deepEqual(
		snap.entries.map((e) => e.id),
		branch.slice(0, 3).map((e) => e.id),
	);
	assert.equal(snap.trimmed, 2);
});

test("copies entries so later main-line edits do not leak in", () => {
	const branch = [user("q")];
	const snap = takeSnapshot(branch);
	(branch[0] as unknown as { message: { content: string } }).message.content = "changed";
	assert.equal((snap.entries[0] as unknown as { message: { content: string } }).message.content, "q");
});
