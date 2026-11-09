# pi

Pi coding-agent extensions for Linear, Jira and GitHub pull requests.

| Extension | In a prompt | `#` autocomplete |
| --- | --- | --- |
| `packages/linear` | `#ABC-85` → fetches the Linear issue and attaches it as context | Your assigned Linear issues (Todo and In Progress) for keys in `config.json` |
| `packages/jira` | `#DEF-2110` → fetches the Jira issue and attaches it as context | Your assigned Jira issues (To Do and In Progress) for keys in `config.json` |
| `packages/github-pr` | `#76` → fetches PR #76 of the current repo and attaches it as context | Open PRs of the current repo |

Each reference is attached to the message it appears in, and rendered as a card in the TUI. Up to 5 references per prompt.

## Requirements

- [Pi](https://pi.dev) with extension support.
- For Linear and Jira: the [`pi-mcp-adapter`](https://www.npmjs.com/package/pi-mcp-adapter) package, with `linear` and `jira` MCP servers configured in `~/.pi/agent/mcp.json`. The extensions call these servers through the adapter. They don't hold credentials.
- For GitHub PRs: the [`gh`](https://cli.github.com) CLI, logged in, and a session started inside a GitHub repository. Only that repository is used, since `gh` resolves it from the git remote of the working directory.

## Install

Install the whole package from GitHub:

```sh
pi install git:github.com/tailoredstack/pi
```

Pi clones the repository and loads all three extensions. Restart pi or run `/reload` afterwards.

To try it for one run without saving it to settings:

```sh
pi -e git:github.com/tailoredstack/pi
```

Pi does not document a way to install a single subfolder of a git repository, so installing from GitHub loads all three extensions. To load only some of them, use a local checkout (below).

### Local checkout

```sh
git clone git@github.com:tailoredstack/pi.git
pi install ./pi
```

To load only some extensions, add them to `~/.pi/agent/settings.json` with the object form, or symlink the package folders into `~/.pi/agent/extensions/`:

```sh
for p in linear jira github-pr; do
  ln -sfn "$PWD/packages/$p" ~/.pi/agent/extensions/$p
done
```

## Configure

Linear and Jira only fetch and complete keys listed in their own `config.json`. Each file lives next to its extension:

```json
// packages/linear/config.json
{ "projects": ["ABC", "XYZ"] }
```

```json
// packages/jira/config.json
{ "projects": ["DEF"] }
```

Keys are matched case-insensitively. A `#KEY-n` reference whose key is not listed is ignored, so other text is never sent to Linear or Jira.

The shipped default in each `config.default.json` is an empty list, so nothing is fetched or completed until you add keys. Copy it to `config.json` to start.

When you install from GitHub, Pi keeps a managed copy. Edit `config.json` in the installed copy, or use a local checkout so your edits survive updates.

### Linear

Linear keys are Linear team keys. Check yours with the Linear MCP (`linear_list_teams`).

### Jira

Jira keys are project keys (for example `DEF` in `DEF-2110`). List them with the Jira MCP (`listJiraProjects`).

## How it works

- **Prompts:** on each sent prompt, every `#` reference matching a configured key (Linear, Jira) or a number (GitHub PR) is fetched before the run starts. The result is stored as a `linear-issue`, `jira-issue` or `github-pr` message, sent to the model, and shown as a card. Failed fetches show a warning and the prompt is still sent.
- **Autocomplete:** typing `#` opens suggestions from each extension. An extension only claims a token whose key is configured, so `#ABC-` shows Linear, `#DEF-` shows Jira, and `#7` shows PRs. Other tokens fall back to pi's built-in completion.
- **Caching:** autocomplete lists are cached for 30 seconds per extension.
- **Scope:** Linear and Jira show only items assigned to you. GitHub shows open PRs of the repository the session was started in.

## Packages

```text
packages/
  linear/      index.ts, config.json   Linear refs and autocomplete
  jira/        index.ts, config.json   Jira refs and autocomplete
  github-pr/   index.ts                GitHub PR refs and autocomplete (gh)
```

Each package declares Pi's host packages (`@earendil-works/pi-coding-agent`, `@earendil-works/pi-tui`) as `"*"` peer dependencies and does not bundle them. Linear and Jira declare `pi-mcp-adapter` as an optional peer.

## Develop

```sh
npm install
for p in linear jira github-pr; do bun build packages/$p/index.ts --no-bundle --outdir /tmp/check >/dev/null; done
```

Changes take effect after restarting pi or running `/reload`.

## Known limits

- Linear and Jira ids are matched by key only. Keys that exist in both systems are not disambiguated; the first matching provider shows its results.
- Prompt references are fetched once per prompt; the model does not re-fetch them later in the session.
- The GitHub list is capped at 20 open PRs.
