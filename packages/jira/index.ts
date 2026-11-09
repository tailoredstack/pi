/**
 * Jira extension for pi, built on the `jira` MCP server (Atlassian, pi-mcp-adapter).
 *
 * - `JIR#KEY-123` in a prompt (e.g. `fix JIR#CPA-2110`) fetches the issue and attaches it
 *   to that message as context, rendered as a card in the TUI.
 * - Typing `JIR#` in the editor autocompletes issues assigned to you.
 *
 * All Jira access goes through the MCP adapter's runtime tool-call event, so auth,
 * lazy connection and output guards are the adapter's, not this extension's.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
	type AutocompleteItem,
	type AutocompleteProvider,
	type AutocompleteSuggestions,
	Box,
	Text,
} from "@earendil-works/pi-tui";

const SERVER = "jira";
const TOOL_CALL_EVENT = "pi-mcp-adapter:runtime-tool-call:v1";
const TOOL_CALL_VERSION = 1;
const CUSTOM_TYPE = "jira-issue";
const CONFIG_PATH = fileURLToPath(new URL("./config.json", import.meta.url));

const MAX_ISSUES_PER_PROMPT = 5;
const MAX_DESCRIPTION_CHARS = 4000;
const MAX_SUGGESTIONS = 20;
const SUGGESTION_TTL_MS = 30_000;

// Project key + number, e.g. CPA-2110.
const ISSUE_REF = /(?<!\w)#([A-Z][A-Z0-9_]+-\d+)\b/g;
const ISSUE_TOKEN = /(?:^|[ \t])#([^\s#]*)$/;

export interface JiraIssueSummary {
	key: string;
	summary: string;
	status?: string;
	statusCategory?: string;
	priority?: string;
	assignee?: string;
	project?: string;
	url?: string;
	description?: string;
}

type ToolOutcome = { ok: true; result: { content?: Array<{ type: string; text?: string }>; structuredContent?: unknown } } | { ok: false; error: Error };

/** Calls a Jira MCP tool through the adapter. Throws on transport or tool errors. */
async function callJira(pi: ExtensionAPI, tool: string, args: Record<string, unknown>): Promise<unknown> {
	const request: { version: number; tool: string; args: Record<string, unknown>; server: string; result?: Promise<ToolOutcome> } = {
		version: TOOL_CALL_VERSION,
		tool: `${SERVER}_${tool}`,
		args,
		server: SERVER,
	};

	pi.events.emit(TOOL_CALL_EVENT, request);
	if (!request.result) throw new Error("pi-mcp-adapter is not installed");

	const outcome = await request.result;
	if (!outcome.ok) throw outcome.error;
	if (outcome.result.structuredContent !== undefined) return outcome.result.structuredContent;

	const text = outcome.result.content?.find((block) => block.type === "text")?.text;
	if (text === undefined) return undefined;
	try {
		return JSON.parse(text);
	} catch {
		return text;
	}
}

let cloudIdPromise: Promise<string> | undefined;

/** Resolves the Atlassian cloudId once per session: the first accessible resource. */
function getCloudId(pi: ExtensionAPI): Promise<string> {
	cloudIdPromise ||= (async () => {
		const raw = (await callJira(pi, "getAccessibleAtlassianResources", {})) as
			| { data?: { resources?: Array<{ cloudId?: string }> }; resources?: Array<{ cloudId?: string }> }
			| undefined;
		const cloudId = (raw?.data?.resources ?? raw?.resources ?? [])[0]?.cloudId;
		if (!cloudId) throw new Error("no accessible Atlassian resource");
		return cloudId;
	})();
	cloudIdPromise.catch(() => {
		cloudIdPromise = undefined;
	});
	return cloudIdPromise;
}

/** Jira's text content is HTML (ADF rendered). Reduce to readable plain text for the LLM. */
export function htmlToText(html: string): string {
	return html
		.replace(/<figure[\s\S]*?<\/figure>/g, "")
		.replace(/<li[^>]*>/g, "\n- ")
		.replace(/<br\s*\/?>/g, "\n")
		.replace(/<\/(p|ul|ol|h[1-6]|div|tr)>/g, "\n")
		.replace(/<[^>]+>/g, "")
		.replace(/&nbsp;/g, " ")
		.replace(/&amp;/g, "&")
		.replace(/&lt;/g, "<")
		.replace(/&gt;/g, ">")
		.replace(/&quot;/g, '"')
		.replace(/&#39;/g, "'")
		.replace(/\n+- /g, "\n- ")
		.replace(/\n{3,}/g, "\n\n")
		.trim();
}

function str(value: unknown): string | undefined {
	return typeof value === "string" ? value : undefined;
}

function named(value: unknown): string | undefined {
	return value && typeof value === "object" && "name" in value ? str((value as { name: unknown }).name) : undefined;
}

/** Jira REST shape: { key, fields: { summary, status, ... } }. */
function toSummary(raw: Record<string, unknown>, webBase?: string): JiraIssueSummary {
	const fields = (raw.fields ?? {}) as Record<string, unknown>;
	const key = String(raw.key ?? "");
	const status = fields.status as { name?: string; statusCategory?: { name?: string } } | undefined;
	const assignee = fields.assignee as { displayName?: string } | null | undefined;
	const project = fields.project as { key?: string; name?: string } | undefined;
	const rawDescription = typeof fields.description === "string" ? fields.description : undefined;
	const description = rawDescription ? htmlToText(rawDescription) : undefined;
	return {
		key,
		summary: str(fields.summary) ?? "",
		status: status?.name,
		statusCategory: status?.statusCategory?.name,
		priority: named(fields.priority),
		assignee: assignee?.displayName,
		project: project?.name,
		url: typeof raw.webUrl === "string" ? raw.webUrl : webBase && key ? `${webBase}/browse/${key}` : undefined,
		description,
	};
}

function extractIssues(raw: unknown): Record<string, unknown>[] {
	const data = raw as { issues?: { nodes?: Record<string, unknown>[] } | Record<string, unknown>[] } | undefined;
	if (Array.isArray(data?.issues)) return data.issues;
	return data?.issues?.nodes ?? [];
}

/** getJiraIssue returns one issue as `{ issues: { nodes: [issue] } }` (structuredContent) or `{ data }` / a bare issue. */
function unwrapIssue(raw: unknown): Record<string, unknown> | undefined {
	const value = raw as { data?: unknown; issues?: { nodes?: unknown[] } | unknown[] } | undefined;
	const nodes = Array.isArray(value?.issues) ? value.issues : value?.issues?.nodes;
	const candidate = nodes?.[0] ?? value?.data ?? value;
	return candidate && typeof candidate === "object" ? (candidate as Record<string, unknown>) : undefined;
}

async function fetchIssue(pi: ExtensionAPI, key: string): Promise<JiraIssueSummary> {
	const cloudId = await getCloudId(pi);
	const raw = await callJira(pi, "getJiraIssue", {
		cloudId,
		issueIdOrKey: key,
		view: "compact",
		fields: ["summary", "status", "priority", "assignee", "project", "description"],
	});
	const issue = unwrapIssue(raw);
	if (!issue || typeof issue.key !== "string") throw new Error(`no issue in response for ${key}`);
	return toSummary(issue);
}

async function listMyIssues(pi: ExtensionAPI, keys: string[]): Promise<JiraIssueSummary[]> {
	const cloudId = await getCloudId(pi);
	const raw = await callJira(pi, "searchJiraIssuesUsingJql", {
		cloudId,
		jql: `assignee = currentUser() AND statusCategory IN ("To Do", "In Progress") AND project IN (${keys.join(", ")}) ORDER BY updated DESC`,
		maxResults: MAX_SUGGESTIONS,
		fields: ["summary", "status", "priority", "assignee", "project"],
		view: "compact",
	});
	return extractIssues(raw).map((issue) => toSummary(issue));
}

function issueContext(issue: JiraIssueSummary): string {
	const lines = [
		`Jira ${issue.key}: ${issue.summary}`,
		[issue.status, issue.priority, issue.assignee, issue.project].filter(Boolean).join(" · "),
		issue.url,
	];
	const description = issue.description?.slice(0, MAX_DESCRIPTION_CHARS);
	if (description) lines.push("", description);
	return lines.filter((line) => line !== undefined && line !== "").join("\n");
}

function statusColor(issue: JiraIssueSummary): string {
	if (issue.statusCategory === "Done") return "success";
	if (issue.statusCategory === "In Progress") return "accent";
	return "muted";
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

function readKeys(): string[] {
    try {
        const keys = parseKeys(JSON.parse(readFileSync(CONFIG_PATH, "utf8")));
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

function createJiraAutocompleteProvider(current: AutocompleteProvider, pi: ExtensionAPI, keys: string[]): AutocompleteProvider {
	let cache: { at: number; issues: JiraIssueSummary[] } | undefined;

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
					cache = { at: Date.now(), issues: await listMyIssues(pi, keys) };
				} catch {
					return current.getSuggestions(lines, cursorLine, cursorCol, options);
				}
				if (options.signal.aborted) return null;
			}

			const wanted = token.toUpperCase();
			const items: AutocompleteItem[] = cache.issues
				.filter((issue) => {
					const id = issue.key.toUpperCase();
					return keys.includes(id.split("-")[0] ?? "") && id.startsWith(wanted);
				})
				.slice(0, MAX_SUGGESTIONS)
				.map((issue) => ({
					value: `#${issue.key}`,
					label: `#${issue.key}`,
					description: `Jira${issue.status ? ` [${issue.status}]` : ""} ${issue.summary}`,
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
		const details = message.details as { issues?: JiraIssueSummary[] } | undefined;
		const box = new Box(outputPad, 1, (t) => theme.bg("customMessageBg", t));
		for (const issue of details?.issues ?? []) {
			const head = `${issue.status ? `[${issue.status}] ` : ""}${issue.key} ${issue.summary}`;
			box.addChild(new Text(theme.fg(statusColor(issue), head), 0, 0));
			const meta = [issue.priority, issue.assignee, issue.project].filter(Boolean).join(" · ");
			if (meta) box.addChild(new Text(theme.fg("dim", meta), 0, 0));
			if (expanded && issue.url) box.addChild(new Text(theme.fg("dim", issue.url), 0, 0));
		}
		return box;
	});

	pi.on("before_agent_start", async (event, ctx) => {
		if (event.messageType !== "user" || !event.prompt) return undefined;

		const keys = [...new Set([...event.prompt.matchAll(ISSUE_REF)].map((m) => m[1]!).filter((id) => readKeys().includes(id.split("-")[0] ?? "")))].slice(0, MAX_ISSUES_PER_PROMPT);
		if (keys.length === 0) return undefined;

		const results = await Promise.all(
			keys.map(async (key) => {
				try {
					return await fetchIssue(pi, key);
				} catch (error) {
					ctx.ui.notify(`jira: ${key}: ${error instanceof Error ? error.message : String(error)}`, "warning");
					return undefined;
				}
			}),
		);
		const issues = results.filter((issue): issue is JiraIssueSummary => issue !== undefined && issue.key !== "");
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
		ctx.ui.addAutocompleteProvider((current) => createJiraAutocompleteProvider(current, pi, keys));
	});
}
