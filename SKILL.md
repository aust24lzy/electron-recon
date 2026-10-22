---
name: electron-recon
description: >-
  End-to-end Electron application analysis pipeline. Chains three tools that each
  cover a different layer: asar (container unpack), jscd (V8 bytecode decompile),
  REA/Ghidra (native PE/ELF/Mach-O decompile). Auto-detects which layers the target
  actually uses, so plain-JS apps skip the bytecode stage entirely. Produces a
  unified evidence directory: unpacked tree, decompiled JS, native pseudo-code,
  and a manifest mapping every artifact to its source layer.
whenToUse: >-
  分析 Electron 应用、提取业务逻辑、审计 bytenode 保护模块、读取原生 .node/.dll
  校验逻辑时使用。也用于判断目标是否使用 bytenode 保护、批量还原 .jsc、定位
  License/VIP 校验点。
---

# electron-recon — Electron 应用三层分析链路

把 Electron 应用拆成三个正交的层，每层用最合适的工具：

| 层 | 工具 | 覆盖 |
|---|---|---|
| 容器 | `@electron/asar` | app.asar 拆盒（`npx asar extract`） |
| 字节码 | `jscd` | `.jsc` → 可读 JS（V8 code cache） |
| 原生 | REA + Ghidra | `.node` / `.dll` / `.exe` → 伪代码 |

**绝大多数 Electron 应用没有 `.jsc`**（实测 bilibili app.asar：7809 文件、0 个
`.jsc`、6 个 `.node`）。所以链路第一步永远是探测，不是无脑全跑。

## 用法

```powershell
# 全自动：探测 → 按需跑三层 → 汇总
node scripts\recon.cjs <App目录或app.asar> -o <输出目录>

# 只探测，不跑（先看目标结构再决定）
node scripts\recon.cjs <目标> -o <输出目录> --probe-only

# 跳过原生层（没有 .node 或不想开 Ghidra）
node scripts\recon.cjs <目标> -o <输出目录> --skip-native
```

## 输出结构

```
<输出目录>/
├── manifest.json          # 每层产出 + 文件计数 + 工具版本
├── unpacked/              # 层1：asar 拆盒完整树
├── js/                    # 层2：.jsc 还原的 JS（与原层级一致）
│   └── <相对路径>.js
├── native/                # 层3：原生模块分析清单
│   └── native-index.json  # .node/.dll 路径 + REA 命令建议
└── report.md              # 人读摘要：先看哪里
```

## 决策逻辑（自动）

```
探测 unpacked/
  ├── 有 .bak-* 明文备份？ → 直接用备份，跳过层2，报告标注
  ├── 有 .jsc？            → 跑层2（jscd），逐个 info 门禁
  └── 无 .jsc              → 跳过层2，JS 本就是明文
有 .node/.dll/.exe？        → 跑层3清单，给出 REA 命令
```

## 依赖

| 工具 | 必需 | 说明 |
|---|---|---|
| Node.js | ✅ | 跑本脚本 |
| `@electron/asar` | ✅ | `npx asar extract`，自动下载 |
| `jscd-decompiler` skill | 按需 | 有 `.jsc` 才需要；路径写死见下 |
| REA + Ghidra | 按需 | 有原生模块才需要；由模型在会话里调 |

## 层3 为什么要交给模型

REA 的 MCP 工具在 Windows 上有两个硬限制：

1. `capture_process_scenario` 不可用（PTY 子进程清理未验证）
2. `inspect_artifact` 完整响应可能超 stdio 预算

所以层3 由本 skill **只做清单**（列出所有原生模块 + 建议的 REA 调用序列），
实际反编译由模型在 DSH 会话里调 `mcp__rea__*` 完成。这是设计，不是缺陷。

## 安全边界

- 只分析你有权检查的制品
- 全程只读目标，除输出目录外不写任何地方
- 层2 有 `supported: no` 门禁，不会触发穷举暴解（14GB 内存）
