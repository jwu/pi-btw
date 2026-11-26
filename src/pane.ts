/**
 * The btw pane, built from the same components as Pi's main chat: user and assistant messages
 * (with thinking blocks), tool execution rows, and the app editor with its working indicator.
 * The layout mirrors the main viewport: a scrollable transcript above a fixed input dock.
 */
import type { AgentSessionEvent, SettingsManager, Theme, ToolRenderers } from "@earendil-works/pi-coding-agent";
import {
	AssistantMessageComponent,
	CustomEditor,
	getMarkdownTheme,
	getSelectListTheme,
	type KeybindingsManager,
	ToolExecutionComponent,
	UserMessageComponent,
} from "@earendil-works/pi-coding-agent";
import {
	type Component,
	CombinedAutocompleteProvider,
	Container,
	Loader,
	ScrollView,
	Spacer,
	Text,
	type TUI,
	stripTerminalSequences,
	truncateToWidth,
	visibleWidth,
	type TuiMouseEvent,
	type TuiMouseEventResult,
	VStack,
} from "@earendil-works/pi-tui";
import { createGreyer } from "./grey.ts";

type AssistantMessage = ConstructorParameters<typeof AssistantMessageComponent>[0] & {};
type ThinkingLevel = Parameters<Theme["getThinkingBorderColor"]>[0];

const PROMPT_WIDTH = 2;

/**
 * The btw input box: Pi's app editor in pi-powerline's shape, so it reads as btw at a glance.
 * The top border carries a " btw " label (the working spinner follows it), and the first input
 * row starts with a "?" prompt where powerline's main editor shows "❯".
 * While focused, it also keeps viewport keys (PageUp, …) for the btw transcript.
 */
class BtwEditor extends CustomEditor {
	/** Rows of the last render that hold input text, for mapping clicks past the prompt column. */
	private textRows = { first: 1, end: 1 };

	/** Text after the leading "─ " of the top border, e.g. "BTW: model". */
	borderLabel: () => string = () => "BTW";

	constructor(
		tui: TUI,
		private readonly appTheme: Theme,
		...rest: ConstructorParameters<typeof CustomEditor> extends [TUI, ...infer R] ? R : never
	) {
		super(tui, ...rest);
	}

	override get capturesViewportInput(): boolean {
		return true;
	}

	/** "─ BTW: model ───", as pi-powerline puts the model into the main editor's top border. */
	protected override renderTopBorder(width: number, hiddenLineCount: number): string {
		const room = width - 3 - 2;
		if (room < 4) return super.renderTopBorder(width, hiddenLineCount);
		const label = truncateToWidth(this.borderLabel(), room, "…");
		const lead = 2 + visibleWidth(label) + 1;
		return `${this.borderColor("─")} ${label} ${super.renderTopBorder(width - lead, hiddenLineCount)}`;
	}

	override render(width: number): string[] {
		const inner = Math.max(1, width - PROMPT_WIDTH);
		const lines = super.render(inner);
		if (lines.length < 3 || width <= PROMPT_WIDTH + 1) return lines.map((line) => truncateToWidth(line, width, ""));
		let bottom = lines.length - 1;
		for (let i = lines.length - 1; i >= 1; i--) {
			if (/^─{3,}/.test(stripTerminalSequences(lines[i] ?? ""))) {
				bottom = i;
				break;
			}
		}
		const edge = this.borderColor("─".repeat(PROMPT_WIDTH));
		const prompt = `${this.appTheme.fg("dim", "?")} `;
		const result = lines.map((line, i) => {
			if (i === 0 || i === bottom) return line + edge;
			if (i < bottom) return (i === 1 ? prompt : " ".repeat(PROMPT_WIDTH)) + line;
			return line;
		});
		this.textRows = { first: 1, end: bottom };
		return result.map((line) => truncateToWidth(line, width, ""));
	}

	override handleMouse(event: TuiMouseEvent) {
		const inText = event.y >= this.textRows.first && event.y < this.textRows.end;
		if (!inText) return super.handleMouse(event);
		return super.handleMouse({ ...event, x: Math.max(0, event.x - PROMPT_WIDTH), width: Math.max(1, event.width - PROMPT_WIDTH) });
	}
}

/** Kitty or iTerm2 inline-image lines; recoloring them would break the image. */
const isImageLine = (line: string) => line.includes("\x1b_G") || line.includes("\x1b]1337;File");

/**
 * Make `component` render in greys while `active()` is false (see grey.ts). The greyed lines are
 * cached per source array, so an unchanged component costs nothing extra per frame.
 */
function greyWhenInactive(component: Component, active: () => boolean, grey: (text: string) => string): void {
	const render = component.render.bind(component);
	let cache: { source: readonly string[]; lines: string[] } | undefined;
	component.render = (width: number) => {
		const lines = render(width);
		if (active()) return lines;
		if (cache?.source !== lines) {
			cache = { source: lines, lines: lines.map((line) => (isImageLine(line) ? line : grey(line))) };
		}
		return cache.lines;
	};
}

/** Two blank rows held by the status slot while idle, so the dock keeps its height (Pi's IdleStatus). */
class IdleStatus {
	render(width: number): string[] {
		const blank = " ".repeat(Math.max(0, width));
		return [blank, blank];
	}
	invalidate(): void {}
}

/** One line computed on every render. */
/** Nerd Font detection, as pi-powerline does it, so the thinking icon matches the main footer. */
export function hasNerdFonts(): boolean {
	if (process.env.PI_NERD_FONTS === "1") return true;
	if (process.env.PI_NERD_FONTS === "0") return false;
	if (process.env.GHOSTTY_RESOURCES_DIR || process.env.HERDR_ENV) return true;
	const terminal = `${process.env.TERM_PROGRAM ?? ""} ${process.env.TERM ?? ""}`.toLowerCase();
	return ["iterm", "wezterm", "kitty", "ghostty", "alacritty", "herdr"].some((t) => terminal.includes(t));
}

const THINK_ICON = hasNerdFonts() ? "\uf0e7 " : "";
const THINK_LABELS: Record<string, string> = { minimal: "min", low: "low", medium: "med", high: "high", xhigh: "xhi", max: "max" };
const THINK_COLORS: Record<string, string> = {
	minimal: "thinkingMinimal",
	low: "thinkingLow",
	medium: "thinkingMedium",
	high: "thinkingHigh",
	xhigh: "thinkingXhigh",
	max: "thinkingMax",
};

/** Thinking level as pi-powerline's footer shows it: icon and short label in the level's color. */
export function formatThinkingLevel(theme: Theme, level: string): string {
	const color = (THINK_COLORS[level] ?? "thinkingOff") as Parameters<Theme["fg"]>[0];
	return theme.fg(color, `${THINK_ICON}${THINK_LABELS[level] ?? level}`);
}

class LiveLine {
	constructor(private readonly text: (width: number) => string) {}
	render(width: number): string[] {
		return [truncateToWidth(this.text(width), width)];
	}
	invalidate(): void {}
}

export interface PaneOptions {
	tui: TUI;
	theme: Theme;
	keybindings: KeybindingsManager;
	settings: SettingsManager;
	cwd: string;
	/** Renderers for a tool, as the main chat would use them. */
	toolRenderers: (name: string) => ToolRenderers | undefined;
	/** Hotkey line above the transcript. */
	header: (width: number) => string;
	/** Label in the editor's top border; receives whether the btw editor has focus. */
	editorLabel: (focused: boolean) => string;
	/** Status line below the editor (left: context info, right: thinking level). */
	footer: (width: number) => string;
}

export class BtwPane {
	readonly root: VStack;
	readonly editor: BtwEditor;
	readonly scroll: ScrollView;
	private readonly chat = new Container();
	/** Holds the editor, or a picker shown in its place (as the main UI does for /model). */
	private readonly editorSlot = new Container();
	/** Working indicator row above the editor, where the main view shows it (not in the border). */
	private readonly statusSlot = new Container();
	private readonly idleStatus = new IdleStatus();
	private readonly theme: Theme;
	private readonly tui: TUI;
	private hideThinking: boolean;
	private toolsExpanded = false;
	private streaming?: { component: AssistantMessageComponent; message: AssistantMessage };
	private readonly tools = new Map<string, ToolExecutionComponent>();
	private readonly assistants: AssistantMessageComponent[] = [];
	private readonly toolRows: ToolExecutionComponent[] = [];
	private working?: Loader;

	constructor(private readonly opts: PaneOptions) {
		const { tui, theme, settings } = opts;
		this.tui = tui;
		this.theme = theme;
		this.hideThinking = settings.getHideThinkingBlock();
		this.scroll = new ScrollView(this.chat, {
			follow: "end",
			primary: false,
			overscroll: "contain",
			scrollbar: settings.getFullscreenScrollbar(),
			scrollbarTrackStyle: (t) => theme.fg("scrollbarTrack", t),
			scrollbarThumbStyle: (t) => theme.fg("scrollbarThumb", t),
		});
		this.editor = new BtwEditor(
			tui,
			theme,
			// Fixed accent border, as pi-powerline draws the main editor; the footer shows the thinking level.
			{ borderColor: (t) => theme.fg("borderAccent", t), selectList: getSelectListTheme() },
			opts.keybindings,
			{
				paddingX: settings.getEditorPaddingX(),
				autocompleteMaxVisible: settings.getAutocompleteMaxVisible(),
			},
		);
		this.editor.setAutocompleteProvider(
			new CombinedAutocompleteProvider(
				[
					{ name: "submit", description: "Summarize, send to the main thread as a follow-up, and close btw" },
					{ name: "close", description: "Close btw and discard it" },
					{ name: "model", description: "Switch the model btw uses (btw only)" },
				],
				opts.cwd,
			),
		);
		this.editorSlot.addChild(this.editor);
		this.statusSlot.addChild(this.idleStatus);
		this.editor.borderLabel = () => opts.editorLabel(this.editor.focused);
		const header = new LiveLine((width) => opts.header(width));
		const footer = new LiveLine((width) => opts.footer(width));
		const dock = new VStack([
			{ component: this.statusSlot, shrink: 1, minSize: 0 },
			{ component: this.editorSlot, shrink: 1, minSize: 3 },
			{ component: footer, shrink: 1, minSize: 0 },
		]);
		// Grey the whole pane while keyboard focus is elsewhere (the main view, a main dialog, …).
		const active = () => this.isActive();
		// Rebuilt when the theme's resolved colors change (theme switch, terminal colors reported late).
		let greyer: { colors: unknown; fn: (line: string) => string } | undefined;
		const grey = (line: string) => {
			const colors = theme.colors;
			if (greyer?.colors !== colors) {
				greyer = { colors, fn: createGreyer({ text: colors.text, muted: colors.muted, mode: theme.getColorMode() }) };
			}
			return greyer.fn(line);
		};
		for (const part of [header, this.chat, this.statusSlot, this.editorSlot, footer]) greyWhenInactive(part, active, grey);
		this.root = new VStack([
			{ component: header, basis: "auto", grow: 0, shrink: 0 },
			{ component: this.scroll, basis: 0, grow: 1, shrink: 1, minSize: 1 },
			{ component: dock, basis: "auto", grow: 0, shrink: 1, minSize: 1 },
		]);
		// Pi's wheel routing hands whatever a scroll view cannot use (at its top or end, or too short
		// to scroll) to the main transcript, even with overscroll "contain". Taking every wheel event
		// over the pane here keeps the main view still; the layout asks this root before falling back.
		// dispatchMouseEvent wraps a plain result with the target, so the narrower Container type is not needed.
		(this.root as { handleMouse: (event: TuiMouseEvent) => TuiMouseEventResult | undefined }).handleMouse = (event) => {
			if (event.type !== "wheel") return undefined;
			this.scroll.scrollBy(event.wheelDelta ?? 0);
			return { handled: true, render: true };
		};
	}

	private markdownTheme() {
		return { ...getMarkdownTheme(), codeBlockIndent: this.opts.settings.getCodeBlockIndent() };
	}

	private get outputPad(): number {
		return this.opts.settings.getOutputPad();
	}

	/** Whether keyboard focus is in this pane: the editor, or a picker shown in its place. */
	isActive(): boolean {
		const focused = (this.tui as { getFocusedComponent?(): Component | null }).getFocusedComponent?.();
		return focused != null && this.editorSlot.children.includes(focused);
	}

	/** Show `component` where the editor is, focused. Returns a function that puts the editor back. */
	replaceEditor(component: Component): () => void {
		this.editorSlot.clear();
		this.editorSlot.addChild(component);
		this.tui.setFocus(component);
		this.tui.requestRender();
		return () => {
			this.editorSlot.clear();
			this.editorSlot.addChild(this.editor);
			this.tui.setFocus(this.editor);
			this.tui.requestRender();
		};
	}

	/** The footer shows the level; this only redraws it. */
	setThinkingLevel(_level: ThinkingLevel): void {
		this.tui.requestRender();
	}

	setWorking(on: boolean): void {
		if (on && !this.working) {
			this.working = new Loader(
				this.tui,
				(t) => this.theme.fg("accent", t),
				(t) => this.theme.fg("muted", t),
				"Working",
			);
			this.statusSlot.clear();
			this.statusSlot.addChild(this.working);
		} else if (!on && this.working) {
			this.working.stop();
			this.working = undefined;
			this.statusSlot.clear();
			this.statusSlot.addChild(this.idleStatus);
		}
		this.tui.requestRender();
	}

	toggleToolsExpanded(): void {
		this.toolsExpanded = !this.toolsExpanded;
		for (const row of this.toolRows) row.setExpanded(this.toolsExpanded);
		this.tui.requestRender();
	}

	toggleThinking(): void {
		this.hideThinking = !this.hideThinking;
		for (const a of this.assistants) a.setHideThinkingBlock(this.hideThinking);
		this.tui.requestRender();
	}

	note(text: string, tone: "dim" | "warning" | "error" = "dim"): void {
		this.chat.addChild(new Spacer(1));
		this.chat.addChild(new Text(this.theme.fg(tone, text), this.outputPad, 0));
		this.tui.requestRender();
	}

	private addToolRow(name: string, id: string, args: unknown): ToolExecutionComponent {
		const settings = this.opts.settings;
		const row = new ToolExecutionComponent(
			name,
			id,
			args,
			{ showImages: settings.getShowImages(), imageWidthCells: settings.getImageWidthCells(), outputPad: this.outputPad },
			this.opts.toolRenderers(name),
			this.tui,
			this.opts.cwd,
		);
		row.setExpanded(this.toolsExpanded);
		this.chat.addChild(row);
		this.tools.set(id, row);
		this.toolRows.push(row);
		return row;
	}

	/** Mirror of the main chat's handling of agent events. */
	handleEvent(event: AgentSessionEvent): void {
		switch (event.type) {
			case "message_start": {
				const message = event.message as { role: string; content: unknown };
				if (message.role === "user") {
					const text = typeof message.content === "string" ? message.content : textOf(message.content);
					// As in the main chat: a blank line before every user message but the first.
					if (this.chat.children.length > 0) this.chat.addChild(new Spacer(1));
					this.chat.addChild(new UserMessageComponent(text, this.markdownTheme(), this.outputPad));
				} else if (message.role === "assistant") {
					const component = new AssistantMessageComponent(
						undefined,
						this.hideThinking,
						this.markdownTheme(),
						undefined,
						this.outputPad,
					);
					this.assistants.push(component);
					this.streaming = { component, message: message as AssistantMessage };
					this.chat.addChild(component);
					component.updateContent(this.streaming.message, true);
				}
				break;
			}
			case "message_update": {
				if (!this.streaming || event.message.role !== "assistant") break;
				const message = event.message as AssistantMessage;
				this.streaming.message = message;
				this.streaming.component.updateContent(message, true);
				for (const part of message.content) {
					if (part.type !== "toolCall") continue;
					const row = this.tools.get(part.id);
					if (row) row.updateArgs(part.arguments);
					else this.addToolRow(part.name, part.id, part.arguments);
				}
				break;
			}
			case "message_end": {
				if (!this.streaming || event.message.role !== "assistant") break;
				const message = event.message as AssistantMessage;
				if (message.stopReason === "aborted") message.errorMessage = "Operation aborted";
				this.streaming.component.updateContent(message, false);
				if (message.stopReason === "aborted" || message.stopReason === "error") {
					const text = message.errorMessage || "Error";
					for (const row of this.tools.values()) row.updateResult({ content: [{ type: "text", text }], isError: true });
					this.tools.clear();
				} else {
					for (const row of this.tools.values()) row.setArgsComplete();
				}
				this.streaming = undefined;
				break;
			}
			case "tool_execution_start": {
				if ((event as { parentToolCallId?: string }).parentToolCallId) break;
				const row = this.tools.get(event.toolCallId) ?? this.addToolRow(event.toolName, event.toolCallId, event.args);
				row.markExecutionStarted();
				break;
			}
			case "tool_execution_update":
				this.tools.get(event.toolCallId)?.updateResult({ ...event.partialResult, isError: false }, true);
				break;
			case "tool_execution_end": {
				const row = this.tools.get(event.toolCallId);
				if (row) {
					row.updateResult({ ...event.result, isError: event.isError, durationMs: event.durationMs });
					this.tools.delete(event.toolCallId);
				}
				break;
			}
			case "agent_end":
				if (this.streaming) {
					this.chat.removeChild(this.streaming.component);
					this.streaming = undefined;
				}
				this.tools.clear();
				break;
			default:
				return;
		}
		this.tui.requestRender();
	}
}

function textOf(content: unknown): string {
	if (!Array.isArray(content)) return "";
	return content
		.filter((part): part is { type: "text"; text: string } => part?.type === "text")
		.map((part) => part.text)
		.join("");
}
