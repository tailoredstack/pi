# pi

Pi coding-agent extensions, one package per integration.

| Package | Refs in prompts | Autocomplete (`#`) |
| --- | --- | --- |
| `packages/linear` | `#ABC-85` | Linear issues assigned to you, for keys in `config.json` |
| `packages/jira` | `#CPA-2110` | Jira issues assigned to you, for keys in `config.json` |
| `packages/github-pr` | `#76` | Open PRs of the repo pi runs in (via `gh`) |

Linear and Jira use the MCP servers `linear` and `jira` through pi-mcp-adapter.
Only keys listed in a package's `config.json` are fetched or completed.

```json
// packages/linear/config.json
{ "projects": ["ABC", "XYZ"] }
```

## Install

Pi loads extensions from `~/.pi/agent/extensions`. Link each package there:

```sh
for p in linear jira github-pr; do
  ln -sfn "$PWD/packages/$p" ~/.pi/agent/extensions/$p
done
```

Then restart pi or run `/reload`.
