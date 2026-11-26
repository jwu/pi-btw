/**
 * Greyscale rendering for the inactive btw pane.
 *
 * Every text color in a line becomes the theme's muted color, keeping a little of its original
 * lightness so bright and faint text still differ slightly. Background colors keep their
 * lightness and only lose their hue.
 */
import {
	backgroundAnsi,
	type Color,
	colorToOklch,
	foregroundAnsi,
	indexedColor,
	oklchColor,
	rgbColor,
	type TerminalColorMode,
} from "@earendil-works/pi-tui";

/** How far each text lightness moves to the muted color's (0 keeps it, 1 makes all text exactly muted). */
const PULL_TO_MUTED = 0.8;

export interface GreyPalette {
	/** Concrete default foreground (the theme's `text`), used where a line has no color. */
	text: Color;
	/** Concrete muted color: the hue of all text, and the lightness it is pulled toward. */
	muted: Color;
	mode: TerminalColorMode;
}

const SGR = /\x1b\[([0-9;:]*)m/g;
/**
 * OSC sequences at the start of a line, such as OSC 133 prompt marks on message lines. They must
 * stay first: the layout strips them only at the line start, and a terminal given OSC 133;A
 * mid-line starts a fresh line, which breaks that row.
 */
const LEADING_OSC = /^(?:\x1b\][^\x07\x1b]*(?:\x07|\x1b\\))*/;

/** Make a function that turns a rendered line into its greyscale version. */
export function createGreyer(palette: GreyPalette): (line: string) => string {
	const anchor = colorToOklch(palette.muted);
	const fgCache = new Map<string, string>();
	const bgCache = new Map<string, string>();
	const greyFg = (key: string, color: () => Color) => {
		let ansi = fgCache.get(key);
		if (!ansi) {
			const l = colorToOklch(color()).l;
			ansi = foregroundAnsi(oklchColor(l + (anchor.l - l) * PULL_TO_MUTED, anchor.c, anchor.h), palette.mode);
			fgCache.set(key, ansi);
		}
		return ansi;
	};
	const greyBg = (key: string, color: () => Color) => {
		let ansi = bgCache.get(key);
		if (!ansi) {
			ansi = backgroundAnsi(oklchColor(colorToOklch(color()).l, 0, 0), palette.mode);
			bgCache.set(key, ansi);
		}
		return ansi;
	};
	const defaultFg = greyFg("default", () => palette.text);

	/** Rewrite one SGR parameter list; color parameters become grey escapes. */
	const rewrite = (raw: string): string => {
		const params = raw === "" ? ["0"] : raw.replace(/:/g, ";").split(";");
		const kept: string[] = [];
		let colors = "";
		for (let i = 0; i < params.length; i++) {
			const p = Number(params[i] || 0);
			if (p === 0) {
				// A full reset also resets the foreground to the terminal default; keep it grey.
				kept.push("0");
				colors += defaultFg;
			} else if (p === 39) colors += defaultFg;
			else if (p === 1) continue; // bold brightens text on many terminals
			else if ((p >= 30 && p <= 37) || (p >= 90 && p <= 97)) {
				const index = p >= 90 ? p - 90 + 8 : p - 30;
				colors += greyFg(`i${index}`, () => indexedColor(index));
			} else if ((p >= 40 && p <= 47) || (p >= 100 && p <= 107)) {
				const index = p >= 100 ? p - 100 + 8 : p - 40;
				colors += greyBg(`i${index}`, () => indexedColor(index));
			} else if (p === 38 || p === 48) {
				const kind = params[i + 1];
				let key: string | undefined;
				let color: (() => Color) | undefined;
				if (kind === "5") {
					const index = Number(params[i + 2]);
					key = `i${index}`;
					color = () => indexedColor(index);
					i += 2;
				} else if (kind === "2") {
					const [r, g, b] = params.slice(i + 2, i + 5).map(Number);
					key = `r${r},${g},${b}`;
					color = () => rgbColor(r, g, b);
					i += 4;
				}
				if (key && color) colors += p === 38 ? greyFg(key, color) : greyBg(key, color);
			} else kept.push(params[i]);
		}
		return (kept.length > 0 ? `\x1b[${kept.join(";")}m` : "") + colors;
	};

	return (line) => {
		const lead = LEADING_OSC.exec(line)?.[0] ?? "";
		return lead + defaultFg + line.slice(lead.length).replace(SGR, (_, params: string) => rewrite(params));
	};
}
