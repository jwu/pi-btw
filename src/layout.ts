/**
 * Fullscreen split layout for Pi 1.6.x.
 *
 * Pi's alt-screen renderer (TuiAltScreen) draws one layout root. The btw pane is added by
 * replacing that root with an HStack of [main root | separator | pane] and restoring it on close.
 * This touches two TS-private/protected fields at runtime, both checked before use:
 * - `TuiAltScreen.layoutRoot`: the current root, needed to put it back.
 * - `Stack.entries`: the entry copies whose `basis` is recomputed each frame.
 */
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
	type Component,
	HStack,
	isViewportTUI,
	type OverlayHandle,
	type TUI,
	type TuiMouseEvent,
	type TuiMouseEventResult,
	type ViewportTUI,
} from "@earendil-works/pi-tui";

const DEFAULT_PANE_RATIO = 0.45;
const MIN_PANE_WIDTH = 30;
const MIN_MAIN_WIDTH = 40;
const PROBE_WIDGET = "pi-btw:probe";

/** Share of the width given to the btw pane. Kept for the life of the process, so a reopened pane keeps its size. */
let paneRatio = DEFAULT_PANE_RATIO;

export type AltScreenTui = ViewportTUI & {
	layoutRoot?: Component;
	getFocusedComponent(): Component | null;
	hasOverlayEntries: boolean;
};

export type AcquireResult = { ok: true; tui: AltScreenTui; mainRoot: Component } | { ok: false; reason: string };

/** Get the live TUI through a widget factory (the widget is removed right away) and check it fits. */
export function acquireAltScreen(ctx: ExtensionContext): AcquireResult {
	let tui: TUI | undefined;
	ctx.ui.setWidget(
		PROBE_WIDGET,
		(t) => {
			tui = t;
			return { render: () => [], invalidate() {} };
		},
		{ placement: "belowEditor" },
	);
	ctx.ui.setWidget(PROBE_WIDGET, undefined, { placement: "belowEditor" });

	if (!tui || !isViewportTUI(tui)) return { ok: false, reason: "btw needs fullscreen mode (settings: tuiMode = fullscreen)" };
	const alt = tui as AltScreenTui;
	if (!alt.layoutRoot || typeof alt.getFocusedComponent !== "function") {
		return { ok: false, reason: "btw does not support this Pi version: alt-screen layout root not found" };
	}
	return { ok: true, tui: alt, mainRoot: alt.layoutRoot };
}

/** Pane width for a terminal width, honouring both minimum widths where the terminal allows. */
function paneWidthFor(totalWidth: number, ratio = paneRatio): number {
	const available = Math.max(0, totalWidth - 1);
	const wanted = Math.round(available * ratio);
	const max = Math.max(0, available - MIN_MAIN_WIDTH);
	const min = Math.min(MIN_PANE_WIDTH, available);
	return Math.max(min, Math.min(Math.max(max, min), wanted));
}

/** Pane share that puts the separator at `column`. */
function ratioForColumn(column: number, totalWidth: number): number {
	const available = Math.max(1, totalWidth - 1);
	return Math.min(0.85, Math.max(0.15, (available - column) / available));
}

/** Column of the separator for a terminal width and pane share. */
function separatorColumn(totalWidth: number, ratio = paneRatio): number {
	return Math.max(0, totalWidth - 1 - paneWidthFor(totalWidth, ratio));
}

/** TuiAltScreen internals the drag guide uses (Pi 1.6.x, checked before use). */
type RendererInternals = { doRender(): void; previousScreen?: string[] };

/**
 * A highlighted line drawn straight onto the terminal where the separator will land.
 *
 * Pi's overlays cannot be used for this: compositing a 1-column overlay onto a row splits a wide
 * (CJK) character and shifts the rest of that row by one column. Writing the guide with absolute
 * cursor moves after each frame never shifts anything; at worst it covers half a wide character.
 * Pi does not know about those cells, so every row it covered is marked stale and redrawn on the
 * next frame, which also erases the guide from its previous column.
 */
class DragGuide {
	private col?: number;
	private patched = false;
	constructor(
		private readonly tui: TUI,
		private readonly style: (s: string, active: boolean) => string,
	) {}
	private get renderer(): RendererInternals {
		return this.tui as unknown as RendererInternals;
	}
	moveTo(col: number): void {
		if (col === this.col) return;
		this.col = col;
		if (!this.patched && typeof this.renderer.doRender === "function") {
			const renderer = this.renderer;
			const render = renderer.doRender;
			renderer.doRender = () => {
				render.call(renderer);
				this.paint();
			};
			this.patched = true;
		}
		this.redrawRows();
	}
	hide(): void {
		if (this.patched) delete (this.renderer as Partial<RendererInternals>).doRender;
		this.patched = false;
		if (this.col === undefined) return;
		this.col = undefined;
		this.redrawRows();
	}
	/** Make Pi rewrite every row on the next frame, without a full clear. */
	private redrawRows(): void {
		const previous = this.renderer.previousScreen;
		if (Array.isArray(previous)) previous.fill("");
		this.tui.requestRender();
	}
	private paint(): void {
		if (this.col === undefined) return;
		const line = `${this.style("│", true)}\x1b[0m`;
		let out = "\x1b7";
		for (let row = 0; row < this.tui.terminal.rows; row++) out += `\x1b[${row + 1};${this.col + 1}H${line}`;
		this.tui.terminal.write(`${out}\x1b8`);
	}
}

/**
 * Vertical rule between the panes. Drag it with the mouse to resize; double-click resets.
 *
 * A width change re-wraps the whole main transcript, which takes about 100 ms on a long session.
 * Resizing on every drag event made dragging stutter, so a drag only moves a guide line (an
 * overlay, which leaves component widths and caches alone) and the widths change once, on release.
 */
class Separator implements Component {
	dragging = false;
	hovered = false;
	private dragRatio = paneRatio;
	private moved = false;
	private readonly guide: DragGuide;
	constructor(
		private readonly tui: TUI,
		private readonly style: (s: string, active: boolean) => string,
	) {
		this.guide = new DragGuide(tui, style);
	}
	/** Track whether the pointer is on the rule; called by the split root for every mouse event. */
	track(onRule: boolean): void {
		const hovered = onRule || this.dragging;
		if (hovered !== this.hovered) {
			this.hovered = hovered;
			this.tui.requestRender();
		}
	}
	/** Drop an unfinished drag, e.g. when the pane closes mid-drag. */
	cancelDrag(): void {
		this.dragging = false;
		this.guide.hide();
	}
	render(): string[] {
		const line = this.style("│", this.dragging || this.hovered);
		return Array.from({ length: this.tui.terminal.rows }, () => line);
	}
	handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined {
		if (event.button !== "left" && event.type !== "release" && event.type !== "click") return undefined;
		switch (event.type) {
			case "press":
				this.dragging = true;
				this.dragRatio = paneRatio;
				this.moved = false;
				this.track(true);
				return { capture: true, render: true };
			case "drag": {
				const total = this.tui.terminal.columns;
				this.dragRatio = ratioForColumn(event.screenX, total);
				this.moved = true;
				this.guide.moveTo(separatorColumn(total, this.dragRatio));
				return { handled: true, render: false };
			}
			case "release":
				this.dragging = false;
				this.guide.hide();
				if (this.moved) paneRatio = this.dragRatio;
				// The rule now sits where the pointer was released, so the pointer is usually still on it.
				this.track(event.screenX === separatorColumn(this.tui.terminal.columns));
				return { handled: true, render: true };
			case "click":
				if ((event.clickCount ?? 1) >= 2) paneRatio = DEFAULT_PANE_RATIO;
				return { handled: true, render: true };
		}
		return undefined;
	}
	invalidate(): void {}
}

/**
 * Main | separator | pane, with widths recomputed every frame.
 *
 * Pi 1.6's grow distribution is uneven (each entry takes its share of what the previous entry
 * left), so both panes get an explicit basis instead. `visible` runs once per frame with the
 * viewport before sizes are allocated, which makes it the hook for recomputing them.
 */
function createSplit(main: Component, separator: Separator, pane: Component, onPress: (column: number) => void): HStack {
	const sizeFromViewport = (viewport: { width: number }) => {
		const paneWidth = paneWidthFor(viewport.width);
		entries[0].basis = Math.max(0, viewport.width - 1 - paneWidth);
		entries[2].basis = paneWidth;
		return true;
	};
	const split = new HStack([
		{ component: main, basis: 0, grow: 0, shrink: 1, visible: sizeFromViewport },
		{ component: separator, basis: 1, grow: 0, shrink: 0 },
		{ component: pane, basis: 0, grow: 0, shrink: 1 },
	]);
	const entries = (split as unknown as { entries: { basis?: number | "auto" }[] }).entries;
	if (!Array.isArray(entries) || entries.length !== 3) throw new Error("pi-btw: unexpected HStack internals");
	// The layout offers mouse events to the deepest component first and to this root last. Seeing a
	// press here and returning undefined leaves selection and clicks to everything else.
	split.handleMouse = (event) => {
		const ruleColumn = event.screenX === separatorColumn(event.width);
		separator.track(ruleColumn);
		if (event.type === "press" && event.button === "left") onPress(event.screenX);
		return undefined;
	};
	return split;
}

export interface MountedSplit {
	/** False once the split root was replaced by someone else, e.g. a TUI rebuild. */
	isMounted(): boolean;
	/** Grow (positive) or shrink the pane by a share of the width. */
	resizeBy(delta: number): void;
	unmount(): void;
}

/**
 * Show `pane` beside the main UI.
 *
 * While mounted, a hidden empty overlay makes Pi refuse a fullscreen/regular switch from /settings
 * ("Close active overlays before changing TUI mode") instead of silently dropping the split.
 */
export function mountSplit(
	tui: AltScreenTui,
	mainRoot: Component,
	pane: Component,
	separatorStyle: (s: string, active: boolean) => string,
	/** Called with "main" or "btw" when the left mouse button is pressed on that side. */
	onPressSide: (side: "main" | "btw") => void,
): MountedSplit {
	const paneStart = () => tui.terminal.columns - paneWidthFor(tui.terminal.columns);
	const separator = new Separator(tui, separatorStyle);
	const splitRoot = createSplit(mainRoot, separator, pane, (column) => {
		const start = paneStart();
		if (column >= start) onPressSide("btw");
		else if (column < start - 1) onPressSide("main");
	});
	const guard: OverlayHandle = tui.showOverlay({ render: () => [], invalidate() {} }, { nonCapturing: true });
	guard.setHidden(true);
	tui.setLayoutRoot(splitRoot);
	let mounted = true;
	return {
		isMounted: () => mounted && tui.layoutRoot === splitRoot,
		resizeBy(delta) {
			paneRatio = Math.min(0.85, Math.max(0.15, paneRatio + delta));
			tui.requestRender();
		},
		unmount() {
			if (!mounted) return;
			mounted = false;
			guard.hide();
			separator.cancelDrag();
			if (tui.layoutRoot === splitRoot) tui.setLayoutRoot(mainRoot);
			tui.requestRender();
		},
	};
}
