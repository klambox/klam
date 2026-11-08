# klam

Manage & run your personal GitHub tools from any machine.

```bash
npx github:klambox/klambox list          # or `npx klambox ...` once published to npm
klam add shellnote klambox/shellnote --desc "shell notes"
klam registry https://raw.githubusercontent.com/klambox/klambox/main/registry.json   # share list across machines
klam list
klam update                # registry + all installed tools (git pull --ff-only)
klam shellnote [args]      # auto-clone on first use, then run
klam shellnote update      # update one
klam shellnote sync        # commit, pull --rebase, push
klam shellnote status|path|remove
```

Tools live in `~/.klam/tools/<name>` (override: `KLAM_HOME`). How a tool runs, in priority:
registry `run` > `klam.json` `{ "run": "...", "setup": "..." }` in the tool repo > package.json `bin` > `main.py` > `run.sh`.
`{dir}` in `run` expands to the tool folder. Remote registry format: `{ "tools": { "name": { "repo": "user/repo", "desc": "" } } }`.
