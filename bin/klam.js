#!/usr/bin/env node
// klam - manage and run personal GitHub tools. Zero dependencies.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const HOME = process.env.KLAM_HOME || path.join(os.homedir(), '.klam');
const TOOLS = path.join(HOME, 'tools');
const REGISTRY = path.join(HOME, 'registry.json'); // { remote?: url, tools: { name: {repo, run?, desc?} } }

const RESERVED = ['list', 'ls', 'add', 'remove', 'rm', 'install', 'update', 'upgrade', 'sync', 'status',
  'path', 'run', 'registry', 'help'];

const c = (n, s) => (process.stdout.isTTY ? `\x1b[${n}m${s}\x1b[0m` : s);
const green = (s) => c(32, s), yellow = (s) => c(33, s), red = (s) => c(31, s), dim = (s) => c(2, s), bold = (s) => c(1, s);
const die = (m) => { console.error(red('✗ ') + m); process.exit(1); };

function loadReg() {
  try { return JSON.parse(fs.readFileSync(REGISTRY, 'utf8')); } catch { return { tools: {} }; }
}
function saveReg(r) {
  fs.mkdirSync(HOME, { recursive: true });
  fs.writeFileSync(REGISTRY, JSON.stringify(r, null, 2) + '\n');
}
const dirOf = (name) => path.join(TOOLS, name);
const isInstalled = (name) => fs.existsSync(path.join(dirOf(name), '.git'));

function git(dir, args, { inherit = false } = {}) {
  const r = spawnSync('git', args, { cwd: dir, encoding: 'utf8', stdio: inherit ? 'inherit' : 'pipe' });
  if (r.error) die('git not found. Install git first.');
  return { ok: r.status === 0, out: (r.stdout || '').trim(), err: (r.stderr || '').trim() };
}

function normRepo(s) {
  if (/^[\w.-]+\/[\w.-]+$/.test(s)) return `https://github.com/${s}.git`; // user/repo shorthand
  return s;
}

async function syncRemoteRegistry(quiet) {
  const reg = loadReg();
  if (!reg.remote) return reg;
  try {
    const res = await fetch(reg.remote);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const remote = await res.json();
    // remote entries fill in; local entries with same name win
    reg.tools = { ...(remote.tools || remote), ...reg.tools };
    saveReg(reg);
    if (!quiet) console.log(dim(`registry synced from ${reg.remote}`));
  } catch (e) {
    console.error(yellow(`! could not fetch remote registry: ${e.message}`));
  }
  return reg;
}

function need(reg, name) {
  if (!name) die('missing tool name');
  if (!reg.tools[name]) die(`unknown tool "${name}". Try: klam list   |   klam add ${name} <user/repo>`);
  return reg.tools[name];
}

function install(name, reg) {
  const t = need(reg, name);
  if (isInstalled(name)) return console.log(dim(`${name} already installed`));
  fs.mkdirSync(TOOLS, { recursive: true });
  console.log(`Installing ${bold(name)} from ${t.repo} ...`);
  const r = git(TOOLS, ['clone', normRepo(t.repo), name], { inherit: true });
  if (!r.ok) die(`clone failed for ${name}`);
  postInstall(name);
  console.log(green(`✓ ${name} installed`));
}

function postInstall(name) {
  const dir = dirOf(name);
  const cfg = toolCfg(dir);
  const cmd = cfg.setup || (fs.existsSync(path.join(dir, 'package.json')) && fs.existsSync(path.join(dir, 'package-lock.json')) ? 'npm install' : null)
    || (fs.existsSync(path.join(dir, 'requirements.txt')) ? 'python3 -m pip install -r requirements.txt' : null);
  if (cmd) {
    console.log(dim(`setup: ${cmd}`));
    spawnSync(cmd, { cwd: dir, shell: true, stdio: 'inherit' });
  }
}

function toolCfg(dir) {
  try { return JSON.parse(fs.readFileSync(path.join(dir, 'klam.json'), 'utf8')); } catch { return {}; }
}

function resolveRun(name, reg) {
  const dir = dirOf(name);
  const cfg = toolCfg(dir);
  const run = reg.tools[name].run || cfg.run;
  if (run) return run.replaceAll('{dir}', dir);
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8'));
    const bin = typeof pkg.bin === 'string' ? pkg.bin : Object.values(pkg.bin || {})[0];
    if (bin) return `node "${path.join(dir, bin)}"`;
    if (pkg.main) return `node "${path.join(dir, pkg.main)}"`;
  } catch {}
  for (const f of ['main.py', '__main__.py', `${name}.py`]) if (fs.existsSync(path.join(dir, f))) return `python3 "${path.join(dir, f)}"`;
  for (const f of ['run.sh', `${name}.sh`]) if (fs.existsSync(path.join(dir, f))) return `bash "${path.join(dir, f)}"`;
  die(`don't know how to run ${name}. Add a "run" to its klam.json, or: klam add ${name} <repo> --run "<cmd>"`);
}

function runTool(name, args, reg) {
  need(reg, name);
  if (!isInstalled(name)) install(name, reg);
  const cmd = resolveRun(name, reg);
  const quoted = args.map((a) => `'${a.replaceAll("'", "'\\''")}'`).join(' ');
  const r = spawnSync(`${cmd} ${quoted}`, { shell: true, stdio: 'inherit', cwd: process.cwd(), env: { ...process.env, KLAM_TOOL_DIR: dirOf(name) } });
  process.exit(r.status ?? 1);
}

function status(name) {
  const dir = dirOf(name);
  if (!isInstalled(name)) return { state: 'not installed' };
  git(dir, ['fetch', '--quiet']);
  const dirty = git(dir, ['status', '--porcelain']).out ? true : false;
  const counts = git(dir, ['rev-list', '--left-right', '--count', '@{u}...HEAD']);
  let behind = 0, ahead = 0;
  if (counts.ok) [behind, ahead] = counts.out.split(/\s+/).map(Number);
  const parts = [];
  if (dirty) parts.push(yellow('modified'));
  if (behind) parts.push(yellow(`behind ${behind}`));
  if (ahead) parts.push(yellow(`ahead ${ahead}`));
  return { state: parts.length ? parts.join(', ') : green('up to date'), dirty, behind, ahead };
}

function update(name) {
  if (!isInstalled(name)) return console.log(dim(`- ${name}: not installed (skip)`));
  const dir = dirOf(name);
  const before = git(dir, ['rev-parse', 'HEAD']).out;
  const r = git(dir, ['pull', '--ff-only']);
  if (!r.ok) return console.log(red(`✗ ${name}: ${r.err.split('\n')[0]}`) + dim('  (local changes? try: klam sync ' + name + ')'));
  const after = git(dir, ['rev-parse', 'HEAD']).out;
  if (before === after) return console.log(`${green('✓')} ${name} ${dim('already up to date')}`);
  console.log(`${green('✓')} ${name} updated ${dim(before.slice(0, 7) + ' → ' + after.slice(0, 7))}`);
  postInstall(name);
}

function sync(name) {
  if (!isInstalled(name)) die(`${name} is not installed`);
  const dir = dirOf(name);
  console.log(bold(`sync ${name}`));
  if (git(dir, ['status', '--porcelain']).out) {
    git(dir, ['add', '-A']);
    git(dir, ['commit', '-m', `klam sync ${new Date().toISOString()}`]);
  }
  if (!git(dir, ['pull', '--rebase'], { inherit: true }).ok) die('pull --rebase failed; resolve in ' + dir);
  if (!git(dir, ['push'], { inherit: true }).ok) die('push failed');
  console.log(green('✓ synced'));
}

function help() {
  console.log(`${bold('klam')} - manage & run your GitHub tools

  klam list                       list tools and their status
  klam add <name> <user/repo|url> [--run "cmd"] [--desc "text"]
  klam remove <name>              unregister and delete local copy
  klam install <name>             clone a tool
  klam update                     update registry + every installed tool
  klam <name> [args...]           run a tool (auto-installs on first use)
  klam <name> update              git pull one tool
  klam <name> sync                commit local changes, pull --rebase, push
  klam <name> status | path | remove
  klam run <name> [args...]       run (use when the tool name clashes with a command)
  klam registry [url]             show/set remote registry JSON (shared across machines)

Data: ${HOME}   (override with KLAM_HOME)
Tool run command: registry "run" > <tool>/klam.json "run" > package.json bin > main.py > run.sh`);
}

async function main() {
  const [a, b, ...rest] = process.argv.slice(2);
  if (!a || a === 'help' || a === '--help' || a === '-h') return help();
  let reg = loadReg();

  // klam <tool> <subcommand> form
  if (!RESERVED.includes(a) && reg.tools[a] === undefined && !b) {
    reg = await syncRemoteRegistry(true);
  }
  if (!RESERVED.includes(a)) {
    if (reg.tools[a] === undefined) reg = await syncRemoteRegistry(true);
    need(reg, a);
    const sub = b;
    if (sub === 'update') return update(a);
    if (sub === 'sync') return sync(a);
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
      if (!names.length) return console.log('No tools yet. Add one: klam add <name> <user/repo>');
      const w = Math.max(...names.map((n) => n.length));
      for (const n of names) {
        const t = reg.tools[n];
        console.log(`${bold(n.padEnd(w))}  ${status(n).state.padEnd(isInstalled(n) ? 0 : 0)}  ${dim(t.desc || t.repo)}`);
      }
      return;
    }
    case 'add': {
      const args = [b, ...rest];
      const flags = {};
      const pos = [];
      for (let i = 0; i < args.length; i++) {
        if (args[i] === '--run') flags.run = args[++i];
        else if (args[i] === '--desc') flags.desc = args[++i];
        else pos.push(args[i]);
      }
      const [name, repo] = pos;
      if (!name || !repo) die('usage: klam add <name> <user/repo|url> [--run "cmd"] [--desc "text"]');
      if (RESERVED.includes(name)) die(`"${name}" is a reserved command name`);
      reg.tools[name] = { repo, ...(flags.run && { run: flags.run }), ...(flags.desc && { desc: flags.desc }) };
      saveReg(reg);
      return console.log(green(`✓ added ${name}`) + dim(`  (klam ${name} to install & run)`));
    }
    case 'remove': case 'rm': return remove(b, reg);
    case 'install': return install(b, reg);
    case 'update': case 'upgrade': {
      reg = await syncRemoteRegistry(false);
      for (const n of Object.keys(reg.tools).sort()) update(n);
      return;
    }
    case 'sync': return sync(b);
    case 'status': {
      const names = b ? [b] : Object.keys(reg.tools).filter(isInstalled);
      for (const n of names) console.log(`${n}: ${status(n).state}`);
      return;
    }
    case 'path': return console.log(b ? dirOf(b) : HOME);
    case 'run': return runTool(b, rest, (reg = await syncRemoteRegistry(true)));
    case 'registry': {
      if (!b) return console.log(reg.remote || '(no remote registry set)');
      reg.remote = b === 'none' ? undefined : b;
      saveReg(reg);
      return console.log(green('✓ remote registry ' + (reg.remote ? 'set' : 'cleared')));
    }
  }
}

function remove(name, reg) {
  need(reg, name);
  if (isInstalled(name)) {
    const s = status(name);
    if (s.dirty || s.ahead) die(`${name} has unpushed work (${s.state}). Run: klam ${name} sync   first.`);
    fs.rmSync(dirOf(name), { recursive: true, force: true });
  }
  delete reg.tools[name];
  saveReg(reg);
  console.log(green(`✓ removed ${name}`));
}

main().catch((e) => die(e.message));
