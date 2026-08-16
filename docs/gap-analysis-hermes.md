# 差距分析:jcode-telegram-bridge vs hermes-agent Telegram Gateway

> 基准:hermes-agent main 分支(2026-08-16 拉取,commit 对应 `plugins/platforms/telegram/adapter.py` 10881 行)。
> 方法:3 个并行 worker 只读盘点 + 参数级对比,证据均为 `文件:行号`。原始报告见 `docs/_hermes-worker-{a,b,c}.md`。

## 总览

| 分类 | 数量 | 说明 |
|---|---|---|
| 已对齐(参数级一致) | 7 项 | 流式三参数、markdown 管线、转义、表格、fallback 结构、分块骨架 |
| 部分对齐(行为差异) | 6 项 | 429 退避、fallback 触发面、工具行、truncate 边界、link preview、菜单/指示 |
| 完全缺失 | 16 项 | 审批流、媒体输入/输出、DM Topics、并发命令、webhook、draft/Rich 等 |
| 架构差异 | 2 项 | 中央 COMMAND_REGISTRY vs 独立命令集;通用网关 vs 单平台 |

## A. 已对齐(移植忠实,无需动)

1. 流式节流 0.8s / 缓冲阈值 24 码点 / 光标 `" ▉"` — 三项参数与触发结构完全一致
   [hermes config.py:760-762, stream_consumer.py:884-896] = [stream.ts:23-25, 102-112]
2. markdown 管线 12+0 步,顺序与正则几乎逐字同构
   [adapter.py:8298-8468] = [markdown.ts:121-227]
3. 转义字符集 `[_*[\]()~`>#+\-=|{}.!\\]` 与顺序一致 [adapter.py:465-470] = [markdown.ts:12-16]
4. 表格→bullet 算法一致(行标签列、值去重、围栏跳过)[helpers.py:330-422] = [markdown.ts:44-116]
5. 400 → 纯文本单次兜底一致 [adapter.py:5561-5585] = [stream.ts:87-94]
6. 4096 分块 + `INDICATOR_RESERVE=10` + `FENCE_CLOSE` 骨架一致 [base.py:7164-7332] = [truncate.ts:13-107]
7. flood `MAX_FLOOD_STRIKES=3` 一致 [stream_consumer.py:173] = [stream.ts:26]

## B. 部分对齐(有行为差异,建议修复)

| # | 差异点 | hermes | 本项目 | 影响 | 建议 |
|---|---|---|---|---|---|
| B1 | 429 退避 | interval 每击翻倍,上限 10s [stream_consumer.py:2334-2336];adapter 内 Retry-After ≤5s 内联重试一次 [adapter.py:5619-5646] | 固定等待 `retryAfter ?? 2000ms` [stream.ts:81] | 高频 flood 下本项目退避不足,可能更快耗尽重试 | 中:复制翻倍退避 |
| B2 | fallback 触发面 | 任意编辑失败 → 进 fallback 模式,只发缺失尾部 [stream_consumer.py:2370-2387, 1384-1511] | 仅 429 满 3 击中断;重发全文替换预览 [stream.ts:75-99, bridge.ts:300-306] | 编辑失败(非 429)本项目会静默丢后续流式 | 低:行为可接受,重发全文更简单可靠 |
| B3 | 工具行 | `{emoji} {tool}: "{preview}"`,每工具 emoji,独立进度气泡 [base.py:3331-3378] | `🔧 [name]` 普通消息 [stream.ts:121] | UX 信息量 | 低:🔧 已可读,可选增强 |
| B4 | truncate 边界 | 末块围栏平衡补 `\n``` ` [base.py:7221-7235];分块后 `lstrip` [base.py:7297] | 两处均缺 [truncate.ts:42-46, 100] | 长回复末块可能留下未闭合围栏/前导空格 | **高:明确小 bug,易修** |
| B5 | link preview | 发送路径全覆盖(含 overflow 续消息)[adapter.py:1921-1926, 5814] | stream.ts sendChunk 未传 link_preview_options [stream.ts:147-173](events.ts 有) | 流式长回复 preview 失控 | 中:易修 |
| B6 | 菜单/指示 | `set_my_commands` 注册菜单 + `/commands` 分页 [adapter.py:3943-3990];`set_my_short_description` Online/Offline [adapter.py:4795];typing + cooldown [adapter.py:8222] | 无菜单注册、无状态指示、无 typing | 可发现性/反馈 | 中:typing + 菜单低成本 |

## C. 完全缺失(本项目无)

| # | 能力 | hermes 证据 | 补齐成本 | 建议 |
|---|---|---|---|---|
| C1 | 审批流 `/approve /deny`(挂起队列、超时自动 deny、内联按钮)[tools/approval.py:2349-2714, adapter.py:6140] | 高 | 不补:jcode 桥设计为白名单全自动批准(README 明确) |
| C2 | 媒体输入(照片/语音/视频/文档/贴纸/位置;文本文档 ≤100KB 内联注入)[adapter.py:9781-10133] | 中-高 | 部分补:文本注入可行;视觉/STT 依赖 daemon 模型能力(当前 deepseek-v4-flash 无视觉),defer |
| C3 | 媒体输出(agent 发图/文档/语音)[adapter.py:7543-8131] | 高 | defer:需 jcode 侧 MEDIA: 协议支持 |
| C4 | DM Topics 多会话 `/topic` [adapter.py:3602-3821, sc.py:4469] | 高 | defer:需 jcode 多会话+Bot API 9.4 |
| C5 | `/update /restart /sethome /platform` 管理命令 [sc.py:1582-5806] | 中 | 不补:systemd 已提供等价能力 |
| C6 | 并发命令 `/background /queue /steer /goal /pause /stop` [run.py:15761-15879] | 中-高 | defer:单用户场景队列已够(QUEUE_LIMIT) |
| C7 | 会话管理 `/sessions /resume /branch /title /save /undo /retry /compress` [sc.py:2616-4947] | 中 | 部分补:`/undo` 若有 SDK 支持则低成本;其余 defer |
| C8 | webhook 模式 [adapter.py:4230-4652] | 低 | 不补:轮询单实例已稳定 |
| C9 | 代理链/fallback IP/DoH [network.py:57-330] | 中 | 不补:VPS 直连正常;本地走系统代理 |
| C10 | 本地 Bot API server(20MB→2GB)[adapter.py:4265-4277] | 高 | 不补 |
| C11 | draft 流/Rich Messages(Bot API 9.5/10.1)[stream_consumer.py:1964-2331] | 高 | defer:依赖 Bot API 实验特性 |
| C12 | 媒体缓存(绕过 1h 过期)[media_cache.py] | 高 | defer:随媒体输入 |
| C13 | held-inbound 断连缓存(64 条)[adapter.py:1005-1157] | 中 | 低:offset 持久化已防重放,断连丢消息窗口极小 |
| C14 | 长文本批处理(>4096 分片聚合、媒体组 0.8s 合并)[adapter.py:9628-10110] | 中 | defer:单用户场景低频 |
| C15 | reactions(👀/✅/❌)与通知模式(important/all)[adapter.py:10536-10629] | 低 | 可选:低成本,UX 增强 |
| C16 | STT(语音转文本)[docs:363-381] | 中 | defer:依赖外部 STT 服务 |

## D. 架构差异(设计取向,不建议照搬)

1. **中央 COMMAND_REGISTRY**:hermes 命令面与 CLI 同源(commands.py:142),Telegram 只是传输层;本项目命令集独立(commands.ts),对齐 jcode TUI。单平台桥无需复制。
2. **通用 gateway + 平台插件**:hermes 支持 10+ 平台;本项目专注 Telegram。范围外。

## E. 建议执行清单(按优先级)

**执行状态(2026-08-16,commit 714ad84 + 8a95028):**

| 优先级 | 项 | 状态 |
|---|---|---|
| P0 | B4 truncate 末块围栏平衡 + lstrip | ✅ 已实施(truncate.ts,含测试) |
| P1 | B1 429 翻倍退避(上限 10s) | ✅ 已实施(stream.ts editIntervalMs) |
| P1 | B5 stream.ts sendChunk link preview | ✅ 已实施(构造器 opts,已接线) |
| P2 | B6 typing + set_my_commands + 状态指示 | ✅ 已实施(4s cadence / 16 命令菜单 / Online) |
| P2 | C15 reactions + 通知模式 | ✅ 已实施(ENABLE_REACTIONS,👀/👍/👎;working/tool 静音) |
| P2 | B3 工具行 emoji 映射 | ✅ 已实施(每工具 emoji,fallback ⚙️) |
| P3 | C14 长文本批处理 | ✅ 已实施(batch.ts TextBatchAggregator,已接线) |
| P3 | C5 管理命令 /restart /update /sethome /platform | ✅ 已实施 |
| P3 | C7 会话命令 /undo /title /sessions /resume /retry | ✅ 已实施(SDK rewindUndo 等) |
| P3 | C2a 文本文档注入 + 媒体占位 | ✅ 已实施(≤100KB 文本内联;照片/语音等占位) |
| P3 | C2b 图片输入 | ⏸ 探针实测:daemon 接受但 opencode-go/deepseek-v4-flash 400(无视觉),defer |
| P3 | C6 /background /steer | ✅ 已实施(/background 实测 3s 返回;/steer softInterrupt) |
| — | C13 held-inbound | ⏸ 跳过:offset 持久化已防重放,断连窗口极小 |
| — | C4 DM Topics / C8 webhook / C9 fallback IP / C11 draft-Rich / C2c STT | ⏸ 评估后跳过(依赖实验性 Bot API/外部服务/无需求) |


不补项:审批流(C1)、管理命令(C5)、webhook(C8)、fallback IP(C9)、本地 Bot API server(C10)、DM Topics(C4)、draft/Rich(C11)、多平台(D2)——均为设计差异或超出单用户桥的合理范围。

## 已知口径差异

hermes 文档声称"pin incoming user message during agent turn"(docs:1314-1316),代码中未找到实现。本分析按代码口径。
