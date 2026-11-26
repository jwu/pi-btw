/**
 * pi-btw: a side question pane beside the main conversation (Pi 1.6.x fullscreen only).
 *
 * /btw opens a pane on the right with an in-memory agent seeded from a frozen snapshot of the
 * main branch. Nothing is persisted; closing the pane discards it. /btw:submit asks the side
 * agent for a summary and sends it to the main line as a follow-up.
 */
import type { ExtensionAPI, ExtensionContext, KeybindingsManager } from "@earendil-works/pi-coding-agent";
import { ModelSelectorComponent, SettingsManager } from "@earendil-works/pi-coding-agent";
import { type Component, getKeybindings, matchesKey, type ScrollView, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { type BtwAgent, createBtwAgent, SUMMARY_PROMPT } from "./agent.ts";
import { type AltScreenTui, acquireAltScreen, type MountedSplit, mountSplit } from "./layout.ts";
import { BtwPane, formatThinkingLevel, hasNerdFonts } from "./pane.ts";
import { recordMainRenderers, resolveRenderers } from "./renderers.ts";
import { type Snapshot, takeSnapshot } from "./snapshot.ts";

const FOCUS_KEY = "alt+o";
const SHRINK_KEY = "alt+-";
const GROW_KEY = "alt+=";
const RESIZE_STEP = 0.05;
const PAGE_OVERLAP = 2;

type Status = "starting" | "ready" | "busy" | "failed";

interface BtwSession {
	tui: AltScreenTui;
	split: MountedSplit;
	pane: BtwPane;
	mainFocus: Component | null;
	snapshot: Snapshot;
	agent: Promise<BtwAgent | undefined>;
	status: Status;
	/** Number of answered side questions, for /submit. */
	answered: number;
	disposed: boolean;
	cleanup: (() => void)[];
}

let current: BtwSession | undefined;

/** The open session, after dropping one whose split was replaced behind our back. */
function active(): BtwSession | undefined {
	if (current && !current.split.isMounted()) dispose(current);
	return current;
}

function dispose(s: BtwSession): void {
	if (s.disposed) return;
	s.disposed = true;
	if (current === s) current = undefined;
	for (const fn of s.cleanup.splice(0)) fn();
	s.pane.setWorking(false);
	s.split.unmount();
	if (s.tui.getFocusedComponent() === s.pane.editor) s.tui.setFocus(s.mainFocus);
	void s.agent.then((agent) => agent?.session.dispose());
}

function setFocus(s: BtwSession, target: "main" | "btw"): void {
	const component = target === "btw" ? s.pane.editor : s.mainFocus;
	if (s.tui.getFocusedComponent() !== component) s.tui.setFocus(component);
	s.tui.requestRender();
}

function setStatus(s: BtwSession, status: Status): void {
	s.status = status;
	s.pane.setWorking(status === "busy" || status === "starting");
}

/** Viewport keys (as bound for the main transcript) applied to the btw transcript. */
function scrollPane(scroll: ScrollView, data: string): boolean {
	const kb = getKeybindings();
	const page = Math.max(1, scroll.viewportHeight - PAGE_OVERLAP);
	const half = Math.max(1, Math.floor(scroll.viewportHeight / 2));
	const moves: [string, () => void][] = [
		["tui.altScreen.pageUp", () => scroll.scrollBy(-page)],
		["tui.altScreen.pageDown", () => scroll.scrollBy(page)],
		["tui.altScreen.halfPageUp", () => scroll.scrollBy(-half)],
		["tui.altScreen.halfPageDown", () => scroll.scrollBy(half)],
		["tui.altScreen.lineUp", () => scroll.scrollBy(-1)],
		["tui.altScreen.lineDown", () => scroll.scrollBy(1)],
		["tui.altScreen.top", () => scroll.scrollToStart()],
		["tui.altScreen.bottom", () => scroll.scrollToEnd()],
	];
	for (const [action, move] of moves) {
		if (kb.matches(data, action as never)) {
			move();
			return true;
		}
	}
	return false;
}

const MODEL_ICON = hasNerdFonts() ? "\uf4bc " : "";
/** pi-powerline's model color. */
const MODEL_COLOR = "#d787af";

function hexFg(hex: string, text: string): string {
	const n = Number.parseInt(hex.slice(1), 16);
	return `\x1b[38;2;${(n >> 16) & 255};${(n >> 8) & 255};${n & 255}m${text}`;
}

function formatTokens(count: number): string {
	if (count < 1000) return `${count}`;
	if (count < 10000) return `${(count / 1000).toFixed(1)}k`;
	if (count < 1000000) return `${Math.round(count / 1000)}k`;
	return `${(count / 1000000).toFixed(1)}M`;
}

/** Left side of the btw footer: snapshot size, btw's context use, and btw's own token use. */
function footerStats(
	snapshot: Snapshot,
	usage: { input: number; output: number; cost: number },
	context: { tokens: number | null; contextWindow: number } | undefined,
): string {
	const parts = [`snapshot ${snapshot.messages} msgs${snapshot.trimmed > 0 ? ` (-${snapshot.trimmed})` : ""}`];
	if (context && context.contextWindow > 0) {
		const pct = context.tokens === null ? "?" : `${((context.tokens / context.contextWindow) * 100).toFixed(1)}%`;
		parts.push(`${pct}/${formatTokens(context.contextWindow)}`);
	}
	if (usage.input) parts.push(`↑${formatTokens(usage.input)}`);
	if (usage.output) parts.push(`↓${formatTokens(usage.output)}`);
	if (usage.cost) parts.push(`$${usage.cost.toFixed(3)}`);
	return ` ${parts.join(" ")}`;
}

async function ask(s: BtwSession, question: string): Promise<boolean> {
	const agent = await s.agent;
	if (!agent || s.disposed) return false;
	if (agent.session.isStreaming) {
		s.pane.note("Still answering the previous question. Wait, or press Esc to stop it.", "warning");
		return false;
	}
	setStatus(s, "busy");
	try {
		await agent.session.prompt(question);
		const last = agent.session.messages.at(-1) as { role?: string; stopReason?: string } | undefined;
		return !s.disposed && last?.role === "assistant" && last.stopReason !== "error" && last.stopReason !== "aborted";
	} catch (err) {
		if (!s.disposed) s.pane.note(`Error: ${err instanceof Error ? err.message : String(err)}`, "error");
		return false;
	} finally {
		if (!s.disposed) setStatus(s, "ready");
	}
}

async function submit(pi: ExtensionAPI, s: BtwSession, notify: (msg: string, level: "info" | "warning") => void): Promise<void> {
	if (s.answered === 0) {
		notify("Nothing to submit yet: ask btw something first", "warning");
		return;
	}
	if (!(await ask(s, SUMMARY_PROMPT))) return;
	const agent = await s.agent;
	const summary = agent?.session.getLastAssistantText()?.trim();
	if (!summary) {
		s.pane.note("The summary came back empty; nothing was sent to the main thread", "warning");
		return;
	}
	const header = `[btw summary · based on a snapshot of the main thread taken when btw opened (${s.snapshot.messages} messages); later main-thread progress is not included]`;
	pi.sendUserMessage(`${header}\n\n${summary}`, { deliverAs: "followUp" });
	dispose(s);
	notify("btw summary sent to the main thread", "info");
}

function open(pi: ExtensionAPI, ctx: ExtensionContext, question: string): void {
	const existing = active();
	if (existing) {
		setFocus(existing, "btw");
		if (question) existing.pane.editor.setText(question);
		return;
	}
	const acquired = acquireAltScreen(ctx);
	if (!acquired.ok) {
		ctx.ui.notify(acquired.reason, "warning");
		return;
	}
	const { tui, mainRoot } = acquired;
	const theme = ctx.ui.theme;
	const snapshot = takeSnapshot(ctx.sessionManager.getBranch());
	// A private copy of the effective settings: btw reads them, and nothing it changes reaches disk.
	const settings = SettingsManager.inMemory(pi.getSettings());

	let s!: BtwSession;
	const usage = { input: 0, output: 0, cost: 0 };
	let agentRef: BtwAgent | undefined;
	const pane = new BtwPane({
		tui,
		theme,
		keybindings: getKeybindings() as KeybindingsManager,
		settings,
		cwd: ctx.cwd,
		toolRenderers: (name) => resolveRenderers(name, agentRef?.session.getToolDefinition(name)),
		header: (width) =>
			truncateToWidth(
				theme.fg(
					"dim",
					` Focus: ${FOCUS_KEY} | Resize: ${SHRINK_KEY}, ${GROW_KEY} | Stop: Esc | Commands: /model, /submit, /close`,
				),
				width,
				theme.fg("dim", "…"),
			),
		editorLabel: (focused) => {
			const model = agentRef?.session.model;
			const name = model ? model.name || model.id : s?.status === "failed" ? "failed to start" : "starting…";
			const tag = focused ? theme.fg("accent", theme.bold("BTW:")) : theme.fg("dim", "BTW:");
			return `${tag} ${hexFg(MODEL_COLOR, `${MODEL_ICON}${name}`)}\x1b[39m`;
		},
		footer: (width) => {
			const session = agentRef?.session;
			const left = theme.fg("dim", footerStats(snapshot, usage, session?.getContextUsage()));
			const right = session?.model?.reasoning ? `${formatThinkingLevel(theme, session.thinkingLevel)} ` : "";
			const rightWidth = visibleWidth(right);
			const leftRoom = Math.max(0, width - rightWidth - (rightWidth ? 1 : 0));
			const shown = truncateToWidth(left, leftRoom, theme.fg("dim", "…"));
			return shown + " ".repeat(Math.max(0, width - visibleWidth(shown) - rightWidth)) + right;
		},
	});
	s = {
		tui,
		split: mountSplit(
			tui,
			mainRoot,
			pane.root,
			(t, activeDrag) => theme.fg(activeDrag ? "accent" : "border", t),
			(side) => current === s && setFocus(s, side),
		),
		pane,
		mainFocus: tui.getFocusedComponent(),
		snapshot,
		agent: Promise.resolve(undefined),
		status: "starting",
		answered: 0,
		disposed: false,
		cleanup: [],
	};
	const notify = (msg: string, level: "info" | "warning") => ctx.ui.notify(msg, level);
	setStatus(s, "starting");

	s.agent = createBtwAgent(pi, ctx, snapshot, settings).then(
		(agent) => {
			if (s.disposed) {
				agent.session.dispose();
				return undefined;
			}
			agentRef = agent;
			s.cleanup.push(
				agent.session.subscribe((event) => {
					if (s.disposed) return;
					if (event.type === "message_end" && event.message.role === "assistant") {
						const m = event.message as { stopReason?: string; usage?: { input: number; output: number; cost?: { total: number } } };
						if (m.usage && m.stopReason !== "error" && m.stopReason !== "aborted") {
							usage.input += m.usage.input;
							usage.output += m.usage.output;
							usage.cost += m.usage.cost?.total ?? 0;
						}
					}
					pane.handleEvent(event);
				}),
			);
			pane.setThinkingLevel(agent.session.thinkingLevel);
			if (!agent.tools.includes("webfetch")) pane.note("pi-webfetch is not loaded in the main thread, so btw has no webfetch");
			setStatus(s, "ready");
			return agent;
		},
		(err) => {
			if (!s.disposed) {
				setStatus(s, "failed");
				pane.note(`btw failed to start: ${err instanceof Error ? err.message : String(err)}`, "error");
			}
			return undefined;
		},
	);

	// Editor actions, as in the main editor where they make sense for a side pane.
	const editor = pane.editor;
	editor.onEscape = () => {
		if (s.status === "busy") void agentRef?.session.abort();
		else setFocus(s, "main");
	};
	editor.onAction("app.clear", () => editor.setText(""));
	editor.onAction("app.tools.expand", () => pane.toggleToolsExpanded());
	editor.onAction("app.thinking.toggle", () => pane.toggleThinking());
	editor.onAction("app.thinking.cycle", () => {
		const level = agentRef?.session.cycleThinkingLevel();
		if (level) pane.setThinkingLevel(level);
	});

	s.cleanup.push(
		tui.addInputListener((data) => {
			if (current !== s) return undefined;
			const btwFocused = tui.getFocusedComponent() === editor;
			if (matchesKey(data, FOCUS_KEY)) {
				setFocus(s, btwFocused ? "main" : "btw");
				return { consume: true };
			}
			if (matchesKey(data, SHRINK_KEY) || matchesKey(data, GROW_KEY)) {
				s.split.resizeBy(matchesKey(data, GROW_KEY) ? RESIZE_STEP : -RESIZE_STEP);
				return { consume: true };
			}
			// The main viewport skips these keys while the btw editor has focus (capturesViewportInput).
			if (btwFocused && !editor.isShowingAutocomplete() && scrollPane(pane.scroll, data)) {
				tui.requestRender();
				return { consume: true };
			}
			return undefined;
		}),
	);

	/** Pi's own model picker, in place of the btw editor. Changes btw's model only, never the default. */
	const pickModel = async (search: string) => {
		const agent = await s.agent;
		if (!agent || s.disposed) return;
		if (agent.session.isStreaming) {
			pane.note("An answer is in progress. Wait, or press Esc to stop it, before switching models.", "warning");
			return;
		}
		const session = agent.session;
		let restore = () => {};
		const selector = new ModelSelectorComponent(
			tui,
			session.model,
			session.modelRuntime,
			session.scopedModels,
			async (model) => {
				close();
				try {
					await session.setModel(model);
					pane.setThinkingLevel(session.thinkingLevel);
					pane.note(`btw model: ${model.provider}/${model.id}`);
				} catch (err) {
					pane.note(`Failed to switch model: ${err instanceof Error ? err.message : String(err)}`, "error");
				}
			},
			() => close(),
			search || undefined,
		);
		const close = () => {
			selector.dispose();
			restore();
		};
		restore = pane.replaceEditor(selector);
	};

	const handleInput = async (text: string) => {
		if (text === "/close") return dispose(s);
		if (text === "/submit") return submit(pi, s, notify);
		if (text === "/model" || text.startsWith("/model ")) return pickModel(text.slice("/model".length).trim());
		editor.addToHistory(text);
		if (await ask(s, text)) s.answered++;
	};
	editor.onSubmit = (raw) => {
		const text = raw.trim();
		editor.setText("");
		if (text) void handleInput(text);
	};

	current = s;
	setFocus(s, "btw");
	if (question) void handleInput(question);
}

export default function (pi: ExtensionAPI) {
	recordMainRenderers(pi);
	pi.registerCommand("btw", {
		description: "Open the btw side pane next to the main thread (optionally with a question)",
		handler: async (args, ctx) => open(pi, ctx, args.trim()),
	});
	pi.registerCommand("btw:submit", {
		description: "Summarize btw, send it to the main thread as a follow-up, and close btw",
		handler: async (_args, ctx) => {
			const s = active();
			if (!s) return ctx.ui.notify("btw is not open", "warning");
			await submit(pi, s, (msg, level) => ctx.ui.notify(msg, level));
		},
	});
	pi.registerCommand("btw:close", {
		description: "Close the btw side pane and discard it",
		handler: async () => {
			const s = active();
			if (s) dispose(s);
		},
	});
	pi.on("session_shutdown", async () => {
		const s = active();
		if (s) dispose(s);
	});
}
