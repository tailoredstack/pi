/**
 * GitHub pull request extension for pi, built on the `gh` CLI.
 *
 * Scoped to the current repository: `gh` resolves the repo from the git remote of
 * the session cwd, and no `--repo` flag is passed, so it cannot reach other repos.
 *
 * - `#123` in a prompt fetches PR #123 of the current repo and attaches it as context,
 *   rendered as a card in the TUI.
 * - Typing `#` in the editor autocompletes open PRs of the current repo.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
	type AutocompleteItem,
	type AutocompleteProvider,
	type AutocompleteSuggestions,
	Box,
	Text,
} from "@earendil-works/pi-tui";

const CUSTOM_TYPE = "github-pr";
const MAX_PRS_PER_PROMPT = 5;
const MAX_SUGGESTIONS = 20;
const MAX_BODY_CHARS = 4000;
const SUGGESTION_TTL_MS = 30_000;
const EXEC_TIMEOUT_MS = 10_000;

const PR_REF = /(?<!\w)#(\d+)\b/g;
const PR_TOKEN = /(?:^|[ \t])#(\d+)$/;

export interface PrSummary {
	number: number;
	title: string;
	url?: string;
	state?: string;
	isDraft?: boolean;
	author?: string;
	headRefName?: string;
	baseRefName?: string;
	reviewDecision?: string;
	additions?: number;
	deletions?: number;
	changedFiles?: number;
	body?: string;
}

type ExecResult = { code: number; stdout: string; stderr: string };

const PR_FIELDS = [
	"number",
	"title",
	"url",
	"state",
	"isDraft",
	"author",
	"headRefName",
	"baseRefName",
	"reviewDecision",
	"additions",
	"deletions",
	"changedFiles",
	"body",
].join(",");

async function gh(pi: ExtensionAPI, cwd: string, args: string[]): Promise<ExecResult> {
	return pi.exec("gh", args, { cwd, timeout: EXEC_TIMEOUT_MS });
}

function toSummary(raw: Record<string, unknown>): PrSummary {
	const author = raw.author as { login?: string } | null | undefined;
	return {
		number: Number(raw.number),
		title: String(raw.title ?? ""),
		url: typeof raw.url === "string" ? raw.url : undefined,
		state: typeof raw.state === "string" ? raw.state : undefined,
		isDraft: typeof raw.isDraft === "boolean" ? raw.isDraft : undefined,
		author: author?.login,
		headRefName: typeof raw.headRefName === "string" ? raw.headRefName : undefined,
		baseRefName: typeof raw.baseRefName === "string" ? raw.baseRefName : undefined,
		reviewDecision: typeof raw.reviewDecision === "string" && raw.reviewDecision ? raw.reviewDecision : undefined,
		additions: typeof raw.additions === "number" ? raw.additions : undefined,
		deletions: typeof raw.deletions === "number" ? raw.deletions : undefined,
		changedFiles: typeof raw.changedFiles === "number" ? raw.changedFiles : undefined,
		body: typeof raw.body === "string" ? raw.body : undefined,
	};
}

async function fetchPr(pi: ExtensionAPI, cwd: string, number: number): Promise<PrSummary> {
	const result = await gh(pi, cwd, ["pr", "view", String(number), "--json", PR_FIELDS]);
	if (result.code !== 0) throw new Error(result.stderr.trim() || `gh exited ${result.code}`);
	return toSummary(JSON.parse(result.stdout) as Record<string, unknown>);
}

async function listOpenPrs(pi: ExtensionAPI, cwd: string): Promise<PrSummary[]> {
	const result = await gh(pi, cwd, [
		"pr",
		"list",
		"--state",
		"open",
		"--limit",
		String(MAX_SUGGESTIONS),
		"--json",
		"number,title,isDraft,author,headRefName,url",
	]);
	if (result.code !== 0) throw new Error(result.stderr.trim() || `gh exited ${result.code}`);
	return (JSON.parse(result.stdout) as Record<string, unknown>[]).map(toSummary);
}

function prContext(pr: PrSummary): string {
	const meta = [
		pr.state,
		pr.isDraft ? "draft" : undefined,
		pr.reviewDecision,
		pr.headRefName && pr.baseRefName ? `${pr.headRefName} → ${pr.baseRefName}` : undefined,
		pr.author ? `by ${pr.author}` : undefined,
		pr.additions !== undefined ? `+${pr.additions} −${pr.deletions ?? 0} in ${pr.changedFiles ?? 0} files` : undefined,
	].filter(Boolean);
	const lines = [`#${pr.number}: ${pr.title}`, meta.join(" · "), pr.url];
	const body = pr.body?.slice(0, MAX_BODY_CHARS);
	if (body) lines.push("", body);
	return lines.filter((line) => line !== undefined && line !== "").join("\n");
}

function stateColor(pr: PrSummary): string {
	if (pr.state === "MERGED") return "accent";
	if (pr.state === "CLOSED") return "dim";
	if (pr.isDraft) return "muted";
	return "success";
}


function createPrAutocompleteProvider(current: AutocompleteProvider, pi: ExtensionAPI, cwd: string): AutocompleteProvider {
	let cache: { at: number; prs: PrSummary[] } | undefined;

	return {
		triggerCharacters: ["#"],
		async getSuggestions(lines, cursorLine, cursorCol, options): Promise<AutocompleteSuggestions | null> {
			const beforeCursor = (lines[cursorLine] ?? "").slice(0, cursorCol);
			const match = beforeCursor.match(PR_TOKEN);
			if (!match) return current.getSuggestions(lines, cursorLine, cursorCol, options);
			const token = match[1] ?? "";

			if (!cache || Date.now() - cache.at >= SUGGESTION_TTL_MS) {
				try {
					cache = { at: Date.now(), prs: await listOpenPrs(pi, cwd) };
				} catch {
					// Not a GitHub repo, gh missing, or not logged in: fall back silently.
					return current.getSuggestions(lines, cursorLine, cursorCol, options);
				}
				if (options.signal.aborted) return null;
			}

			const items: AutocompleteItem[] = cache.prs
				.filter((pr) => String(pr.number).startsWith(token))
				.slice(0, MAX_SUGGESTIONS)
				.map((pr) => ({
					value: `#${pr.number}`,
					label: `#${pr.number}`,
					description: `GitHub ${pr.isDraft ? "[draft] " : ""}${pr.title}`,
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
		const details = message.details as { prs?: PrSummary[] } | undefined;
		const box = new Box(outputPad, 1, (t) => theme.bg("customMessageBg", t));
		for (const pr of details?.prs ?? []) {
			const head = `${pr.state ? `[${pr.state.toLowerCase()}${pr.isDraft ? ", draft" : ""}] ` : ""}#${pr.number} ${pr.title}`;
			box.addChild(new Text(theme.fg(stateColor(pr), head), 0, 0));
			const meta = [pr.headRefName && pr.baseRefName ? `${pr.headRefName} → ${pr.baseRefName}` : undefined, pr.reviewDecision, pr.author]
				.filter(Boolean)
				.join(" · ");
			if (meta) box.addChild(new Text(theme.fg("dim", meta), 0, 0));
			if (expanded && pr.url) box.addChild(new Text(theme.fg("dim", pr.url), 0, 0));
		}
		return box;
	});

	pi.on("before_agent_start", async (event, ctx) => {
		if (event.messageType !== "user" || !event.prompt) return undefined;

		const numbers = [...new Set([...event.prompt.matchAll(PR_REF)].map((m) => Number(m[1])))].slice(0, MAX_PRS_PER_PROMPT);
		if (numbers.length === 0) return undefined;

		const results = await Promise.all(
			numbers.map(async (number) => {
				try {
					return await fetchPr(pi, ctx.cwd, number);
				} catch (error) {
					ctx.ui.notify(`github-pr: #${number}: ${error instanceof Error ? error.message : String(error)}`, "warning");
					return undefined;
				}
			}),
		);
		const prs = results.filter((pr): pr is PrSummary => pr !== undefined);
		if (prs.length === 0) return undefined;

		return {
			message: {
				customType: CUSTOM_TYPE,
				content: prs.map(prContext).join("\n\n---\n\n"),
				display: true,
				details: { prs: prs.map(({ body, ...rest }) => ({ ...rest, body: body?.slice(0, 600) })) },
			},
		};
	});

	pi.on("session_start", (_event, ctx) => {
		ctx.ui.addAutocompleteProvider((current) => createPrAutocompleteProvider(current, pi, ctx.cwd));
	});
}
