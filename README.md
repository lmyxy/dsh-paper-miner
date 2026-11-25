# paper-miner

> 用极小的 token 成本精读 PDF 论文，并从中挖出可延伸的研究方向。
> A DeepSeek Harness bundle that reads PDF papers for a fraction of their prompt cost.

**中文** · [English](README.en.md)

面向计算机领域科研：读论文、写综述笔记、判断值不值得读、找下一步做什么。

---

## 为什么需要它

一篇 10 页 CS 论文直接塞进上下文大约 **5–12k token**，带附录和参考文献能到 **20–35k**。读四篇就挤满一个窗口，而且模型大部分算力花在"重新读一遍原文"上，真正的推理反而被稀释。

paper-miner 把这件苦力活搬到宿主端（本地、零模型调用）：PDF 解析、章节切分、句子索引、覆盖缺口检测全部在本地完成，模型只拿到一份**已经筛好的摘要**，需要细节时再按句下钻。

实测（同一台机器，LaTeX 构造的三篇论文 + 一篇真实期刊论文）：

| 论文 | 全文 | `paper_brief` | 节省 |
|---|---:|---:|---:|
| 8 页单栏，3 表 2 图 | 6,179 tok | 1,279 tok | **4.8×** |
| 4 页双栏 | 3,530 tok | 1,000 tok | 3.5× |
| 4 页重公式 / 定理证明 | 2,822 tok | 745 tok | 3.8× |
| 真实 AASTeX 论文，19 页 | 13,378 tok | 779 tok | **17×** |

摘要末尾会自己报账：`COST digest≈779 tok vs full text≈13378 tok`。

## 工作方式

```
PDF
 └─ 本地解析：对象 / 字体 / 内容流 → 带角标的文本行
     └─ 章节切分：标题识别 + role 推断 + 层级继承
         └─ 索引：句子切分 + BM25-lite
             └─ 模型按需调用：scan → brief → find / slice
```

解析、切分、索引、缺口检测全在本地完成，不产生模型调用；模型只消费结果。

关键设计取舍：

- **只摘选，不改写。** 摘要里的每一句都是论文原句，插件不做转述，因此不会引入幻觉；代价是它可能漏掉只出现在图里的贡献。
- **结构化优先。** 先给章节图（id / role / 字数 / 页码），模型据此决定读哪一节，而不是一次读完。
- **role 继承。** 无法命名的子章节（如 Method 下的 "Clustered routing"）继承父章节的 role，所以方法/实验正文不会被漏掉。
- **未覆盖角度是"线索"不是"结论"。** 规则推导，明确标注 heuristic，需要模型用 `paper_find` 核实后才可信。

## 安装

插件以 bundle 形式挂进 DSH profile。**用插件管理器安装**，不要手改 profile 的 `package.json`：

```bash
# 在 DSH 会话中让 agent 执行，或使用 GUI：插件 → 添加插件 → 选择本目录
plugin_manager  action=install_bundle  target=<本目录绝对路径>
```

安装后 **插件** 页面会出现 “论文精读 / Paper miner” 一行；用 `list_plugins` 检查时 `fiberPhase` 应为 `active`。

> ⚠️ 以本地目录（`file:`）安装时，插件源码就是工作区中的这个目录。移动或删除该目录会让插件失效；需要固化请先打包成 npm 包再安装。

**环境要求**：DSH `>=0.2.2-rc.1 <0.2.3-0`；Node 22.19+ 或 24+（随 DSH 提供）。**无第三方运行时依赖** —— PDF 解析器是本仓库自带的，不依赖 poppler、pdf.js 或 Python。

## 工具

| 工具 | 用途 | 开销 |
|---|---|---|
| `paper_scan` | 标题、章节 id/role/字数、页数、图表与参考文献计数，判断是否值得读 | 200–400 tok |
| `paper_brief` | 预算内摘要：Abstract、作者自称贡献、核心机制、关键数字、声明局限、作者的 future work、假设、图表 caption、未覆盖角度 | 0.7–1.5k tok |
| `paper_find` | 句子级检索（BM25-lite），返回章节 + 页码，可限定 section/role | 150–500 tok |
| `paper_slice` | 单个章节的定长字符窗口，按 `start`/`chars` 分页 | 按需 |
| `paper_cache` | 列出 / 清理本地解析缓存 | ~50 tok |

`paper_brief` 的 `max_tokens` 可调（默认 2200）：triage 用 800，深读用 4000–5000。

### 用法

自然语言即可触发（技能 `paper-mining` 会接管流程）：

> 帮我读一下 `papers/moe-routing.pdf`，总结一下，再看看有什么可以接着做的。

也可以直接点名工具，最省 token 的两步：

```
paper_brief(path="papers/moe-routing.pdf", max_tokens=1500)
paper_find(path="papers/moe-routing.pdf", query="inference latency", role="limitations")
```

### 配套技能 `paper-mining`

随插件注册，只在需要时载入（因此不占常驻上下文）。它规定：每篇只取一次 brief、下钻必须有具体问题、输出必须区分「作者声称」与「证据支持」，并给出方向模板（起点 / 缺口 / 做法 / 最小验证实验 / 风险 / 难度）。

## 输出长什么样

```
PAPER Efficient Long-Context Attention via Block-Sparse Kernels
MAP 4p · 13.6k chars · full text ≈3527 tok
SECTIONS s-abs:Abstract s1:Intro s2:Background s5:Background s6:Method ...
COUNT tables=1 figures=2 refs≈15 floats=3

ABSTRACT
Attention over long sequences is bounded by a quadratic term that is wasteful in practice: ...

CLAIMED CONTRIBUTIONS
- This paper describes BKATT, a block-sparse attention kernel that fixes the block granularity at 64 tokens ...

HEADLINE EVIDENCE
- Perplexity at 32K without continued training degrades by 0.9, and the degradation is concentrated on ...

STATED LIMITS
- The results support the claim that structural sparsity is a competitive way to extend context, but the evidence is limited to language modeling at a single scale.

UNCOVERED ANGLES (heuristic, verify against the text)
1. no dispersion reported: experiments mention no variance, seeds or error bars ...
2. no artifact release detected: reproduction requires reimplementation from the paper text

COST digest≈1056 tok vs full text≈3527 tok
```

## 配置

在 profile 的 `cordis.patch.yml` 中覆盖 `paper-miner` 行的 `config`：

```yaml
- id: paper-miner
  name: '@local/dsh-paper-miner'
  config:
    briefTokens: 1800      # paper_brief 默认预算
    maxPdfMiB: 200         # 接受的 PDF 上限
    cacheDir: 'D:/papers/.miner-cache'
    pdftotext: ''          # 仅在内置解析器提取到的文本过少时作为兜底
```

| 键 | 默认 | 说明 |
|---|---|---|
| `cacheDir` | `~/.dsh/paper-miner` | 解析结果缓存（gzip JSON，按内容哈希寻址） |
| `briefTokens` | `2200` | `paper_brief` 默认 token 预算 |
| `maxPdfMiB` | `128` | 最大接受体积 |
| `pdftotext` | 未设置 | `pdftotext` 可执行文件路径，仅作兜底 |

## 缓存

- 位置：`~/.dsh/paper-miner/<sha256 前 32 位>.json.gz`
- 键：文件内容的 SHA-256 —— 文件没变就不会重新解析；改了就自动失效
- 命中时约 20 ms，未命中约 50–100 ms（8 页论文）
- 清理：`paper_cache(action="purge")`，或用 `purge` + `key` 删单篇
- `lib/cache.js` 中的 `FORMAT_VERSION` 变更时旧缓存自动失效（改了解析逻辑务必 +1）

## 目录结构

```
dsh-paper-miner/
├── index.js              234  插件入口：5 个工具 + 技能注册 + 配置解析
├── cordis.patch.yml             bundle 的加载器补丁（插入插件行）
├── package.json                dsh.bundle.patch / exports / files
├── lib/
│   ├── pdf/
│   │   ├── read.js       733  对象扫描、流过滤器、对象流、页树
│   │   ├── font.js       287  ToUnicode CMap、编码表、字形名、字宽
│   │   └── text.js       639  内容流解释、TJ 间距、行列排版、双栏 gutter
│   ├── paper.js          231  编排：文件 → 行 → 章节 → 索引；缓存；兜底解析
│   ├── sections.js       281  标题/章节识别、role 分类与继承、行内摘要
│   ├── digest.js         275  预算摘要、缺口信号检测、按优先级取舍
│   ├── search.js          97  句子索引与 BM25-lite 检索
│   ├── text.js           163  连字符、句子切分、token 估算、去重
│   └── cache.js           87  gzip 缓存读写、列举、清理
├── skills/paper-mining/SKILL.md   工作流与输出契约（按需载入）
├── docs/DETAIL.md                 插件详情页文档（功能/配置/限制）
├── locale/{en,zh}.json            插件管理器显示用标题与描述
└── icon.svg                       图标
```

约 3,000 行，零运行时依赖。

## 开发与测试

仓库根目录（即本插件的上一级目录）带有开发脚本与测试夹具。**在根目录执行**：

```bash
# 语法检查（全部 .js）
for f in dsh-paper-miner/index.js dsh-paper-miner/lib/*.js dsh-paper-miner/lib/pdf/*.js; do node --check "$f"; done

# 只测解析：页数、行数、token 估算、逐行坐标
node tools/extract-test.mjs test/fixtures/figures.pdf 40 1

# 测章节切分
node tools/paper-test.mjs test/fixtures/twocol.pdf

# 测完整流水线（含缓存命中与检索）
node tools/brief-test.mjs test/fixtures/figures.pdf 2200 "latency overhead"

# 调试排版：原始 run 坐标 / 组装后的行
node tools/runs-dump.mjs test/fixtures/twocol.pdf 1 500 530
node tools/lines-dump.mjs test/fixtures/twocol.pdf 1
```

夹具位于 `test/fixtures/`：`figures.pdf`（8 页单栏，表格 + TikZ 图）、`twocol.pdf`（4 页双栏）、`mathheavy.pdf`（4 页重公式，含定理证明）。改动解析或切分逻辑后，至少跑一遍这三个，并确认：

1. 标题正确；图表 caption 没有被吞掉（`Table 1:` 应出现在 `FLOATS` 中）
2. 双栏论文的左右栏不交错
3. `COUNT tables=/figures=/refs≈` 与论文实际一致
4. `paper_brief` 的 token 数不显著上涨

修改插件代码后，在 DSH 中重新激活以加载新模块：

```
plugin_manager action=set_plugin target=include:paper-miner enabled=false
plugin_manager action=set_plugin target=include:paper-miner enabled=true
```

## 已知限制

- **仅文本层 PDF。** 扫描件、纯图片论文不支持 OCR，会明确报错而不是返回空摘要。加密 PDF 直接拒绝。
- **自研解析器。** 双栏判定、连字符还原、词间距都是启发式：公式会被打散混入正文，旋转表格与边注可能乱序，真实论文约 1.7% 字形（多为 fi/fl 连字）解不出来。
- **只摘选不改写。** 图里才有的贡献可能漏掉；摘要的长度受预算裁剪，超出部分会列在 `omitted` 中。
- **缺口信号是规则推导**，反映"覆盖"而非"新颖性/正确性"，用前必须核实。
- **AASTeX 等特殊模板**的行号、页眉可能混入正文。

## 状态

未声明开源许可（`private: true`，仅供本机 profile 使用）。如需对外分发，请先补 LICENSE、把 `name` 改成带作用域的真实包名，并检查 `files` 打包清单。
