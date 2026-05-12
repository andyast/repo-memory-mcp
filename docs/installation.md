# Installation

Repo-memory can be used from a local clone while dogfooding, or installed as an npm package once published/packed.

## Requirements

- Node.js 20+
- npm
- Git repo to attach memory to

Native dependency note: repo-memory uses `better-sqlite3`, so npm may compile a native module on install if a prebuilt binary is not available for your platform.

## Option A: local clone, recommended for dogfooding

```bash
git clone https://github.com/pinchworth-ops/repo-memory-mcp.git
cd repo-memory-mcp
npm install
npm run build
npm link
```

Verify the CLI and MCP server bins:

```bash
repo-memory --help
repo-memory-mcp # starts the MCP stdio server; stop with Ctrl-C
```

Initialize a test repo:

```bash
cd /path/to/test-repo
repo-memory init --update-gitignore
repo-memory context --task "understand this repo"
```

## Option B: install from a packed tarball

From the repo-memory checkout:

```bash
npm pack
npm install -g ./repo-memory-mcp-0.1.0.tgz
```

Then verify:

```bash
repo-memory --help
```

## Option C: install from npm, once published

```bash
npm install -g repo-memory-mcp
repo-memory --help
```

## MCP client config

Build first if using a local clone:

```bash
npm run build
```

Use the installed binary when available:

```json
{
  "mcpServers": {
    "repo-memory": {
      "command": "repo-memory-mcp",
      "env": {
        "REPO_MEMORY_ALLOWED_ROOT": "/absolute/path/to/repos"
      }
    }
  }
}
```

Or point directly at a local clone:

```json
{
  "mcpServers": {
    "repo-memory": {
      "command": "node",
      "args": ["/absolute/path/to/repo-memory-mcp/dist/server.js"],
      "env": {
        "REPO_MEMORY_ALLOWED_ROOT": "/absolute/path/to/repos"
      }
    }
  }
}
```

For early dogfooding, set `REPO_MEMORY_ALLOWED_ROOT` to the parent directory containing the repos you want agents to access.

## Smoke test an install

```bash
mkdir -p /tmp/repo-memory-install-test
cd /tmp/repo-memory-install-test
git init
repo-memory init --update-gitignore
repo-memory remember --title "Install test" --claim "repo-memory CLI can store memories." --tags install
repo-memory search --query install
```

## Uninstall

If installed with `npm link` from a local checkout:

```bash
npm unlink -g repo-memory-mcp
```

If installed globally:

```bash
npm uninstall -g repo-memory-mcp
```
