# klambox

Manage and run GitHub Klam's tools from any machine: `npx klambox <tool>`.

## Quick start

Requires Node 18+ and git. No install or setup: `npx klambox` is the main entry point and fetches the tool list from this repo's `registry.json` by itself.

```bash
npx klambox list
npx klambox shellnote
```

Optional shortcut: `npm i -g klambox` once, then `klam <command>` (or `klambox <command>`) works the same without `npx`.

## Usage

```bash
npx klambox list                     # tools + status (not installed / behind / up to date)
npx klambox shellnote [args]         # auto-clone on first use, then run
npx klambox update                   # refresh the list + git pull --ff-only every installed tool
npx klambox shellnote update         # update one tool
npx klambox shellnote status|path|install|remove
npx klambox shellnote --help        # the tool's own help, read from its repo
npx klambox --version
npx klambox add <name> <user/repo> [--branch b] [--run "cmd"] [--desc "..."]   # add a tool on this machine only
npx klambox registry [url|none|default]   # optional: use another registry (default: klambox/klam on GitHub)
```

Every tool tracks `main` unless its registry entry sets `branch`.

## Updating klambox itself

- `npx klambox update` updates every installed tool **and** checks whether a newer klambox exists.
- When a newer version is on npm, klambox prints one line on stderr (terminal only; it never pollutes piped output). The check runs at most once per 24h, has a 3s timeout, is silent when offline, and tool runs only read the cached result, so they are never slowed down.
- `npx klambox self-update`: a global install runs `npm i -g klambox@latest`; under `npx` it explains that `npx klambox@latest <command>` always uses the newest version.
- Turn the check off with `KLAM_NO_UPDATE_CHECK=1` (also off when `CI` or `NO_UPDATE_NOTIFIER` is set).
- `registry.json` may carry `"minVersion"`: a klambox older than that prints a warning telling the user to update.

## Making a tool klam-compatible

klam runs tools written in **Node.js** or **Python** (or a shell script) with no per-tool code in klam. A tool repo needs nothing special if it follows a convention; otherwise add a `klam.json` at the repo root.

How klam finds what to run (first match wins; the registry entry beats the tool's own `klam.json`):

1. `entry` (a file path in the repo; the runtime is inferred from `.js/.mjs/.cjs`, `.py`, `.sh`, or set `"runtime": "node" | "python" | "bash"`), else `run` (a raw shell command; `{dir}` expands to the quoted tool folder; do not quote it yourself)
2. Node: `package.json` `bin`, then `main`, then `index.js`
3. Python: `__main__.py`, then `main.py`, then `<name>.py`
4. `run.sh` or `<name>.sh`

Entries are executed **without a shell** (Node via the same Node that runs klam, Python via the tool's virtualenv or `python3` / `py -3` / `python`), so arguments and paths with spaces or quotes pass through unchanged.

Dependencies are installed automatically on first run and again after an update changes the tool:

- Node: `package.json` `dependencies` -> `npm ci` (with a lockfile) or `npm install --omit=dev` into the tool folder.
- Python: `requirements.txt` -> a private virtualenv at `~/.klam/envs/<name>` (never the system Python). Tools using only the standard library get no virtualenv.
- Anything else: set `"setup": "<shell command>"` in `klam.json`. If setup fails it is retried on the next run.

The tool runs in **your current directory** (so relative paths in arguments work). `KLAM_TOOL_DIR` points at the tool folder.

### Help

`npx klambox <tool> --help` (also `-h`, or `npx klambox help <tool>`) shows help **read from the tool's own repo**, so it follows `npx klambox update` and klam itself holds no help text. Source, first match wins:

1. `klam.json` `"helpArgs": ["--help"]`: runs the tool itself with those arguments (use this when the tool prints its own help; do not use it for servers)
2. `klam.json` `"help": "docs/help.txt"`, else `HELP.txt`, `HELP.md` or `help.txt` in the repo root
3. otherwise the tool's `README.md` is shown, with a note asking the tool author to add one of the above

`npx klambox run <tool> --help` passes `--help` straight to the tool.

### Example `klam.json`

```json
{ "entry": "src/cli.py", "setup": "python -m pip install -e .", "help": "docs/help.txt" }
```

Tools live in `~/.klam/tools/<name>` (override with `KLAM_HOME`). A registry entry (`registry.json`) can also carry `branch`, `entry`, `runtime`, `run`, `setup`, `help`, `helpArgs` and `desc`.

## Read-only by design

klam only clones and `git pull --ff-only`s. It has no push/commit/sync command, and every managed clone gets `remote.origin.pushurl` set to a dummy value so `git push` from `~/.klam/tools/*` fails. Change tools in their own working copy elsewhere, push there, then run `npx klambox update`.

Note: `entry`, `run`, `setup` and `helpArgs` execute commands from the tool repo (or the registry). Only register repos and registries you control.
