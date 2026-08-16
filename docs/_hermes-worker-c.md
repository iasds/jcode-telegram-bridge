# Worker C 报告:参数级差异

对比双方:
- hermes 侧: `/home/user/.jcode/scratch/hermes-agent/gateway/stream_consumer.py`、`/home/user/.jcode/scratch/hermes-agent/plugins/platforms/telegram/adapter.py`、`gateway/config.py`、`gateway/platforms/base.py`、`gateway/platforms/helpers.py`
- 本项目侧: `/home/user/jcode-telegram-bridge/src/stream.ts`、`markdown.ts`、`truncate.ts`、`events.ts`、`bridge.ts`

方法:只读分析,零文件修改。逐文件逐行核对。

## Worker C 报告:参数级差异

### 1. 节流间隔
- hermes: 0.8s [`gateway/config.py:760` DEFAULT_STREAMING_EDIT_INTERVAL=0.8; `stream_consumer.py:130` 默认值; 触发条件 `elapsed >= self._current_edit_interval` 在 `stream_consumer.py:886-887`]。注意 hermes 有自适应退避:每次 flood 打击 `interval *= 2`,上限 10s [`stream_consumer.py:2334-2336`]
- 本项目: 800ms [`stream.ts:23` EDIT_INTERVAL_MS=800; 触发 `elapsed >= EDIT_INTERVAL_MS` 在 `stream.ts:108`]
- 差异: 数值相同。策略不同:hermes 被 429 打击后间隔翻倍(上限 10s),本项目固定 800ms。

### 2. 流式缓冲阈值
- hermes: 24 码点 [`config.py:761` DEFAULT_STREAMING_BUFFER_THRESHOLD=24; 判断 `len(self._accumulated) >= self.cfg.buffer_threshold` 在 `stream_consumer.py:892`,注释明确 "buffer_threshold is intentionally codepoint-based" (`:888-892`)]
- 本项目: 24 码点 [`stream.ts:24` BUFFER_THRESHOLD=24; `cpLen = [...this.accumulated].length` + `cpLen >= BUFFER_THRESHOLD` 在 `stream.ts:107-108`]
- 差异: 无。触发条件结构也一致(interval 且非空 OR 达阈值)。

### 3. 光标字符
- hermes: `" ▉"` [`config.py:762` DEFAULT_STREAMING_CURSOR; `stream_consumer.py:132`]。另有防呆:光标-only 更新跳过 (`:2115-2117`)、新消息最少 4 字符守卫 `_MIN_NEW_MSG_CHARS=4` 防 "X ▉" tofu 消息 (`:2129-2134`)
- 本项目: `" ▉"` [`stream.ts:25` CURSOR; 追加于 `stream.ts:110`]
- 差异: 字符相同。本项目 `start()` 无条件先发一条仅含光标的消息 [`stream.ts:52-63`],hermes 无此动作(首次发送发生在首个 delta 的 `_send_or_edit`,且被上述守卫约束),本项目无 4 字符守卫。

### 4. 编辑失败策略
**400 处理**
- hermes: finalize 编辑先试 MarkdownV2,失败即 `_strip_mdv2` 纯文本重试一次 [`adapter.py:5561-5585`];流式中编辑(finalize=False)为纯文本无 parse_mode,不会 400 [`adapter.py:5551-5556`];"not modified" 视为成功 [`adapter.py:5571-5572, 5589-5591`];message_too_long → finalize 拆分 / 流式中截断+饱和去重 [`adapter.py:5595-5615`]。消费者侧**任何**非 flood 编辑失败立即进 fallback 模式(`_edit_supported=False`,最终只发缺失尾部)[`stream_consumer.py:2370-2387`]
- 本项目: `edit()` 中 markdown 400 → `stripMdv2` 纯文本重试一次 [`stream.ts:87-94`];"not modified" → true [`stream.ts:86`];其余错误仅返回 false,不禁用流式(只有 429 满 3 击置 `failed`)[`stream.ts:75-96`]
- 差异: 400 兜底同构(单次 plain 重试);但 hermes 把任意编辑失败视为流式中断信号,本项目只在 flood 耗尽时中断。

**429 flood**
- hermes: `_MAX_FLOOD_STRIKES=3` [`stream_consumer.py:173`];每击退避 `interval*2` 上限 10s [`stream_consumer.py:2334-2336`];adapter 层 Retry-After ≤5s 则 sleep 后内联重试一次,>5s 直接返回失败 [`adapter.py:5619-5646`];满 3 击 → fallback 模式,`got_done` 时经 `_send_fallback_final` 只发缺失尾部(每 chunk 重试 1 次,retry_after 上限 5s)[`stream_consumer.py:1384-1511, 1674-1688, 260`]
- 本项目: `MAX_FLOOD_STRIKES=3` [`stream.ts:26`];等待 `retryAfterMs ?? 2000ms` [`stream.ts:81`];满 3 击 `failed=true` → 调用方收集全文一次性交付 [`bridge.ts:300-306`];sendChunk/events 侧 429 重试 2/3 次 [`stream.ts:153-157; events.ts:81-88`]
- 差异: 达到上限后行为一致(禁用流式、收集文本一次发);hermes 多了 interval 翻倍退避、adapter 内 ≤5s 内联重试、以及"只发缺失尾部"的增量交付(本项目重发全文替换预览)。

### 5. 工具分段
- hermes: `on_delta(None)` → `on_segment_break()` → 队列 `_NEW_SEGMENT` [`stream_consumer.py:611-621, 516`];run 循环 finalize 当前段(`finalize=True, is_turn_final=False`)[`stream_consumer.py:1068-1074`],随后 `_reset_segment_state(preserve_no_edit=True)` [`:1181`];工具行由网关 `format_tool_event` 渲染为 `{emoji} {tool_name}: "{preview}"` 或 `{emoji} {tool_name}...`(emoji 按工具名,默认 ⚙️)[`base.py:3331-3378`],走独立进度队列;内容恢复时 `on_new_message` 关闭旧气泡 [`stream_consumer.py:546-554`]
- 本项目: `onToolStart()`:非空先 `edit(formatMessage(accumulated), true)` [`stream.ts:117-119`];发 `🔧 [formatMessage(name)]` [`stream.ts:121`];重置后发新光标消息 [`stream.ts:125-128`]
- 差异: 工具行格式不同(hermes 每工具 emoji+参数预览,本项目固定 🔧+括号);hermes 工具行走独立进度气泡且内容恢复走新段,本项目工具行即普通消息并立即另起光标消息;空段跳过编辑的逻辑两者都有(`stream_consumer.py:914` vs `stream.ts:117`)。

### 6. turn 结束 finalize
- hermes: `got_done` → `_notify_before_finalize` [`stream_consumer.py:1079`];无光标 finalize 编辑 [`:1123-1125`],经 adapter `format_message`+MarkdownV2+plain 兜底+overflow 拆分续消息(`_edit_overflow_split`, `adapter.py:5531`)+`_separate_chunk_indicator_from_fence` 把 `(i/N)` 移出围栏行 [`adapter.py:495-510, 5799`];可选 fresh-final(fresh_final_after_seconds 默认 0=关闭 [`config.py:796`],Telegram 另有 `prefers_fresh_final_streaming` [`stream_consumer.py:2217-2231, 1964-2040`]);冗余 finalize 跳过 [`:1096-1118`];交付 payload 记录与网关对账 [`:1128, 442-499`]
- 本项目: `finish()`:`trim() || "*(no output)*"` [`stream.ts:134`];`truncateMessage(formatMessage(text))` 分块 [`:135`];chunk0 MarkdownV2 编辑(400→plain)[`:136`];chunks 2+ 走 `sendChunk`(429 重试、400→plain)[`:137-139, 147-173`]
- 差异: 本项目无 fresh-final、无 `(i/N)` 与围栏换行分离(见第 10 项)、无 `delivered_final_text` 对账。

### 7. markdown 管线步骤数
- hermes [`adapter.py:8298-8468`,12 步+第 0 步]:
  0) 表格→bullets (`:8324`) / 1) 围栏代码保护,转义 `\` 和 `` ` `` (`:8338-8342`) / 2) 行内代码保护 (`:8346-8350`) / 3) 链接转换,显示文本转义、URL 转义 `\` `)` (`:8359`) / 4) 标题→粗体 (`:8368-8370`) / 5) 粗体 `**`→`*` (`:8373-8377`) / 6) 斜体 `*`→`_` (`:8382-8386`) / 7) 删除线 `~~`→`~` (`:8389-8393`) / 8) spoiler `||` (`:8396-8400`) / 9) 引用 `>` (`:8414-8419`) / 10) 转义剩余特殊字符 (`:8422`) / 11) 逆序恢复占位符 (`:8426-8427`) / 12) 括号安全网 (`:8432-8466`)
- 本项目 [`markdown.ts:121-227`,同样 12+0 步]:0 (`:136`) / 1 (`:139-147`) / 2 (`:150`) / 3 (`:153-157`) / 4 (`:160-163`) / 5 (`:166`) / 6 (`:169`) / 7 (`:172`) / 8 (`:175`) / 9 (`:178-183`) / 10 (`:186`) / 11 (`:189-191`) / 12 (`:194-227`)
- 差异: 步骤数量与顺序完全一致,正则逐个相同。唯一分歧在步骤 12 的链接开括号判定:hermes 为 `'](http' in before or '](' in before` [`adapter.py:8452`],本项目仅 `before.includes("](")` [`markdown.ts:208`]。

### 8. 转义规则
- hermes: 字符集 `[_*[\]()~`>#+\-=|{}.!\\]` [`adapter.py:465`],`_escape_mdv2` 前缀反斜杠 [`adapter.py:468-470`];顺序=构造占位→整体转义→逆序恢复→括号安全网;代码块内 `\` 与 `` ` `` 均转义 [`adapter.py:8335`],行内代码内 `\` 转义 [`:8348`];链接 URL 仅转义 `\` 与 `)`,嵌套括号由正则 `([^()]*(?:\([^()]*\)[^()]*)*)` 消化 [`adapter.py:8356, 8359`]
- 本项目: 字符集完全相同 [`markdown.ts:12`];顺序同;代码块/行内代码/URL 转义规则逐一对应 [`markdown.ts:145, 150, 154-156`];`stripMdv2` 清理顺序也与 hermes `_strip_mdv2` 同构 [`markdown.ts:18-26` vs `adapter.py:473-492`]
- 差异: 无(除第 7 项步骤 12 的 `](http` 分支)。

### 9. 表格处理
- hermes: `convert_table_to_bullets` [`helpers.py:379-422`]+`_render_table_block` [`helpers.py:330-376`];分隔符正则 `TABLE_SEPARATOR_RE` [`helpers.py:306-308`];行标签列检测(cells==headers+1, `:350`);渲染为 `**{heading}**` + `• {header}: {value}` bullet(`:367-374`);值与标题重复时跳过该 bullet(`:369-370`);围栏内表格不动(`:395-402`);Telegram 在步骤 0 调用 [`adapter.py:8324`]
- 本项目: `convertTableToBullets` [`markdown.ts:81-116`]+`renderTableBlock` [`markdown.ts:44-78`];`TABLE_SEPARATOR_RE` [`markdown.ts:30`];同一套算法
- 差异: 实质无。

### 10. truncate/分块
- hermes: `truncate_message` [`base.py:7164-7332`]:max 4096 (`:7166`)、`INDICATOR_RESERVE=10` (`:7192`)、`FENCE_CLOSE="\n```"` (`:7193`);Telegram 以 UTF-16 计长(`utf16_len`,`adapter.py:720-723`,调用点 `:5529, 5696, 5723, 5996`),默认 `len` 为码点;优先换行后空格(`:7252-7255`);行内代码跨度避让(反引号奇偶,` :7281-7294`);围栏关闭/带语言标签重开(`:7316-7321`);**末块围栏平衡再检查**(carryLang 且仍未闭合则补 FENCE_CLOSE,` :7221-7235`);分块后 `remaining[split_at:].lstrip()` (`:7297`);`(i/N)` 指示器(`:7326-7330`)
- 本项目: `truncateMessage` [`truncate.ts:28-107`]:4096 (`:13`)、INDICATOR_RESERVE=10 (`:14`)、FENCE_CLOSE (`:15`);JS `.length` 即 UTF-16 单位(注释 `:9-10`),`customUnitToCp` 映射码点边界(`:18-26`);换行→空格(`:50-52`);行内代码避让(`:54-70`);围栏关闭/重开(`:76-97`);**无末块围栏平衡检查**(` :42-46` 直接 push);`remaining.slice(splitAt)` 无 lstrip(`:100`);`(i/N)`(`:103-107`)
- 差异: (a) hermes 末块在 carryLang 未闭合时补 FENCE_CLOSE,本项目会留下未闭合围栏;(b) hermes 分块后 lstrip 前导空白,本项目保留。

### 11. 纯文本 fallback 触发条件与重试次数
- hermes: finalize 编辑 MarkdownV2 异常 → `_strip_mdv2` 纯文本一次 [`adapter.py:5561-5585`];续消息发送 `for use_markdown in (True, False) if finalize else (False,)`(MarkdownV2→plain)[`adapter.py:5796-5814`];fallback 触发=任意编辑失败(`stream_consumer.py:2370-2387`);`_send_fallback_final` 每 chunk flood 重试 1 次(`attempt in range(2)`)[`stream_consumer.py:1492-1511`],非 flood 或超长 flood 直接放弃交回网关 [`:1510-1511, 1526-1532`]
- 本项目: `edit()` markdown 400 → plain 一次 [`stream.ts:87-94`];`sendChunk` 400 → plain 一次 [`stream.ts:159-167`];`finishWith` 400 → 重新分块 plain(`truncateMessage(stripMdv2(content))`)[`events.ts:111-123`];`safeSendMessage` 400 → 重新分块 plain [`events.ts:144-155`];429 重试:events `MAX_RETRIES=3` [`events.ts:19`],stream 2 次(`attempt < 2`)[`stream.ts:75, 153`]
- 差异: 400 均为单次 plain 兜底;但 hermes 的 fallback 触发条件更宽(任意编辑失败即放弃流式),本项目仅 429 耗尽才中断。

### 12. 链接预览控制
- hermes: `_disable_link_previews` 默认 False,来自平台 extra 配置 `disable_link_previews` [`adapter.py:731, 10705-10715`];`_link_preview_kwargs()` 返回 `LinkPreviewOptions(is_disabled=True)` 或 `disable_web_page_preview` [`adapter.py:1921-1926`],应用于各发送路径(含 overflow 续消息 `:5814, 5835`、draft `:6123` 等),**edit_message 路径不传**
- 本项目: `RendererOptions.disableLinkPreviews`(来自 `cfg.disableLinkPreviews` [`bridge.ts:41`]),`linkPreview()` 返回 `{is_disabled:true}` [`events.ts:40-42`],应用于 finishWith/safeSendMessage 的 chunk 发送 [`events.ts:107, 117, 140, 150`],编辑不传;**stream.ts 的 `sendChunk` 完全不传 link preview 选项** [`stream.ts:147-173`]
- 差异: 编辑路径两者均不传;发送路径 hermes 统一走 `_link_preview_kwargs`(覆盖 overflow 续消息),本项目 stream.ts 路径缺失、仅 events.ts 覆盖。

---

## 结论摘要

三项完全一致:节流 0.8s、阈值 24 码点、光标 " ▉"。

markdown 管线 0-12 步与转义规则几乎逐字同构(唯一差异:步骤 12 的 `](http` 分支)。

实质差异集中在:
1. 429 退避策略:hermes 每击 interval 翻倍(上限 10s)+ adapter 内 Retry-After ≤5s 内联重试;本项目固定 2000ms 等待。
2. fallback 触发面:hermes 任意编辑失败即进 fallback 模式(只发缺失尾部);本项目仅 429 满 3 击中断,且重发全文替换预览。
3. 工具行格式:hermes `{emoji} {tool}: "{preview}"` 走独立进度气泡 vs 本项目 `🔧 [name]` 直接发消息。
4. truncate:hermes 末块补围栏平衡 + 分块后 lstrip,本项目两处均缺。
5. stream.ts 的 sendChunk 缺失 link preview 控制(events.ts 有)。

全程只读,未修改任何源码文件。
