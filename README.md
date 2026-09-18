# dsh-zcode-migrate

把 ZCode 本地的会话连同思考过程迁移成 DSH 原生会话，迁移后可以直接接着聊。

ZCode 的会话存在本机 `~/.zcode/` 里，没有导出功能，官方 FAQ 的说法是会话历史不建议搬运。换到 DSH（DeepSeek Harness）之后，这些记录就留在旧工具里了。

这个插件把 `session`、`message`、`part` 三张表里的内容读出来，按 DSH 的事件格式写成会话日志。写完的会话在 DSH 里和原生会话没有区别：侧边栏能看到，打开是完整的对话和 Think 块，可以继续发消息。迁移过程是纯数据变换，不调用模型，思考文本逐字搬运，不改写、不摘要、不重新生成。

在 Windows 上对着 247 个真实会话做过完整验证：导入 247/247 成功，21151 段思考（约 5534 万字）逐字比对全部一致，没有任何冲突或失败。测试 151 项。

需要 Node.js 22.15 以上（用到 `node:sqlite` 和 `node:zlib` 的 zstd）。插件本身没有第三方依赖。

## 目录

- [背景](#背景)
- [它做什么](#它做什么)
- [安装](#安装)
- [使用](#使用)
- [数据从哪里来](#数据从哪里来)
- [迁移规则](#迁移规则)
- [冲突处理](#冲突处理)
- [验证](#验证)
- [已知限制](#已知限制)
- [文件说明](#文件说明)
- [许可](#许可)

## 背景

ZCode 每个会话的完整记录（包括模型的思考过程）都落在 `~/.zcode/cli/db/db.sqlite` 里。DSH 的会话是另一种格式：一份追加写的事件日志，消息历史由日志推导出来，模型续聊时把历史当作自己的对话，而不是当成需要阅读的外部材料。

这两边的结构其实对得上。ZCode 的每条消息带一个 `anchor.turnId`，一次模型调用对应一条 assistant 消息，消息里的 `part` 分成 `reasoning`、`text`、`tool` 几种。DSH 的日志里，一个 turn 由 `turn/start` 和 `turn/end` 括起来，一次模型调用是一个 step，思考是 assistant 消息内容里的 `reasoning` 块。

所以迁移可以做得很直接：一个 turnId 对应一个 turn，一条 assistant 消息对应一个 step，思考块原文抄过去。不需要概述，也不需要让模型再读一遍历史。

## 它做什么

- 读取 ZCode 的 SQLite 库，全程只读（`readOnly` + `busy_timeout` + `query_only`），ZCode 开着也能导。
- 按 DSH 的标准事件写出会话：`turn/start`、`step/start`、`user/message`、`assistant/message`、`tool/call`、`tool/result`、`step/end`、`turn/end`、`session/title`。
- 写入走 DSH 自己的 `sessionPersistence` 服务，磁盘格式（多帧 zstd、序号连续性、崩溃修复）由 DSH 负责，插件不自己写文件。
- 按源会话的工作目录归位到对应工作区，工作区不存在时按 DSH 的默认规则用目录名新建。
- 每次启动 DSH 自动补齐源侧新增的内容，只追加，不改写已经迁移的部分。
- 写一份报告，记录每个会话迁了多少事件、多少段思考、哪些地方做了降级处理。

只使用 DSH 内置的事件类型，不写自定义事件，任何 DSH 构建都能读。

## 安装

最省事的是双击安装包：下载 [install.cmd](https://raw.githubusercontent.com/Mr-Grimwig/dsh-zcode-migrate/main/install.cmd)，双击运行。它会下载当前 main 分支到 `%LOCALAPPDATA%\dsh-zcode-migrate`，然后装进你机器上所有 dsh profile。装完重启一次 DSH 就行。需要 Node.js 22.15 以上，没装的话脚本会提示去哪装。再双击一次 `install.cmd` 就是更新到最新版；卸载双击 [uninstall.cmd](https://raw.githubusercontent.com/Mr-Grimwig/dsh-zcode-migrate/main/uninstall.cmd)。

想自己管源码的话，clone 之后跑安装脚本：

```bash
git clone https://github.com/Mr-Grimwig/dsh-zcode-migrate.git
cd dsh-zcode-migrate
node scripts/install-into-profile.mjs
```

不带参数会装进所有已存在的 profile（`web` 是浏览器界面用的，`headless` 是一次性任务用的），也可以只装一个：`--profile=web`。仓库里带着构建好的 `lib/`，clone 下来不用先构建。

脚本内部优先调用 `dsh plugin`，取不到 dsh 就用 pnpm 并直接改 profile 清单。装完会核对依赖和插件层都在，而不是只看退出码。更新必须"先 remove 再 add"：`file:` 依赖在 pnpm 里是硬链接快照，同一个 spec 重复 `pnpm add` 会被判成已经最新而不重新拷贝，所以改了代码要重跑一次脚本。卸载加 `--uninstall`。

也可以直接用 DSH 自己的命令，或者不装、只试跑：

```bash
dsh plugin --profile web add "file:<clone 下来的路径>"    # 直接让 DSH 装
dsh --patch <本仓库路径>/cordis.patch.yml                 # 试跑，不动 profile
```

包内声明了 `dsh.bundle.patch`，所以 `dsh plugin add` 会顺带把这个包加入 profile 的插件层，不需要手改任何配置文件。

## 使用

装完之后不需要做任何事。默认配置 `autoImport: pending`，每次启动 DSH 会扫一遍 ZCode 源，把新增或变长的会话补齐，然后写报告。已经迁移过的内容不会被重写。

要手动控制的时候用命令：

```
/zcode-import                  同步（扫描并导入所有未导入或有更新的会话）
/zcode-import scan             列出源会话和各自的迁移状态
/zcode-import status           已迁移数量、待同步数量、冲突待定数量
/zcode-import import <ID>      只导一个，ID 可以只给尾部片段
/zcode-import help             用法
```

不想让它自动写盘，在 profile 的 `cordis.patch.yml` 里覆盖一行配置：

```yaml
- id: zcode-migrate
  config:
    autoImport: off
```

迁移用的注册表和报告放在 `<DSH 主目录>/zcode-migrate/`，报告是 `reports/latest.md`。

不启动 DSH 也能操作和检查：

```bash
npm run scan                                     # 列出源会话和迁移状态
npm run audit                                    # 只读演练：全量比对思路，不写任何东西
npm run import                                   # 手动同步（等价于 /zcode-import）
node scripts/cli.mjs plan <会话ID>               # 演练单个会话，输出事件统计和结构校验
npm run verify-fidelity                          # 比对已迁移会话的思路原文
```

这几个命令默认用 `<DSH 主目录>/sessions` 作为写入位置，也可以显式指定 `--root=<DSH 的 sessions 目录>`。

## 数据从哪里来

按下面的顺序找源目录：配置里的 `source`、环境变量 `$ZCODE_HOME`、`~/.zcode`。

| 数据源 | 位置 | 说明 |
| --- | --- | --- |
| SQLite（默认） | `cli/db/db.sqlite` | 三张表，只读打开 |
| rollout 兜底 | `cli/rollout/model-io-<会话ID>.jsonl` | SQLite 缺失或损坏时自动启用 |
| 旧版格式 | `projects/**/*.jsonl` | 3.0 之前内嵌 Claude 运行时的格式，默认关闭 |

rollout 兜底源的实际内容比预想的多：每行是一次模型调用的请求窗口和响应，里面有 `reasoningText`、`toolCalls` 和工具结果。把滑动的请求窗口按全局下标合并，能还原出模型当时看到的完整对话，只有最后一次响应不在任何窗口里，单独从它自己的记录取。它缺的是逐条消息的时间戳（用所属调用的开始时间近似），另外区分不了人工输入和运行时注入的上下文，除窗口最后一条外都标成来源未判定。

读取过程中的异常（文件缺失、JSON 损坏、字段变化）都降级成报告里的告警，不中断整批导入。

## 迁移规则

| ZCode | DSH |
| --- | --- |
| `message.anchor.turnId` | 一个 turn |
| 一条 assistant 消息 | 一个 step |
| `part{type:'reasoning'}` | assistant 消息内容里的 reasoning 块，原文 |
| `part{type:'text'}` | assistant 消息内容里的 text 块 |
| `part{type:'tool'}` | 内容里的 tool-call 块，外加 `tool/call` 和 `tool/result` 事件 |
| 用户消息（`semantics.origin` 为 `real_user`） | `user/message`，source 为 user |
| 运行时注入（提醒、压缩摘要等） | `user/message`，source 为 plugin |
| 会话标题 | `session/title`，按用户重命名处理，DSH 不会再自动生成 |
| 附件 | 占位文本加引用和元信息，二进制不搬 |
| 压缩标记 | 不迁移，整段历史按追加顺序保留 |

工具调用同时出现在 assistant 消息内容里和 `tool/call` 事件里，和 DSH 原生记录的会话一致，这样续聊时发给 provider 的请求才是合法的。源侧没有记录结果的工具调用（状态是 `running` 或 `pending`），按 DSH 崩溃恢复时的同一套约定补一个 `TOOL_OUTCOME_UNKNOWN` 结果，并在报告里计数。

工具入参是个例外：ZCode 存的是解析后的对象，模型原始字符串没有保留，所以只能重新序列化（语义相同，空白可能不同），报告里会记下数量。

## 冲突处理

增量同步的判定靠比对源内容：把已存的日志切片成 turn，与重新规划的结果逐 turn 比对。

- 已存的 turn 是新结果的前缀：只追加多出来的部分。
- 完全一致：跳过，不碰文件。
- 对不上：拒绝改写。这种情况要么是源侧的历史真的被改过，要么是上次导入时还有工具调用没结束（日志里已经写了合成的占位结果，源侧随后写入真实结果，这段历史永远对不上）。

被拒绝的会话会在注册表里记一笔，之后不再重试，免得每次启动都报同一条。用 `/zcode-import status` 能看到，处理方式是给它另建一个全新副本：

```
/zcode-import import <ID> --force
```

原副本保留不动，新副本是另一个会话 ID，挂到同一个工作区。

迁移期间如果某个会话正在 DSH 里开着，会跳过它。活动会话在内存里有自己的写入游标，外部往日志里追加会让它的下一次写入撞上已经用掉的序号，重启 DSH 后会自动补齐。

## 验证

```bash
npm run build              # 语法检查、模块导入检查、清单完整性
npm test                   # 151 项
npm run audit              # 只读审计：全量演练并比对思路原文，不写任何东西
npm run verify-fidelity    # 对已迁移的结果逐字比对
```

`verify-fidelity` 回答两个问题，故意分开：

1. 磁盘上的日志是不是当初计划要写的内容。用注册表里记录的逐 turn 摘要和日志比对，再逐段比对思考文本。
2. 源侧在导入之后有没有变长。报成 drift，不算失败（运行中的 ZCode 会话本来就会一直增长）。

在真实数据上的结果：

| 项目 | 结果 |
| --- | --- |
| 导入 | 247/247，冲突 0，失败 0 |
| 思考 | 21151 段 / 55347139 字符，逐字比对全部相等 |
| 事件 | 168677 条，结构校验全部通过 |
| 逐字校验 | 247/247 |

测试里对思考的判定是整串字符串的 `===`，不是相似度或者哈希。事件流的合法性由一个单独实现的校验器判定，没有复用被检查的代码。

## 已知限制

- **默认会在启动时写盘**。只新增和追加，不改写已有内容，失败也不影响 DSH 使用。不想要就把 `autoImport` 设成 `off`。
- 源会话的工作目录如果已经不存在，会话照样导入、照样能续聊，但不会出现在侧边栏的分组里。要么把目录建回来，要么打开 `createMissingDirs`（默认关闭，避免在没打招呼的情况下往文件系统写东西）。作者这里 247 个会话中有 93 个属于这种情况，多数是早已删掉的临时目录。
- 侧边栏里没打开过的迁移会话会先显示成它所在目录的名字，点开一次之后才换成真实标题。DSH 的标题来自会话日志里的 `session/title` 事件，没读过日志就只有一个占位，数据本身是好的。
- 判断源侧有没有更新用的是 `time_updated`。源文件被人工改写而时间戳没动的话，自动同步不会察觉，`npm run verify-fidelity` 能查出来。
- rollout 兜底源没有逐条消息的时间戳，也区分不了人工输入和注入的上下文。
- 旧版 `projects/**/*.jsonl` 没有公开的格式文档，按字段回退链尽力解析，默认关闭。
- 压缩标记不做 surface 替换，全部历史按追加顺序保留。好处是不会因为压缩而丢掉任何一段思考。
- 工作区名取目录名。用独立 CLI 导入（没有 DSH 在跑）时不会挂载工作区，会话本身是好的，之后在 DSH 里打开那个目录就会归组。

## 文件说明

```
src/
  index.js              插件入口
  commands.js           /zcode-import 命令和设置项
  migrate.js            扫描、规划、对账、写入、回读校验、报告
  auto-import.js        启动时的自动同步
  core/                 配置解析、摘要与 ID、告警收集、导入锁、DSH 包解析
  source/               ZCode 三个数据源的读取，字段回退链集中在 model.js
  transform/            plan.js 负责数据变换，validate.js 负责结构校验
  target/               写入、工作区挂载、注册表、离线读日志
scripts/
  cli.mjs               独立命令行
  install-into-profile.mjs  装进 profile（不带参数=所有 profile）
  one-click.mjs         install.cmd / uninstall.cmd 调用的逻辑
  jsonl-backend.mjs     在纯 Node 里启动 DSH 的持久化后端（集成测试用）
  push-via-api.mjs      github.com 连不上时，改走 GitHub API 推送（逐对象校验 SHA）
  build.mjs             校验并生成 lib/
install.cmd           双击安装（下载 → 装进所有 profile）
uninstall.cmd         双击卸载
test/                   151 项测试，含真实后端的集成测试
docs/需求说明书.md       验收基准
```

`lib/` 是构建产物，随仓库提交，这样 clone 下来就能直接装，不需要先构建。改动 `src/` 之后跑 `npm run build`。

## 许可

MIT，见 [LICENSE](LICENSE)。

不是智谱或 DeepSeek 官方工具。它只读 ZCode 的数据，往 DSH 里新增会话，不会修改 ZCode 的任何文件。用之前请自行确认符合相关软件的使用条款。迁移会往 DSH 的会话库里写入内容，建议先备份 `<DSH 主目录>/storages/` 和 `sessions/`。
