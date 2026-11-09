/**
 * Linear extension for pi, built on the `linear` MCP server (pi-mcp-adapter).
 *
 * - `#ISSUE-ID` in a prompt (e.g. `fix #ABC-85`) fetches the issue and attaches it
 *   to that message as context, rendered as a card in the TUI.
 * - Typing `#` in the editor autocompletes Linear issues, with status/title as description.
 *
 * All Linear access goes through the MCP adapter's runtime tool-call event, so auth,
 * lazy connection and output guards are the adapter's, not this extension's.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
	type AutocompleteItem,
	type AutocompleteProvider,
	type AutocompleteSuggestions,
	Box,
	Text,
} from "@earendil-works/pi-tui";

const SERVER = "linear";
const TOOL_CALL_EVENT = "pi-mcp-adapter:runtime-tool-call:v1";
const TOOL_CALL_VERSION = 1;
const CUSTOM_TYPE = "linear-issue";
/** config.json next to this file (repo checkout), then the installed symlink location. First readable file wins. */
const CONFIG_PATHS = [
    fileURLToPath(new URL("./config.json", import.meta.url)),
    join(homedir(), ".pi", "agent", "extensions", "linear", "config.json"),
];
const ACTIVE_STATUS_TYPES = ["unstarted", "started"];

const MAX_ISSUES_PER_PROMPT = 5;
const MAX_DESCRIPTION_CHARS = 4000;
const MAX_SUGGESTIONS = 20;
const MAX_LINEAR_FETCH = 50; // fetched before filtering to Todo/In Progress client-side
const SUGGESTION_TTL_MS = 30_000;

// Team key + number, e.g. ABC-85. Team keys are uppercase in Linear.
const ISSUE_REF = /(?<!\w)#([A-Z][A-Z0-9]{1,9}-\d+)\b/g;
const ISSUE_TOKEN = /(?:^|[ \t])#([^\s#]*)$/;

export interface IssueSummary {
	identifier: string;
	title: string;
	url?: string;
	status?: string;
	statusType?: string;
	priority?: string;
	assignee?: string;
	project?: string;
	team?: string;
	description?: string;
}

function str(value: unknown): string | undefined {
	if (typeof value === "string") return value;
	if (value && typeof value === "object" && "name" in value && typeof value.name === "string") return value.name;
	return undefined;
}

function toSummary(raw: Record<string, unknown>): IssueSummary {
	return {
		identifier: String(raw.id ?? raw.identifier ?? ""),
		title: String(raw.title ?? ""),
		url: str(raw.url),
		status: str(raw.status),
		statusType: str(raw.statusType),
		priority: str(raw.priority),
		assignee: str(raw.assignee),
		project: str(raw.project),
		team: str(raw.team),
		description: typeof raw.description === "string" ? raw.description : undefined,
	};
}

/** Calls a Linear MCP tool through the adapter. Throws on transport or tool errors. */
async function callLinear(pi: ExtensionAPI, tool: string, args: Record<string, unknown>): Promise<unknown> {
	const request: {
		version: number;
		tool: string;
		args: Record<string, unknown>;
		server: string;
		result?: Promise<
			{ ok: true; result: { content?: Array<{ type: string; text?: string }>; details?: { error?: unknown } } } | { ok: false; error: Error }
		>;
	} = { version: TOOL_CALL_VERSION, tool: `${SERVER}_${tool}`, args, server: SERVER };

	pi.events.emit(TOOL_CALL_EVENT, request);
	if (!request.result) throw new Error("pi-mcp-adapter is not installed");

	const outcome = await request.result;
	if (!outcome.ok) throw outcome.error;

	const text = outcome.result.content?.find((block) => block.type === "text")?.text;
	if (text === undefined) return undefined;
	try {
		return JSON.parse(text);
	} catch {
		return text;
	}
}

async function fetchIssue(pi: ExtensionAPI, identifier: string): Promise<IssueSummary> {
	const raw = (await callLinear(pi, "get_issue", { id: identifier })) as Record<string, unknown>;
	return toSummary(raw);
}

async function listIssues(pi: ExtensionAPI): Promise<IssueSummary[]> {
	const raw = (await callLinear(pi, "list_issues", { limit: MAX_LINEAR_FETCH, assignee: "me" })) as
		| { issues?: Array<Record<string, unknown>> }
		| undefined;
	// statusType: "unstarted" = Todo, "started" = In Progress.
	return (raw?.issues ?? [])
		.map(toSummary)
		.filter((issue) => ACTIVE_STATUS_TYPES.includes(issue.statusType ?? ""));
}

function issueContext(issue: IssueSummary): string {
	const lines = [
		`Linear ${issue.identifier}: ${issue.title}`,
		[issue.status, issue.priority, issue.assignee, issue.project].filter(Boolean).join(" · "),
		issue.url,
	];
	const description = issue.description?.slice(0, MAX_DESCRIPTION_CHARS);
	if (description) lines.push("", description);
	return lines.filter((line) => line !== undefined && line !== "").join("\n");
}

function formatCard(issue: IssueSummary, expanded: boolean): string {
	const status = issue.status ? `[${issue.status}]` : "";
	const head = `${status ? status + " " : ""}${issue.identifier} ${issue.title}`;
	const meta = [issue.priority, issue.assignee, issue.project].filter(Boolean).join(" · ");
	return expanded && issue.description ? `${head}\n${meta}\n${issue.description.slice(0, 600)}` : meta ? `${head}\n${meta}` : head;
}


/** Shipped defaults: no keys, so nothing is fetched or completed until config.json lists some. */
export const DEFAULT_CONFIG: { projects: string[] } = { projects: [] };

/** Normalized keys from config.json, or the defaults when the file is missing or invalid. */
export function parseKeys(raw: unknown): string[] {
    const projects = (raw as { projects?: unknown } | null)?.projects;
    if (!Array.isArray(projects)) return [];
    return projects
        .filter((key): key is string => typeof key === "string")
        .map((key) => key.toUpperCase())
        .filter((key) => /^[A-Z][A-Z0-9_]*$/.test(key));
}

function readFirstConfig(): string {
    for (const path of CONFIG_PATHS) {
        try {
            return readFileSync(path, "utf8");
        } catch {
            // try the next location
        }
    }
    throw new Error("config.json not found");
}

function readKeys(): string[] {
    try {
        const keys = parseKeys(JSON.parse(readFirstConfig()));
        return keys.length > 0 ? keys : parseKeys(DEFAULT_CONFIG);
    } catch {
        return parseKeys(DEFAULT_CONFIG);
    }
}

/** `#KEY-n` claims when KEY is configured; bare letters claim while a configured key starts with them. */
function claimsToken(token: string, keys: string[]): boolean {
	if (!/^[A-Za-z]/.test(token)) return false;
	const upper = token.toUpperCase();
	if (upper.includes("-")) return keys.includes(upper.split("-")[0] ?? "");
	return keys.some((key) => key.startsWith(upper));
}

function createLinearAutocompleteProvider(current: AutocompleteProvider, pi: ExtensionAPI, keys: string[]): AutocompleteProvider {
	let cache: { at: number; issues: IssueSummary[] } | undefined;

	return {
		triggerCharacters: ["#"],
		async getSuggestions(lines, cursorLine, cursorCol, options): Promise<AutocompleteSuggestions | null> {
			const beforeCursor = (lines[cursorLine] ?? "").slice(0, cursorCol);
			const match = beforeCursor.match(ISSUE_TOKEN);
			const token = match?.[1] ?? "";
			if (!match || keys.length === 0 || !claimsToken(token, keys)) {
				return current.getSuggestions(lines, cursorLine, cursorCol, options);
			}

			if (!cache || Date.now() - cache.at >= SUGGESTION_TTL_MS) {
				try {
					cache = { at: Date.now(), issues: await listIssues(pi) };
				} catch {
					return current.getSuggestions(lines, cursorLine, cursorCol, options);
				}
				if (options.signal.aborted) return null;
			}

			const wanted = token.toUpperCase();
			const items: AutocompleteItem[] = cache.issues
				.filter((issue) => {
					const id = issue.identifier.toUpperCase();
					return keys.includes(id.split("-")[0] ?? "") && id.startsWith(wanted);
				})
				.slice(0, MAX_SUGGESTIONS)
				.map((issue) => ({
					value: `#${issue.identifier}`,
					label: `#${issue.identifier}`,
					description: `Linear${issue.status ? ` [${issue.status}]` : ""} ${issue.title}`,
				}));
			if (items.length === 0) return current.getSuggestions(lines, cursorLine, cursorCol, options);
			return { items, prefix: `#${token}` };
		},

		applyCompletion(lines, cursorLine, cursorCol, item, prefix) {
			return current.applyCompletion(lines, cursorLine, cursorCol, item, prefix);
		},

		shouldTriggerFileCompletion(lines, cursorLine, cursorCol) {
			return current.shouldTriggerFileCompletion?.(lines, cursorLine, cursorCol) ?? false;
		},
	};
}


export default function (pi: ExtensionAPI): void {
	pi.registerMessageRenderer(CUSTOM_TYPE, (message, { expanded, outputPad }, theme) => {
		const details = message.details as { issues?: IssueSummary[] } | undefined;
		const issues = details?.issues ?? [];
		const box = new Box(outputPad, 1, (t) => theme.bg("customMessageBg", t));
		for (const issue of issues) {
			const color = issue.statusType === "completed" ? "success" : issue.statusType === "canceled" ? "dim" : "accent";
			const [head, ...rest] = formatCard(issue, expanded).split("\n");
			box.addChild(new Text(theme.fg(color, head ?? ""), 0, 0));
			for (const line of rest) box.addChild(new Text(theme.fg("dim", line), 0, 0));
			if (expanded && issue.url) box.addChild(new Text(theme.fg("dim", issue.url), 0, 0));
		}
		return box;
	});

	pi.on("before_agent_start", async (event, ctx) => {
		if (event.messageType !== "user" || !event.prompt) return undefined;

		const ids = [...new Set([...event.prompt.matchAll(ISSUE_REF)].map((m) => m[1]!).filter((id) => readKeys().includes(id.split("-")[0] ?? "")))].slice(0, MAX_ISSUES_PER_PROMPT);
		if (ids.length === 0) return undefined;

		const results = await Promise.all(
			ids.map(async (id) => {
				try {
					return await fetchIssue(pi, id);
				} catch (error) {
					ctx.ui.notify(`linear: ${id}: ${error instanceof Error ? error.message : String(error)}`, "warning");
					return undefined;
				}
			}),
		);
		const issues = results.filter((issue): issue is IssueSummary => issue !== undefined && issue.identifier !== "");
		if (issues.length === 0) return undefined;

		return {
			message: {
				customType: CUSTOM_TYPE,
				content: issues.map(issueContext).join("\n\n---\n\n"),
				display: true,
				details: { issues: issues.map(({ description, ...rest }) => ({ ...rest, description: description?.slice(0, 600) })) },
			},
		};
	});

	pi.on("session_start", (_event, ctx) => {
		const keys = readKeys();
		ctx.ui.addAutocompleteProvider((current) => createLinearAutocompleteProvider(current, pi, keys));
	});
}
