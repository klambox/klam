#!/usr/bin/env node
// klam - manage and run personal GitHub tools. Zero dependencies.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const HOME = process.env.KLAM_HOME || path.join(os.homedir(), '.klam');
const TOOLS = path.join(HOME, 'tools');
const REGISTRY = path.join(HOME, 'registry.json'); // local only: { remote?: url|false, tools: { name: {repo, branch?, entry?, runtime?, run?, setup?, desc?} } }
const CACHE = path.join(HOME, 'remote-cache.json'); // last fetched copy of the remote registry
const DEFAULT_REGISTRY = 'https://raw.githubusercontent.com/klambox/klam/main/registry.json';
const DEFAULT_BRANCH = 'main';

const RESERVED = ['list', 'ls', 'add', 'remove', 'rm', 'install', 'update', 'upgrade', 'status',
  'path', 'run', 'registry', 'help'];

const c = (n, s) => (process.stdout.isTTY ? `\x1b[${n}m${s}\x1b[0m` : s);
const green = (s) => c(32, s), yellow = (s) => c(33, s), red = (s) => c(31, s), dim = (s) => c(2, s), bold = (s) => c(1, s);
const die = (m) => { console.error(red('✗ ') + m); process.exit(1); };

const readJson = (f, d) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return d; } };
// reg.local = tools you added on this machine; reg.tools = remote registry + local (local wins)
function loadReg() {
  const file = readJson(REGISTRY, {});
  const cached = readJson(CACHE, {});
  const local = file.tools || {};
  return { remote: file.remote, local, tools: { ...(cached.tools || {}), ...local } };
}
function saveReg(r) {
  fs.mkdirSync(HOME, { recursive: true });
  fs.writeFileSync(REGISTRY, JSON.stringify({ remote: r.remote, tools: r.local }, null, 2) + '\n');
}
const dirOf = (name) => path.join(TOOLS, name);
const isInstalled = (name) => fs.existsSync(path.join(dirOf(name), '.git'));

function git(dir, args, { inherit = false } = {}) {
  const r = spawnSync('git', args, { cwd: dir, encoding: 'utf8', stdio: inherit ? 'inherit' : 'pipe' });
  if (r.error) die('git not found. Install git first.');
  return { ok: r.status === 0, out: (r.stdout || '').trim(), err: (r.stderr || '').trim() };
}

// klam is read-only toward tool repos: pull/update only. Disable pushing from every managed clone.
function lockPush(dir) {
  git(dir, ['config', 'remote.origin.pushurl', 'DISABLED_BY_KLAM']);
}

function normRepo(s) {
  if (/^[\w.-]+\/[\w.-]+$/.test(s)) return `https://github.com/${s}.git`; // user/repo shorthand
  return s;
}

// Fetch the remote registry (default: klambox/klam on GitHub) into a cache. Falls back to the cache offline.
async function syncRemoteRegistry(quiet) {
  const reg = loadReg();
  const url = reg.remote === false ? null : reg.remote || DEFAULT_REGISTRY;
  if (!url) return reg;
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(8000) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const remote = await res.json();
    fs.mkdirSync(HOME, { recursive: true });
    fs.writeFileSync(CACHE, JSON.stringify({ tools: remote.tools || remote }, null, 2) + '\n');
    if (!quiet) console.log(dim(`registry synced from ${url}`));
    return loadReg();
  } catch (e) {
    if (!quiet || !fs.existsSync(CACHE)) console.error(yellow(`! could not fetch registry (${e.message}); using cached copy`));
    return reg;
  }
}

function need(reg, name) {
  if (!name) die('missing tool name');
  if (!reg.tools[name]) die(`unknown tool "${name}". Try: npx klambox list   |   npx klambox add ${name} <user/repo>`);
  return reg.tools[name];
}

function install(name, reg, { setup = true } = {}) {
  const t = need(reg, name);
  if (isInstalled(name)) return console.log(dim(`${name} already installed`));
  fs.mkdirSync(TOOLS, { recursive: true });
  console.log(`Installing ${bold(name)} from ${t.repo} ...`);
  const branch = t.branch || DEFAULT_BRANCH;
  const r = git(TOOLS, ['clone', '--branch', branch, normRepo(t.repo), name], { inherit: true });
  if (!r.ok) die(`clone failed for ${name} (branch "${branch}" must exist in ${t.repo})`);
  lockPush(dirOf(name));
  if (!setup) return console.log(green(`✓ ${name} cloned`));
  if (ensureSetup(name, reg)) console.log(green(`✓ ${name} installed`));
  else console.log(yellow(`! ${name} cloned but setup failed; it will be retried on the next run`));
}

// ---------- setup (dependencies) ----------
const STATE = path.join(HOME, 'state'); // per-tool setup stamp: { head, ok }
const ENVS = path.join(HOME, 'envs'); // per-tool Python virtualenvs (outside the clone so git stays clean)
const WIN = process.platform === 'win32';
const stampFile = (name) => path.join(STATE, `${name}.json`);
const headOf = (dir) => git(dir, ['rev-parse', 'HEAD']).out;

// Quote one argument for the platform shell (only used for `run` strings and `setup`).
function shq(s) {
  return WIN ? `"${String(s).replaceAll('"', '\\"')}"` : `'${String(s).replaceAll("'", "'\\''")}'`;
}

// Effective per-tool config. Whichever of {registry entry, tool's klam.json} defines how to run wins as a whole.
function effectiveCfg(name, reg) {
  const t = reg.tools[name] || {};
  const k = readJson(path.join(dirOf(name), 'klam.json'), {});
  const how = t.entry || t.run ? t : k;
  return { entry: how.entry, run: how.run, runtime: how.runtime, setup: t.setup ?? k.setup };
}

function probe(cmd, pre) {
  const r = spawnSync(cmd, [...pre, '--version'], { stdio: 'ignore' });
  return !r.error && r.status === 0;
}
let sysPy;
function systemPython() {
  if (sysPy !== undefined) return sysPy;
  const candidates = WIN ? [['py', '-3'], ['python'], ['python3']] : [['python3'], ['python']];
  sysPy = candidates.find(([cmd, ...pre]) => probe(cmd, pre)) || null;
  return sysPy;
}
const venvPython = (name) => path.join(ENVS, name, WIN ? 'Scripts' : 'bin', WIN ? 'python.exe' : 'python');
function pythonFor(name) {
  if (fs.existsSync(venvPython(name))) return [venvPython(name)];
  return systemPython();
}

const nodeDeps = (dir) => Object.keys(readJson(path.join(dir, 'package.json'), {}).dependencies || {}).length > 0;

function npm(args, dir) {
  // npm is a .cmd on Windows and needs a shell; pass one command string there (an args array with shell:true is deprecated)
  const r = WIN ? spawnSync(['npm', ...args].join(' '), { cwd: dir, stdio: 'inherit', shell: true })
    : spawnSync('npm', args, { cwd: dir, stdio: 'inherit' });
  return r.status === 0;
}

// Returns true when the tool is ready to run.
function doSetup(name, reg) {
  const dir = dirOf(name);
  const cfg = effectiveCfg(name, reg);
  if (cfg.setup) {
    console.log(dim(`setup: ${cfg.setup}`));
    return spawnSync(cfg.setup.replaceAll('{dir}', shq(dir)), { cwd: dir, shell: true, stdio: 'inherit' }).status === 0;
  }
  if (nodeDeps(dir)) {
    const locked = ['package-lock.json', 'npm-shrinkwrap.json'].some((f) => fs.existsSync(path.join(dir, f)));
    console.log(dim(`setup: npm ${locked ? 'ci' : 'install'} (node dependencies)`));
    // --no-package-lock: never let npm write a lockfile into the clone (it would block a later `git pull` of a real one)
    if (!((locked && npm(['ci', '--omit=dev'], dir)) || npm(['install', '--omit=dev', '--no-package-lock'], dir))) return false;
  }
  const req = path.join(dir, 'requirements.txt');
  if (fs.existsSync(req)) {
    const py = systemPython();
    if (!py) { console.error(red('✗ ') + 'Python 3 not found (needed for requirements.txt). Install Python 3 and retry.'); return false; }
    console.log(dim('setup: python virtualenv + requirements.txt'));
    if (!fs.existsSync(venvPython(name))) {
      fs.mkdirSync(ENVS, { recursive: true });
      const v = spawnSync(py[0], [...py.slice(1), '-m', 'venv', path.join(ENVS, name)], { stdio: 'inherit' });
      if (v.status !== 0) return false;
    }
    return spawnSync(venvPython(name), ['-m', 'pip', 'install', '-r', req], { cwd: dir, stdio: 'inherit' }).status === 0;
  }
  return true;
}

// Run setup when the tool has never been set up, the last attempt failed, HEAD moved, or node_modules vanished.
function ensureSetup(name, reg) {
  const dir = dirOf(name);
  const head = headOf(dir);
  const st = readJson(stampFile(name), null);
  const nodeMissing = nodeDeps(dir) && !fs.existsSync(path.join(dir, 'node_modules'));
  if (st && st.ok && st.head === head && !nodeMissing) return true;
  const ok = doSetup(name, reg);
  fs.mkdirSync(STATE, { recursive: true });
  fs.writeFileSync(stampFile(name), JSON.stringify({ head, ok }));
  return ok;
}

// ---------- running ----------
const RUNTIMES = { node: ['.js', '.mjs', '.cjs'], python: ['.py'], bash: ['.sh'] };
const runtimeOfFile = (f) => Object.keys(RUNTIMES).find((rt) => RUNTIMES[rt].includes(path.extname(f).toLowerCase()));

// -> { shell } for a raw `run` string, or { cmd, pre } (interpreter + leading args; script path included) executed without a shell.
function resolveRun(name, reg) {
  const dir = dirOf(name);
  const cfg = effectiveCfg(name, reg);
  const abs = (rel) => {
    const p = path.resolve(dir, rel);
    if (p !== dir && !p.startsWith(dir + path.sep)) die(`entry "${rel}" of ${name} points outside the tool folder`);
    if (!fs.existsSync(p)) die(`entry "${rel}" of ${name} does not exist in ${dir}`);
    return p;
  };
  const exec = (runtime, file) => {
    if (runtime === 'node') return { cmd: process.execPath, pre: [file] };
    if (runtime === 'python') {
      const py = pythonFor(name);
      if (!py) die('Python 3 not found. Install Python 3 (on Windows: the py launcher) and retry.');
      return { cmd: py[0], pre: [...py.slice(1), file] };
    }
    if (runtime === 'bash') return { cmd: 'bash', pre: [file] };
    die(`unknown runtime "${runtime}" (use node, python or bash)`);
  };

  if (cfg.entry) {
    const file = abs(cfg.entry);
    const runtime = cfg.runtime || runtimeOfFile(file);
    if (!runtime) die(`cannot tell how to run "${cfg.entry}" of ${name}; set "runtime": "node" | "python" | "bash"`);
    return exec(runtime, file);
  }
  if (cfg.run) return { shell: cfg.run.replaceAll('{dir}', shq(dir)) };

  const has = (f) => fs.existsSync(path.join(dir, f));
  const pkg = readJson(path.join(dir, 'package.json'), null);
  if (pkg) {
    const bin = typeof pkg.bin === 'string' ? pkg.bin : Object.values(pkg.bin || {})[0];
    const main = bin || pkg.main || (has('index.js') ? 'index.js' : null);
    if (main) return exec('node', abs(main));
  }
  for (const f of ['__main__.py', 'main.py', `${name}.py`]) if (has(f)) return exec('python', abs(f));
  for (const f of ['run.sh', `${name}.sh`]) if (has(f)) return exec('bash', abs(f));
  die(`don't know how to run ${name}. Add a klam.json to the tool repo, e.g. {"entry": "src/cli.py"} (runtime is inferred from .js/.py/.sh; or {"run": "cmd"}).`);
}

function runTool(name, args, reg) {
  need(reg, name);
  if (!isInstalled(name)) install(name, reg);
  if (!ensureSetup(name, reg)) die(`setup of ${name} failed (see above). Fix it and run again; setup is retried automatically.`);
  const plan = resolveRun(name, reg);
  const opts = { stdio: 'inherit', cwd: process.cwd(), env: { ...process.env, KLAM_TOOL_DIR: dirOf(name) } };
  const r = plan.shell
    ? spawnSync(`${plan.shell} ${args.map(shq).join(' ')}`, { ...opts, shell: true })
    : spawnSync(plan.cmd, [...plan.pre, ...args], opts);
  if (r.error) die(`could not start ${plan.cmd || 'command'}: ${r.error.message}`);
  process.exit(r.status ?? 1);
}

// `klam <tool> --help`: the text always comes from the tool's own repo (so it updates with `klam update`), never from klam.
// Source order: registry/klam.json "helpArgs" (run the tool with those args) > "help" file path > HELP.txt > HELP.md > help.txt > README.md (fallback).
function showHelp(name, reg) {
  need(reg, name);
  if (!isInstalled(name)) install(name, reg, { setup: false });
  const dir = dirOf(name);
  const t = reg.tools[name];
  const k = readJson(path.join(dir, 'klam.json'), {});
  const helpArgs = t.helpArgs ?? k.helpArgs;
  if (helpArgs) return runTool(name, [].concat(helpArgs), reg);
  const inside = (rel) => {
    const p = path.resolve(dir, rel);
    return (p === dir || p.startsWith(dir + path.sep)) && fs.existsSync(p) && fs.statSync(p).isFile() ? p : null;
  };
  console.log(`${bold(name)}${t.desc ? dim(' - ' + t.desc) : ''}`);
  const dedicated = [t.help ?? k.help, 'HELP.txt', 'HELP.md', 'help.txt'].filter(Boolean).map(inside).find(Boolean);
  if (dedicated) return console.log('\n' + fs.readFileSync(dedicated, 'utf8').trimEnd());
  const readme = inside('README.md');
  console.log(yellow('\n! this tool has no help file; showing its README.md instead.'));
  console.log(dim('  Tool author: add HELP.txt to the repo (or klam.json {"help": "path"} / {"helpArgs": ["--help"]}).'));
  if (readme) {
    const lines = fs.readFileSync(readme, 'utf8').trimEnd().split('\n');
    console.log('\n' + lines.slice(0, 60).join('\n') + (lines.length > 60 ? dim(`\n... (${lines.length - 60} more lines in ${readme})`) : ''));
  }
  console.log(dim(`\nrun the tool itself with --help: npx klambox run ${name} --help`));
}

function status(name) {
  const dir = dirOf(name);
  if (!isInstalled(name)) return { state: 'not installed' };
  git(dir, ['fetch', '--quiet']);
  const dirty = git(dir, ['status', '--porcelain', '--untracked-files=no']).out ? true : false;
  const counts = git(dir, ['rev-list', '--left-right', '--count', '@{u}...HEAD']);
  let behind = 0, ahead = 0;
  if (counts.ok) [behind, ahead] = counts.out.split(/\s+/).map(Number);
  const parts = [];
  if (dirty) parts.push(yellow('modified'));
  if (behind) parts.push(yellow(`behind ${behind}`));
  if (ahead) parts.push(yellow(`ahead ${ahead}`));
  return { state: parts.length ? parts.join(', ') : green('up to date'), dirty, behind, ahead };
}

function update(name, reg) {
  if (!isInstalled(name)) return console.log(dim(`- ${name}: not installed (skip)`));
  const dir = dirOf(name);
  lockPush(dir);
  const branch = (reg.tools[name] || {}).branch || DEFAULT_BRANCH;
  if (git(dir, ['rev-parse', '--abbrev-ref', 'HEAD']).out !== branch) {
    // keep tools on their tracked branch (main by default)
    git(dir, ['fetch', '--quiet']);
    const co = git(dir, ['checkout', branch]);
    if (!co.ok) return console.log(red(`✗ ${name}: cannot switch to "${branch}": ${co.err.split('\n')[0]}`));
    console.log(dim(`${name}: switched to ${branch}`));
  }
  const before = git(dir, ['rev-parse', 'HEAD']).out;
  const r = git(dir, ['pull', '--ff-only']);
  if (!r.ok) return console.log(red(`✗ ${name}: ${r.err.split('\n').filter(Boolean).pop()}`) + dim('  (local changes or diverged; klam never pushes - discard local edits in ' + dir + ' or re-install)'));
  const after = git(dir, ['rev-parse', 'HEAD']).out;
  if (before === after) return console.log(`${green('✓')} ${name} ${dim('already up to date')}`);
  console.log(`${green('✓')} ${name} updated ${dim(before.slice(0, 7) + ' → ' + after.slice(0, 7))}`);
  if (!ensureSetup(name, reg)) console.log(yellow(`! ${name}: setup failed; it will be retried on the next run`));
}

function help() {
  console.log(`${bold('klambox')} - manage & run GitHub Klam's tools
(after: npm i -g klambox  you can type  klam  instead of  npx klambox)

  npx klambox --version | -v             print the klambox version
  npx klambox list                       list tools and their status
  npx klambox add <name> <user/repo|url> [--branch b] [--entry file | --run "cmd"] [--desc "text"]
  npx klambox remove <name>              unregister and delete local copy
  npx klambox install <name>             clone a tool
  npx klambox update                     update registry + every installed tool
  npx klambox <name> [args...]           run a tool (auto-installs on first use)
  npx klambox <name> --help              help of that tool (read from the tool's own repo; -h also works)
  npx klambox <name> update              git pull --ff-only one tool (read-only: klam never pushes)
  npx klambox <name> status | path | remove
  npx klambox run <name> [args...]       run (use when the tool name clashes with a command, or to pass --help to the tool itself)
  npx klambox registry [url|none|default]  show/set remote registry JSON (optional; default: klambox/klam on GitHub)

Data: ${HOME}   (override with KLAM_HOME)
How a tool runs: registry entry/run > <tool>/klam.json entry/run > Node (package.json bin/main, index.js) > Python (__main__.py, main.py, <name>.py) > run.sh
Dependencies are installed automatically: npm for package.json "dependencies", a private virtualenv for requirements.txt.`);
}

async function main() {
  const [a, b, ...rest] = process.argv.slice(2);
  if (a === '--version' || a === '-v' || a === '-V') return console.log(readJson(new URL('../package.json', import.meta.url), {}).version);
  // `-help` (single dash) is accepted silently as an alias; --help / -h are the documented forms.
  if (!a || a === '--help' || a === '-h' || a === '-help' || (a === 'help' && !b)) return help();
  let reg = loadReg();
  if (a === 'help') { // klam help <tool>
    if (reg.tools[b] === undefined) reg = await syncRemoteRegistry(true);
    return showHelp(b, reg);
  }

  // klam <tool> [subcommand|args...]
  if (!RESERVED.includes(a)) {
    if (reg.tools[a] === undefined) reg = await syncRemoteRegistry(true);
    need(reg, a);
    const sub = b;
    if (rest.length === 0 && ['-help', '--help', '-h'].includes(sub)) return showHelp(a, reg);
    if (sub === 'update') return update(a, reg);
    if (sub === 'status') return console.log(`${a}: ${status(a).state}`);
    if (sub === 'path') return console.log(dirOf(a));
    if (sub === 'install') return install(a, reg);
    if (sub === 'remove' || sub === 'rm') return remove(a, reg);
    return runTool(a, [b, ...rest].filter((x) => x !== undefined), reg);
  }

  switch (a) {
    case 'list': case 'ls': {
      reg = await syncRemoteRegistry(true);
      const names = Object.keys(reg.tools).sort();
      if (!names.length) return console.log('No tools yet. Add one: npx klambox add <name> <user/repo>');
      const w = Math.max(...names.map((n) => n.length));
      for (const n of names) {
        const t = reg.tools[n];
        console.log(`${bold(n.padEnd(w))}  ${status(n).state}  ${dim(t.desc || t.repo)}`);
      }
      return;
    }
    case 'add': {
      const args = [b, ...rest];
      const flags = {};
      const pos = [];
      for (let i = 0; i < args.length; i++) {
        if (args[i] === '--run') flags.run = args[++i];
        else if (args[i] === '--entry') flags.entry = args[++i];
        else if (args[i] === '--desc') flags.desc = args[++i];
        else if (args[i] === '--branch') flags.branch = args[++i];
        else pos.push(args[i]);
      }
      const [name, repo] = pos;
      if (!name || !repo) die('usage: npx klambox add <name> <user/repo|url> [--branch b] [--entry file | --run "cmd"] [--desc "text"]');
      if (RESERVED.includes(name)) die(`"${name}" is a reserved command name`);
      reg.local[name] = { repo, ...(flags.branch && { branch: flags.branch }), ...(flags.entry && { entry: flags.entry }), ...(flags.run && { run: flags.run }), ...(flags.desc && { desc: flags.desc }) };
      saveReg(reg);
      return console.log(green(`✓ added ${name}`) + dim(`  (npx klambox ${name} to install & run)`));
    }
    case 'remove': case 'rm': return remove(b, reg);
    case 'install': return install(b, reg);
    case 'update': case 'upgrade': {
      reg = await syncRemoteRegistry(false);
      for (const n of Object.keys(reg.tools).sort()) update(n, reg);
      return;
    }
    case 'status': {
      const names = b ? [b] : Object.keys(reg.tools).filter(isInstalled);
      for (const n of names) console.log(`${n}: ${status(n).state}`);
      return;
    }
    case 'path': return console.log(b ? dirOf(b) : HOME);
    case 'run': return runTool(b, rest, (reg = await syncRemoteRegistry(true)));
    case 'registry': {
      if (!b) return console.log(reg.remote === false ? '(remote registry disabled)' : (reg.remote || DEFAULT_REGISTRY) + (reg.remote ? '' : dim('  (default)')));
      reg.remote = b === 'none' ? false : b === 'default' ? undefined : b;
      saveReg(reg);
      return console.log(green('✓ remote registry: ' + (reg.remote === false ? 'disabled' : reg.remote || 'default')));
    }
  }
}

function remove(name, reg) {
  need(reg, name);
  if (isInstalled(name)) {
    const s = status(name);
    if (s.dirty) die(`${name} has local modifications in ${dirOf(name)}. Discard or commit them elsewhere first.`);
    fs.rmSync(dirOf(name), { recursive: true, force: true });
  }
  fs.rmSync(path.join(ENVS, name), { recursive: true, force: true });
  fs.rmSync(stampFile(name), { force: true });
  const wasLocal = name in reg.local;
  delete reg.local[name];
  saveReg(reg);
  console.log(green(`✓ removed ${name}`) + (wasLocal ? '' : dim('  (local copy only; it is still listed in the remote registry)')));
}

main().catch((e) => die(e.message));
