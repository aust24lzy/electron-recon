#!/usr/bin/env node
// recon.cjs - Electron application three-layer analysis orchestrator
//
// Layer 1 container: npx asar extract
// Layer 2 bytecode : jscd (reuses the jscd-decompiler skill)
// Layer 3 native   : inventory only; decompile delegated to the model via mcp__rea__*
//
// Design rule: probe first, then run. Most Electron apps have no .jsc at all,
// so blindly running all three layers wastes time.

'use strict';
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const JSCD_SKILL = process.env.JSCD_SKILL_DIR || 'C:\\Users\\LiuZY\\.dsh\\skills\\jscd-decompiler';

const HELP = [
  'electron-recon - Electron application three-layer analysis pipeline',
  '',
  'Usage:',
    '  node recon.cjs <AppDir|app.asar> -o <outDir> [options]',
  '',
  'Options:',
    '  --probe-only   probe structure only, run no layer',
    '  --skip-native  skip the native-module inventory (layer 3)',
    '  -o <dir>       output directory (required)',
  '',
  'Output:',
    '  <outDir>/manifest.json   machine-readable summary',
    '  <outDir>/report.md       human-readable summary',
    '  <outDir>/unpacked/       layer 1 unpacked tree',
    '  <outDir>/js/             layer 2 restored JS',
    '  <outDir>/native/         layer 3 native inventory'
].join('\n');

const argv = process.argv.slice(2);
const opts = { probeOnly: false, skipNative: false, target: '', output: '' };
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (a === '--probe-only') { opts.probeOnly = true; continue; }
  if (a === '--skip-native') { opts.skipNative = true; continue; }
  if (a === '-o') { opts.output = argv[++i]; continue; }
  if (a === '--help' || a === '-h') { console.log(HELP); process.exit(0); }
  if (!opts.target) { opts.target = a; continue; }
  if (!opts.output) { opts.output = a; }
}

if (!opts.target || !opts.output) { console.log(HELP); process.exit(1); }

const log = (m) => process.stdout.write(m + '\n');
const err = (m) => process.stderr.write('[!] ' + m + '\n');

// ---------- helpers ----------
function run(cmd, args, cwd, timeoutMs) {
  // Windows: npm shims are .cmd, and spawnSync without a shell cannot exec them.
  // Quote every argument so paths with spaces survive the cmd.exe round-trip.
  const isWin = process.platform === 'win32';
  const exe = isWin && /^npx$/i.test(cmd) ? 'npx.cmd' : cmd;
  const argv = isWin ? args.map((a) => '"' + String(a).replace(/"/g, '\\"') + '"') : args;
  const r = spawnSync(exe, argv, {
    cwd: cwd || process.cwd(),
    encoding: 'utf8',
    maxBuffer: 256 * 1024 * 1024,
    timeout: timeoutMs || 600000,
    shell: isWin,
    windowsVerbatimArguments: false
  });
  return { ok: r.status === 0, code: r.status, out: (r.stdout || '') + (r.stderr || '') };
}

function countFiles(dir, re) {
  if (!fs.existsSync(dir)) return 0;
  let n = 0;
  const walk = (d) => {
    let es;
    try { es = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of es) {
      const q = path.join(d, e.name);
      if (e.isDirectory()) walk(q);
      else if (!re || re.test(e.name)) n++;
    }
  };
  walk(dir);
  return n;
}

function listFiles(dir, re, limit) {
  const out = [];
  const cap = limit || 5000;
  if (!fs.existsSync(dir)) return out;
  const walk = (d) => {
    if (out.length >= cap) return;
    let es;
    try { es = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of es) {
      if (out.length >= cap) return;
      const q = path.join(d, e.name);
      if (e.isDirectory()) walk(q);
      else if (!re || re.test(e.name)) out.push(q);
    }
  };
  walk(dir);
  return out.sort();
}

// ---------- layer 1: container ----------
function resolveAsar(target) {
  const t = path.resolve(target);
  if (!fs.existsSync(t)) return null;
  const st = fs.statSync(t);
  if (st.isFile()) return /\.asar$/i.test(t) ? t : null;
  const cands = [
    path.join(t, 'resources', 'app.asar'),
    path.join(t, 'resources', 'app', 'app.asar'),
    path.join(t, 'app.asar'),
    path.join(t, 'Contents', 'Resources', 'app.asar')
  ];
  for (const c of cands) if (fs.existsSync(c)) return c;
  return null;
}

function layer1(asar, outDir) {
  const dest = path.join(outDir, 'unpacked');
  log('[1/3] asar extract -> ' + dest);
  fs.mkdirSync(dest, { recursive: true });
  const r = run('npx', ['--yes', '@electron/asar', 'extract', asar, dest], outDir);
  if (!r.ok) {
    err('asar extract failed (exit ' + r.code + ')');
    err(r.out.split('\n').slice(0, 6).join('\n'));
    return false;
  }
  log('      ok, ' + countFiles(dest) + ' files');
  return true;
}

// ---------- layer 2: V8 bytecode ----------
function layer2(unpacked, outDir) {
  const jscs = listFiles(unpacked, /\.jsc$/i);
  log('[2/3] jscd decompile (' + jscs.length + ' .jsc found)');
  if (!jscs.length) { log('      no .jsc, skipping'); return { ran: false, ok: 0, fail: 0, skipped: 0 }; }

  const manage = path.join(JSCD_SKILL, 'scripts', 'manage.cjs');
  if (!fs.existsSync(manage)) {
    err('jscd-decompiler skill not found at ' + JSCD_SKILL);
    err('set JSCD_SKILL_DIR, or install it under $DSH_HOME/skills/');
    return { ran: false, ok: 0, fail: jscs.length, skipped: 0 };
  }

  const jsDir = path.join(outDir, 'js');
  fs.mkdirSync(jsDir, { recursive: true });
  let ok = 0, fail = 0, skipped = 0;
  const failed = [];

  for (const f of jscs) {
    const sub = path.dirname(path.relative(unpacked, f));
    const outJs = path.join(jsDir, sub, path.parse(f).name + '.js');
    fs.mkdirSync(path.dirname(outJs), { recursive: true });
    const r = run('node', [manage, 'decompile', f, '-o', outJs], JSCD_SKILL);
    if (r.ok && fs.existsSync(outJs)) ok++;
    else if (/supported|内存安全门|不支持/.test(r.out)) skipped++;
    else { fail++; failed.push({ file: path.relative(unpacked, f), reason: r.out.split('\n').slice(0, 3).join(' | ') }); }
  }
  log('      ok=' + ok + ' fail=' + fail + ' skipped(unsupported)=' + skipped);
  if (failed.length) fs.writeFileSync(path.join(jsDir, '_failed.json'), JSON.stringify(failed, null, 2));
  return { ran: true, ok, fail, skipped };
}

// ---------- layer 3: native inventory ----------
function layer3(unpacked, outDir) {
  const nats = listFiles(unpacked, /\.(node|dll|exe|so|dylib)$/i);
  log('[3/3] native inventory (' + nats.length + ' found)');
  const dir = path.join(outDir, 'native');
  fs.mkdirSync(dir, { recursive: true });
  const idx = nats.map((q) => ({
    path: q,
    rel: path.relative(unpacked, q),
    size: fs.statSync(q).size,
    rea: [
      'open_binary(path="' + q + '")',
      'list_procedures()',
      'procedure_pseudo_code({procedure: "<name>"})'
    ]
  }));
  fs.writeFileSync(path.join(dir, 'native-index.json'), JSON.stringify(idx, null, 2));
  log('      wrote native-index.json (' + idx.length + ' entries)');
  log('      decompile these via mcp__rea__* in the DSH session');
  return idx.length;
}

// ---------- report ----------
function writeReport(outDir, m) {
  const L = [];
  L.push('# electron-recon 报告');
  L.push('');
  L.push('- 目标: `' + m.target + '`');
  L.push('- asar: `' + (m.asar || '(未找到)') + '`');
  L.push('- 时间: ' + m.at);
  L.push('');
  L.push('## 层1 容器');
  L.push('');
  L.push('- 拆出 ' + m.layers.container.files + ' 个文件 -> `unpacked/`');
  L.push('');
  L.push('## 层2 V8 字节码');
  L.push('');
  if (!m.layers.bytecode.ran) {
    L.push('- **未发现 .jsc** —— 业务逻辑是明文 JS，直接读 `unpacked/` 即可');
  } else {
    L.push('- 成功 ' + m.layers.bytecode.ok + ' / 不支持 ' + m.layers.bytecode.skipped + ' / 失败 ' + m.layers.bytecode.fail);
    L.push('- 还原结果在 `js/`（目录层级与 unpacked 一致）');
  }
  L.push('');
  L.push('## 层3 原生模块');
  L.push('');
  if (!m.layers.native.count) {
    L.push('- 未发现 .node/.dll/.exe');
  } else {
    L.push('- ' + m.layers.native.count + ' 个原生模块，清单在 `native/native-index.json`');
    L.push('- 逐个用 `mcp__rea__open_binary` + `mcp__rea__procedure_pseudo_code` 反编译');
  }
  L.push('');
  L.push('## 下一步');
  L.push('');
  L.push('```powershell');
  L.push('# 找 License / VIP / 激活校验');
  L.push("Select-String -Path '<outDir>\\js\\*.js','<outDir>\\unpacked\\*.js' -Pattern 'license|vip|expire|激活|会员'");
  L.push('');
  L.push('# 找密钥与接口');
  L.push("Select-String -Path '<outDir>\\js\\*.js' -Pattern 'api[_-]?key|secret|token|https?://'");
  L.push('');
  L.push('# 明文备份优先于解码');
  L.push("Get-ChildItem '<outDir>\\unpacked' -Recurse -Include '*.bak-*'");
  L.push('```');
  L.push('');
  fs.writeFileSync(path.join(outDir, 'report.md'), L.join('\n'));
}

// ---------- main ----------
const asar = resolveAsar(opts.target);
if (!asar) {
  err('找不到 app.asar。目标可以是: App 安装目录 / app.asar 文件本身');
  err('给定: ' + opts.target);
  process.exit(2);
}

const OUT = path.resolve(opts.output);
fs.mkdirSync(OUT, { recursive: true });
log('目标 asar: ' + asar);
log('输出目录 : ' + OUT);
log('');

if (opts.probeOnly) {
  log('[probe] 只探测。建议先看 unpacked 里有没有 .jsc / .node 再决定跑哪些层。');
  log('[probe] 手动拆盒: npx --yes @electron/asar extract "' + asar + '" "' + path.join(OUT, 'unpacked') + '"');
  process.exit(0);
}

const manifest = {
  tool: 'electron-recon',
  version: 1,
  at: new Date().toISOString(),
  target: path.resolve(opts.target),
  asar,
  layers: {}
};

if (!layer1(asar, OUT)) process.exit(3);
const UNP = path.join(OUT, 'unpacked');
manifest.layers.container = { files: countFiles(UNP), ok: true };

// 明文备份优先 —— 这是踩过 1500 秒坑换来的顺序
const baks = listFiles(UNP, /\.bak-/i);
manifest.plaintextBackups = baks.map((b) => path.relative(UNP, b));
if (baks.length) log('[i] 发现 ' + baks.length + ' 个明文 .bak-* 备份，优先用它们');

manifest.layers.bytecode = layer2(UNP, OUT);
manifest.layers.native = opts.skipNative
  ? { count: countFiles(UNP, /\.(node|dll|exe|so|dylib)$/i), skipped: true }
  : { count: layer3(UNP, OUT) };

fs.writeFileSync(path.join(OUT, 'manifest.json'), JSON.stringify(manifest, null, 2));
writeReport(OUT, manifest);
log('');
log('完成。先读 report.md');