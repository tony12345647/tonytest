# 世界模拟器（SillyTavern 酒馆助手脚本）

配合【此间小镇HereBetween】预设使用的背景世界模拟悬浮面板。

仓库：https://github.com/tony12345647/tonytest

## 架构（先看这个，之后维护/换模型接手都靠这张图）

```
酒馆助手脚本库贴的内容                 真正在跑的代码
┌─────────────────────┐   import()   ┌──────────────────────────┐
│ loader.js（一行）     │ ───────────▶ │ world-sim.js（本体逻辑）    │
│ 贴进脚本库，几乎不用改  │  jsDelivr    │ 放在 GitHub，之后改这个文件  │
└─────────────────────┘   CDN加载     └──────────────────────────┘
```

- `loader.js`：唯一需要贴进「酒馆助手 → 脚本库」的内容，只有一行
  `import('https://cdn.jsdelivr.net/gh/tony12345647/tonytest@v1.0.0/world-sim.js')`。
  用 jsDelivr 而不是 raw.githubusercontent.com，是因为 `import()` 要求正确的
  `Content-Type: application/javascript` 和 CORS 头，raw GitHub 给的是
  `text/plain` 会被浏览器拒绝，jsDelivr 的 GitHub 镜像会给对的 MIME。
- `world-sim.js`：实际逻辑（悬浮面板、背景模拟、状态注入），改版本只改这个文件。
- `【此间小镇HereBetween】1.6_世界模拟器整合版.json`（在 Downloads 根目录，不在这个仓库里）：
  预设里内嵌的脚本内容现在也是 `loader.js` 那一行，所以两种安装方式
  （单独装 / 跟预设一起装）更新时都只需要改这个仓库，不用重新生成预设文件。

## 功能

- 悬浮面板，可拖拽/折叠
- 背景定时呼叫 AI 推演世界（每 N 楼 或 每 N 分钟触发），只追踪"重要角色"，
  忽略店员/路人等打酱油角色
- 追踪：重要角色现状（位置/活动/互动对象）、世界大小事、玩家过往行为的后续发酵
- 时间锚点：自动读取预设的 `TimeLocation` 变量，让模拟贴合故事内实际时间
- 世界书参考：自动读取绑定的世界书条目名称，减少 AI 瞎编地名/设定
- 历史自动压缩：事件/发酵记录过多时自动归档精简，避免注入文字无限膨胀
- 结果只把"世界状态数据"注入正式RP（对齐预设的 现实层/`<World_Current>` 插槽），
  不会把模拟用的指令文字注入进你的正式RP
- 手动修正面板：AI 判断错了可以直接在面板改 JSON，不用等下一轮
- 角色升降级：手动把角色加入/移出追踪名单
- 双 API 模式：背景模拟可以沿用 ST 当前连线，或独立填一组反代 URL/Key/Model

## 安装

### 方式一：跟预设一起装
用【此间小镇HereBetween】预设的整合版 JSON（已内嵌 loader）在 SillyTavern
「导入预设」里导入，脚本会作为「预设脚本」自动跟着装好。

### 方式二：单独装
1. 打开 酒馆助手 → 脚本库 → 新建脚本（全局或绑定当前预设都可以）
2. 把 `loader.js` 的内容（就一行）贴进代码框
3. 保存并启用

两种方式装的都是同一份 loader，实际代码都从同一个 GitHub 仓库加载。

## 发布新版本的步骤（下次改代码照这个流程走）

1. 改 `world-sim.js`
2. （可选但建议）在 `CHANGELOG.md` 加一行这次改了什么
3. 提交并打新 tag（版本号自己递增，例如 v1.0.0 → v1.1.0）：
   ```bash
   cd "世界模拟器" 目录
   git add -A
   git commit -m "说明这次改了什么"
   git tag v1.1.0
   git push origin main --tags
   ```
4. 打开 `loader.js`，把 `@v1.0.0` 改成 `@v1.1.0`，存档、commit、push
   （这一步是唯一需要手动同步的地方，因为 jsDelivr 的 tag 引用是不可变的，
   不改 tag 版本号的话使用者永远读到旧版本）
5. 验证新版本能读到：浏览器开
   `https://cdn.jsdelivr.net/gh/tony12345647/tonytest@v1.1.0/world-sim.js`
   应该能看到新代码内容，而不是 404
6. 使用者重开 SillyTavern 分页即可吃到新版（jsDelivr 对 tag 引用的缓存通常很快，
   但如果没更新，可以开
   `https://purge.jsdelivr.net/gh/tony12345647/tonytest@v1.1.0/world-sim.js`
   手动清一次 CDN 缓存）

### 如果想要「完全零手动更新」（不推荐，但可以）
把 loader.js 里的 `@v1.0.0` 换成 `@main`（追踪分支而不是 tag），这样每次
push 到 main 分支使用者都会自动吃到最新代码，不用改 loader。代价是：
1）jsDelivr 对分支引用有缓存延迟（通常几小时到一天，可用上面的 purge 网址强制刷新）；
2）没有版本锁定，你在 main 上推的任何 bug 会直接影响所有正在用的人，
   没有回滚缓冲。

## 排错指南（脚本不动/报错时看这个）

### 第一步：打开浏览器 F12 → Console，看有没有红字报错

**`Failed to fetch dynamically imported module` / `import` 相关报错**
→ 通常是网路连不到 jsDelivr。改用 loader.js 注释里给的镜像线路
（fastly / gcore / testingcf）。

**`xxx is not a function` / `xxx is not defined`（例如
`setExtensionPrompt`、`getWorldbook`、`generateRaw`、`getVariables`、
`eventOn`、`tavern_events`、`triggerSlash` 相关）**
→ 这些是我依照酒馆助手/SillyTavern 官方文档核对过的 API，但第三方插件
更新快，字段名可能变了。诊断方法：
1. 在控制台跑 `window.TavernHelper` 展开看酒馆助手实际暴露了哪些函数
2. 跑 `window.SillyTavern.getContext()` 展开看 ST 原生暴露了哪些函数/常量
   （`extension_prompt_types`、`extension_prompt_roles` 这两个常量如果
   改名了，`updateInjection()` 那段要跟着改）
3. 把报错的函数名对照上面两步的实际结果，改 `world-sim.js` 里对应那行

**面板没有跳出来**
→ 先确认 loader.js 有没有报错（Console 看 import 那行是否成功）；
再确认脚本库里那个脚本是「启用」状态，而且绑在你现在用的预设/是全局脚本。

**世界状态没有注入到正式RP里**
→ 面板确认「把世界状态注入到正式RP生成」有勾选；再检查
`settings.injectDepth`（默认10，要跟预设「现实层」`<World_Current>`
所在的 in-chat depth 对齐，如果预设改了这个深度，面板设置要跟着改）。

**背景模拟一直没反应**
→ 面板要按「▶ 开始」；确认触发方式（楼层/分钟）跟数字设定合理；
自定义反代模式要确认 URL/Key/Model 三个都填了。

**AI 输出解析失败（日志显示"未找到 JSON"或类似）**
→ 通常是模型没有乖乖只回 JSON（尤其某些模型爱加 markdown 代码块或
额外说明）。可以在面板换一个更听话的模型，或者以后考虑在
`extractJson()` 加更宽松的容错解析。

## 数据存在哪里（酒馆助手变量）

- 全局变量 `world_sim_settings`：面板设置（API模式、触发方式、开关等），
  跨聊天共用
- 聊天变量 `world_sim_state`：当前这个聊天的世界状态（角色/事件/发酵），
  跟着聊天走，换聊天/换角色卡就是独立的世界

## 已知限制

- 自定义反代 API Key 会明文存在浏览器变量里，不要在共用电脑上使用自定义模式
- jsDelivr 是公开 CDN，如果这个仓库设成 private，jsDelivr 读不到，
  loader 会失败——想用这套更新机制，仓库要是 public
