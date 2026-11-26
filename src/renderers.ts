/**
 * Tool renderers for the btw pane.
 *
 * Pi does not export its built-in renderers (read, grep, find, ls). The main chat resolves them
 * through `pi.registerToolRenderer`, so a pass-through resolver records what the main chat uses
 * whenever it draws such a tool. Until then, close look-alikes stand in.
 */
import type { ExtensionAPI, Theme, ToolRenderers } from "@earendil-works/pi-coding-agent";
import { keyHint } from "@earendil-works/pi-coding-agent";
import { type Component, Text } from "@earendil-works/pi-tui";

const BUILTIN = new Set(["read", "grep", "find", "ls"]);
const COLLAPSED_LINES = 20;
const seenFromMain = new Map<string, ToolRenderers>();

/** Record the renderers the main chat resolves for built-in tools. Call once from the extension factory. */
export function recordMainRenderers(pi: ExtensionAPI): void {
	pi.registerToolRenderer((toolName, next) => {
		const renderers = next();
		if (renderers && BUILTIN.has(toolName)) seenFromMain.set(toolName, renderers);
		return renderers;
	});
}

type Ctx = { lastComponent: Component | undefined; cwd?: string };
type Result = { content?: { type: string; text?: string }[] };

function text(ctx: Ctx, value: string): Text {
	const t = ctx.lastComponent instanceof Text ? ctx.lastComponent : new Text("", 0, 0);
	t.setText(value);
	return t;
}

function shortPath(path: unknown, cwd: string | undefined): string {
	const p = typeof path === "string" && path ? path : ".";
	if (cwd && p.startsWith(`${cwd}/`)) return p.slice(cwd.length + 1);
	const home = process.env.HOME;
	return home && p.startsWith(home) ? `~${p.slice(home.length)}` : p;
}

function output(result: Result, expanded: boolean, theme: Theme): string {
	const body = (result.content ?? [])
		.filter((c) => c.type === "text")
		.map((c) => c.text ?? "")
		.join("\n")
		.trimEnd();
	if (!body) return "";
	const lines = body.split("\n");
	const shown = expanded ? lines : lines.slice(0, COLLAPSED_LINES);
	let out = `\n${shown.map((l) => theme.fg("toolOutput", l)).join("\n")}`;
	const rest = lines.length - shown.length;
	if (rest > 0) out += `${theme.fg("muted", `\n... (${rest} more lines,`)} ${keyHint("app.tools.expand", "to expand")}${theme.fg("muted", ")")}`;
	return out;
}

function make(call: (args: Record<string, unknown>, theme: Theme, cwd?: string) => string, showResult = true): ToolRenderers {
	return {
		renderCall: (args, theme, ctx) => text(ctx as Ctx, call((args ?? {}) as Record<string, unknown>, theme, (ctx as Ctx).cwd)),
		renderResult: (result, options, theme, ctx) =>
			text(ctx as Ctx, showResult || options.expanded ? output(result as Result, options.expanded, theme) : ""),
	};
}

const title = (theme: Theme, name: string) => theme.fg("toolTitle", theme.bold(name));
const path = (theme: Theme, p: unknown, cwd?: string) => theme.fg("accent", shortPath(p, cwd));

const lookalikes: Record<string, ToolRenderers> = {
	read: make((a, t, cwd) => {
		const range = a.offset || a.limit ? `:${a.offset ?? 1}${a.limit ? `-${Number(a.offset ?? 1) + Number(a.limit) - 1}` : ""}` : "";
		return `${title(t, "read")} ${path(t, a.file_path ?? a.path, cwd)}${t.fg("warning", range)}`;
	}, false),
	grep: make((a, t, cwd) => `${title(t, "grep")} ${t.fg("accent", `/${a.pattern ?? ""}/`)} ${t.fg("toolOutput", `in ${shortPath(a.path, cwd)}`)}`),
	find: make((a, t, cwd) => `${title(t, "find")} ${t.fg("accent", String(a.pattern ?? ""))} ${t.fg("toolOutput", `in ${shortPath(a.path, cwd)}`)}`),
	ls: make((a, t, cwd) => `${title(t, "ls")} ${path(t, a.path, cwd)}`),
};

/** Renderers for a tool in the btw pane: the main chat's when known, else the tool's own or a look-alike. */
export function resolveRenderers(name: string, own: ToolRenderers | undefined): ToolRenderers | undefined {
	const main = seenFromMain.get(name);
	if (main) return main;
	const fallback = lookalikes[name];
	if (!own) return fallback;
	if (!fallback) return own;
	return { ...own, renderCall: own.renderCall ?? fallback.renderCall, renderResult: own.renderResult ?? fallback.renderResult };
}
