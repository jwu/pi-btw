/**
 * The btw backend: an in-memory Pi agent session seeded with a frozen copy of the main branch.
 *
 * Nothing is written to disk. The seed is taken once when btw opens; later main-line progress
 * is not followed (reopen btw for a fresh snapshot).
 */
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
	type AgentSession,
	createAgentSession,
	DefaultResourceLoader,
	getAgentDir,
	type ModelRuntime,
	SessionManager,
	type SettingsManager,
} from "@earendil-works/pi-coding-agent";
import type { Snapshot } from "./snapshot.ts";

const BUILTIN_TOOLS = ["read", "grep", "find", "ls"];
const EXTENSION_TOOLS = ["webfetch"];

const BTW_SYSTEM_PROMPT = `# btw side-question mode

You are the user's "by the way" assistant. The conversation above is a frozen snapshot of the main thread, taken when the user opened btw.
- The user asks side questions related to the main thread. Answer them directly; do not carry on with unfinished main-thread work.
- You only have read-only tools. Do not try to change files or run commands; when a change is needed, tell the user what to do in the main thread.
- The main thread may have moved on since the snapshot. You cannot see that progress.
- Reply in the language the user writes in.`;

export const SUMMARY_PROMPT = `Turn the conclusions of this side conversation into one message to send back to the main thread:
- Include only conclusions, findings, and recommendations useful to the main thread; do not retell the Q&A.
- Name specific paths or identifiers when files, functions, or commands are involved.
- List anything the main thread should do separately.
- Output only the message body, with no preamble such as "Here is the summary".
- Write it in the language of the conversation.`;

/** The main session's ModelRuntime, so providers registered by extensions resolve in btw too. */
function mainModelRuntime(ctx: ExtensionContext): ModelRuntime | undefined {
	// ModelRegistry is a facade over the runtime, kept in a TS-private field (Pi 1.6.x).
	const runtime = (ctx.modelRegistry as unknown as { runtime?: Partial<ModelRuntime> }).runtime;
	const looksValid = typeof runtime?.getModel === "function" && typeof runtime?.streamSimple === "function";
	return looksValid ? (runtime as ModelRuntime) : undefined;
}

/**
 * Extension files that provide the extension tools btw may use, as loaded in the main session.
 * btw loads no other extension: only the file behind `webfetch` (pi-webfetch), if main has it.
 */
function extensionToolPaths(pi: ExtensionAPI): { paths: string[]; tools: string[] } {
	const paths = new Set<string>();
	const tools: string[] = [];
	for (const info of pi.getAllTools()) {
		if (!EXTENSION_TOOLS.includes(info.name) || !info.sourceInfo?.path) continue;
		paths.add(info.sourceInfo.path);
		tools.push(info.name);
	}
	return { paths: [...paths], tools };
}

export interface BtwAgent {
	session: AgentSession;
	snapshot: Snapshot;
	tools: string[];
}

export async function createBtwAgent(
	pi: ExtensionAPI,
	ctx: ExtensionContext,
	snapshot: Snapshot,
	settingsManager: SettingsManager,
): Promise<BtwAgent> {
	const ext = extensionToolPaths(pi);
	const loader = new DefaultResourceLoader({
		cwd: ctx.cwd,
		agentDir: getAgentDir(),
		noExtensions: true,
		additionalExtensionPaths: ext.paths,
		noSkills: true,
		noPromptTemplates: true,
		noThemes: true,
		settingsManager,
		appendSystemPrompt: [BTW_SYSTEM_PROMPT],
	});
	await loader.reload();

	const tools = [...BUILTIN_TOOLS, ...ext.tools];
	const { session } = await createAgentSession({
		cwd: ctx.cwd,
		modelRuntime: mainModelRuntime(ctx),
		model: ctx.model,
		// Same /model scope as main (enabledModels or --models), so the picker offers the same list.
		scopedModels: ctx.scopedModels.map((s) => ({ model: s.model, thinkingLevel: s.thinkingLevel })),
		thinkingLevel: pi.getThinkingLevel(),
		resourceLoader: loader,
		tools,
		sessionManager: SessionManager.inMemory(ctx.cwd, undefined, snapshot.entries),
		settingsManager,
	});
	return { session, snapshot, tools };
}
