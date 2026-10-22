# electron-recon

Electron 应用三层分析链路 —— asar 容器 / V8 字节码 / 原生二进制，各用各的工具。

配套 DSH skill：`electron-recon`（`$DSH_HOME/skills/electron-recon/`）。

## 为什么需要探测

**大多数 Electron 应用没有 `.jsc`。** 实测 bilibili 的 `app.asar`：7809 个文件、
0 个 `.jsc`、15 个原生模块。业务逻辑就是明文 JS。

所以链路第一步永远是**探测**，不是无脑跑三层。

## 三层分工

| 层 | 工具 | 覆盖 | 谁来做 |
|---|---|---|---|
| 容器 | `@electron/asar` | `app.asar` 拆盒 | 本脚本 |
| 字节码 | `jscd` | `.jsc` → 可读 JS | 本脚本调 jscd-decompiler skill |
| 原生 | REA + Ghidra | `.node`/`.dll`/`.exe` → 伪代码 | 模型调 `mcp__rea__*` |

## 用法

```powershell
node scripts\recon.cjs <App目录|app.asar> -o <输出目录> [选项]

# 只探测，不跑
node scripts\recon.cjs <目标> -o <输出目录> --probe-only

# 跳过原生层
node scripts\recon.cjs <目标> -o <输出目录> --skip-native
```

## 输出

```
<输出目录>/
├── manifest.json      每层产出 + 文件计数
├── report.md          人读摘要
├── unpacked/          层1 拆盒完整树
├── js/                层2 还原的 JS（层级与原树一致）
└── native/
    └── native-index.json   层3 原生模块清单 + 建议的 REA 调用序列
```

## 层3 为什么交给模型

REA 的 MCP 工具在 Windows 上有两个硬限制：

1. `capture_process_scenario` 不可用（PTY 子进程清理未验证）
2. `inspect_artifact` 完整响应可能超 stdio 预算

所以本脚本对层3 **只产清单**（每个模块附 `open_binary` / `list_procedures` /
`procedure_pseudo_code` 的调用序列），实际反编译由模型在 DSH 会话里调
`mcp__rea__*` 完成。这是设计，不是缺陷。

## 依赖

| 工具 | 必需 | 说明 |
|---|---|---|
| Node.js | ✅ | 跑本脚本 |
| `@electron/asar` | ✅ | `npx asar extract`，自动下载 |
| `jscd-decompiler` skill | 按需 | 有 `.jsc` 才需要 |
| REA + Ghidra | 按需 | 有原生模块才需要 |

jscd skill 路径默认 `C:\Users\LiuZY\.dsh\skills\jscd-decompiler`，
可用环境变量 `JSCD_SKILL_DIR` 覆盖。

## 实测

| 目标 | 结果 |
|---|---|
| bilibili（无 bytenode） | 7809 文件 / 0 `.jsc` → 自动跳过层2 / 15 原生模块清单 |
| 闲AI 3.5.7（40 个 `.jsc`） | 40/40 解出 / 2,165,051 B / 9,690 中文字符 |

## 安全边界

- 只分析你有权检查的制品
- 全程只读目标，除输出目录外不写任何地方
- 层2 依赖 jscd 自带的 `supported` 门禁，不会触发穷举暴解

## 许可

MIT
