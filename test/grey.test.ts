import assert from "node:assert/strict";
import { test } from "node:test";
import { colorToOklch, rgbColor } from "@earendil-works/pi-tui";
import { createGreyer } from "../src/grey.ts";

const grey = createGreyer({ text: rgbColor(220, 220, 220), muted: rgbColor(128, 128, 128), mode: "truecolor" });

/** Foreground colors set in a line, as [r, g, b] triples. */
function fgColors(line: string): number[][] {
	return [...line.matchAll(/\x1b\[38;2;(\d+);(\d+);(\d+)m/g)].map((m) => [1, 2, 3].map((i) => Number(m[i])));
}
const isGrey = ([r, g, b]: number[]) => Math.max(r, g, b) - Math.min(r, g, b) <= 2;
const lightness = ([r, g, b]: number[]) => colorToOklch(rgbColor(r, g, b)).l;

test("every color becomes a grey", () => {
	const out = grey("\x1b[38;2;215;135;175mpink\x1b[39m \x1b[31mred\x1b[0m \x1b[38;5;45mcyan");
	const colors = fgColors(out);
	assert.ok(colors.length >= 4);
	assert.ok(colors.every(isGrey), JSON.stringify(colors));
	assert.equal(out.replace(/\x1b\[[0-9;]*m/g, ""), "pink red cyan");
});

test("lighter colors stay lighter, darker stay darker", () => {
	const [bright] = fgColors(grey("\x1b[38;2;250;250;250mx")).slice(1);
	const [dark] = fgColors(grey("\x1b[38;2;60;60;60mx")).slice(1);
	assert.ok(lightness(bright) > lightness(dark));
	// Pulled toward the muted color: the brightest grey is no longer white.
	assert.ok(lightness(bright) < colorToOklch(rgbColor(250, 250, 250)).l);
});

test("uncolored text and resets use the grey of the default text color", () => {
	const out = grey("plain\x1b[0mafter");
	const colors = fgColors(out);
	assert.equal(colors.length, 2);
	assert.deepEqual(colors[0], colors[1]);
});

test("bold is dropped, other attributes and backgrounds are kept as greys", () => {
	const out = grey("\x1b[1;3;48;2;40;60;120mx");
	assert.ok(!/\x1b\[1[;m]/.test(out));
	assert.match(out, /\x1b\[3m/);
	const bg = [...out.matchAll(/\x1b\[48;2;(\d+);(\d+);(\d+)m/g)].map((m) => [1, 2, 3].map((i) => Number(m[i])));
	assert.equal(bg.length, 1);
	assert.ok(isGrey(bg[0]));
});

test("leading OSC marks stay at the start of the line", () => {
	const out = grey("\x1b]133;A\x07\x1b[48;2;33;59;73m   \x1b[49m");
	assert.ok(out.startsWith("\x1b]133;A\x07\x1b[38;2;"), JSON.stringify(out));
	const both = grey("\x1b]133;B\x07\x1b]133;C\x07 text");
	assert.ok(both.startsWith("\x1b]133;B\x07\x1b]133;C\x07\x1b[38;2;"), JSON.stringify(both));
});
