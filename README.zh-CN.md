# seek

<img src="assets/icon.png" width="104" align="right" alt="seek：一枚装着瞳孔的气泡" />

> **I Seek You** —— IM 最初的原点。
> 打起来像 ICQ，长成你熟悉的那些角色的样子。

名字来自 ICQ 出发的那句话。二十多年前，即时通讯的意义是**去找一个人** —— 不是打开一个软件，不是启动一个任务，而是够到某一个具体的存在。

seek 保留这个原点，只把「人」换掉：你的联系人不再是真人，而是一群长期活着的 agent。它们有名字、有脾气、有自己的活。你在房间里说话；它们从旁边听着；它们觉得值得开口时开口，真有事情需要你拍板时来找你。

这不是飞书克隆。这是一个穿着 IM 外衣的多 Agent 产品。

## 状态

**内核已经有了，界面开了头。** 三份设计文档已经定稿（`docs/design/`），内核写在 `src/` 里（50 个 TypeScript 文件、约 17,896 行、335 个测试），上一版可运行的实现留作参考原型（`prototype/`）。界面是 `ui/` 下的独立包——Electron 在主进程里跑内核，渲染层是 React——它已经跑得起来：能打成可下载的 macOS 应用（`docs/decisions.md` 默认值 26），而全新安装第一次打开时，它自己把要打开的世界造出来——一个房间、它的 bot，以及旁边的名册（`docs/decisions.md` 默认值 25）——此后从内核里读出房间、成员和消息画出来，接受你输入的消息，也能打开一条消息的线程。消息经内核自己的 `deliver()` 落库，房间里的 bot 被收到的那条观察项叫醒，然后回应。要不要回应是模型的判断，回什么话是模型的文字，两段各自绑在你点名的 `llama-server` 上；什么都不点名（也就是下载到的那一版的样子）时，两段都是内核自带的占位实现，窗口会说明每一段各站在哪一边。线程同样是内核自己的记录，不是界面另开的一段对话：回复走同一个 `deliver()`，只是点名了它在回应哪条消息，面板画的就是库里已有的那条链。

原型的存在只为证明一件事：飞书式的界面可以被纯本地数据支撑。这件事成立。但它的数据模型是单人的 —— 一个账号、一群假人、消息属于会话 —— 那不是这一版需要的模型，所以它改造成不了这一版。

## 为什么不是又一个 IM 克隆

| | 飞书 / 微信 / Slack | seek |
|---|---|---|
| 头像背后 | 一个人 | 一个长期活着的 agent |
| 群里没人 @ 它 | 它永远不知道 | **它知道** —— 消息落进它的收件箱，零成本 |
| 它什么时候说话 | 只有被叫到时 | 它判断该说时才说 —— 用便宜的方式判断，不是每条消息都跑一次前沿模型 |
| 它的成本 | —— | 花费是一等公民：越用越能看见它花在哪里 |
| 上下文 | 完全共享 | **消息共享，上下文私有** —— 一个房间里五个 agent，不是五份房间 |

## 目录

```
seek/
├── docs/design/        已定稿的设计（实现照着它写）
│   ├── data-model.md       实体与关系：消息共享，上下文私有
│   └── agent-lifecycle.md  agent 怎么活着：收件箱、两段式循环、主动私聊
├── docs/host-rulings.md 宿主本人拍板的每一条决定（按时间顺序，含被覆盖的旧决定）
├── docs/decisions.md    已拍板的决定（一行一条，带日期）
├── prototype/           上一版可运行原型（Electron，纯本地）
├── src/                 内核（TypeScript，还没有界面）
├── CONTRIBUTING.md
├── NOTICE.md            与飞书的关系、许可边界
└── LICENSE              MIT
```

**按这个顺序读**：`docs/design/data-model.md` 定的是*有什么、彼此什么关系*；`docs/design/agent-lifecycle.md` 定的是*这些东西怎么活着、什么时候花钱*。想知道「谁在什么时候决定了什么、原话是什么」，读 `docs/host-rulings.md`。

**每份文档都有中英文两版，两份同步更新。** 中文版放在原文件旁边，用 `.zh-CN.md` 后缀（`README.zh-CN.md`、`docs/decisions.zh-CN.md`……）；两份一起改，两份不一致就是这一对的缺陷，而不是其中一份赢了。`LICENSE` 是例外，只保留英文 —— 翻译过的许可证不是许可证。见 `CONTRIBUTING.md`。

## 跑内核

**不用安装**：没有依赖，也没有构建步骤，克隆下来就能跑。需要 Node 22.18 或更新的版本 —— 代码是 TypeScript，类型由 Node 自己剥掉。

```bash
npm start                      # 第一个里程碑
npm start -- --lang zh-CN      # 同一次运行，中文
npm start -- seek-data/b.json  # 另一个存储，与自带的名册放在一起
```

它打印的是一个房间、一个人说了句没有点任何人名字的话，以及机器人有没有自己开口。**机器人的两半都还是占位实现** —— 要不要动的判断，和说出口的字 —— 报告里明写着这件事。一次运行展示的是内核：每个机器人一个收件箱的投递、闸门、回合。它展示不了的是这个设计立不立得住；那需要一个模型。

存储在 `seek-data/seek.json`，第二次运行会接着第一次建的房间往后写 —— 数据活过进程正是这个产品自己的论点，所以房间是变长而不是重置。想重来就把那个文件删掉。

想让实测过的观察模型替掉占位实现，就把这次运行指向**你自己起好**的 `llama-server`：

```bash
npm start -- --server http://127.0.0.1:8080 --window 24
```

`--server` 是一个 **seek 不启动、不监管、也不停止**的进程的 origin（`docs/decisions.md` 默认值 20）；`--window` 是一次判定最多能读多少 —— 那是调用方的数字，因为运行时并不知道模型的窗口有多大。两个必须一起给：只给一个会被拒绝，而不是靠猜补上另一半。**这个仓库不随包发任何权重**，所以这是这里唯一一条需要你自己提供东西的命令。

存储在 `seek-data/` 以外时，旁边要有名册。`agents.yml` 是从存储自己所在的目录读的（`docs/decisions.md` 默认值 14 与 15），旁边没有名册的存储会打开成一个没有 agent 的机器人，并且拒绝运行，而不是凭空造一个。

## 安装应用

[发布页](https://github.com/argszero/seek/releases)上是当前这一版，两种形状：`Seek-<version>-arm64-mac.pkg` 直接装进 `Applications`，`Seek-<version>-arm64-mac.zip` 是同一个包，解压后拖进去。Apple 芯片的 macOS。**`v0.1.1` 及更早**的发布是未签名构建的；从这棵树构建出来的包带有 `Developer ID` 证书签名并通过 Apple 公证，下面这一节讲的就是这件事。

**从现在起还会打一个安装包，和那个 zip 并列。** 在 `ui/` 里跑 `npm run dist:pkg`，会用 macOS 自己的 `pkgbuild`（`packaging/make-pkg.mjs`）从同一个 bundle 切出 `ui/release/Seek-<版本>-arm64-mac.pkg`；装它就把 `Seek.app` 放进 `Applications`，不必再拖。做成 `.pkg` 而不是 `.dmg`，是因为 electron-builder 的 `dmg` 目标最后要调 `hdiutil create`，而开发这个仓库的环境直接拒绝它（`the operation is not permitted`），`pkgbuild` 则不被拒绝——旁边的 EMRG 项目把 macOS 下载做成 `.pkg`，也是同一个原因。打包也不该是只有某台机器才做得到的事：推一个 `v*` 标签，会在 macOS runner 上跑同一条 `npm run dist:pkg`（`.github/workflows/release.yml`），把 `.pkg` 和 `.zip` 一起挂到发布页。

**从这棵树构建出来的包，装和开都不用先处理什么。** `release.yml` 从仓库 Secret 里取两张证书，导入一个只为这一次运行存在的钥匙串：`Developer ID Application` 给 bundle 签名，`Developer ID Installer` 给安装包签名（`packaging/make-pkg.mjs` 调 `productsign`，再用 `pkgutil --check-signature` 把链读回来核对），`packaging/notarize.mjs` 用 App Store Connect 的 API 密钥把安装包送交 Apple、等判决，把票据 stapling 到文件上，再让 Apple 把这张票据从文件里读回来核对一次。最后这两步都要连 Apple，所以那里的网络故障会被重试而不是被当成结论：已经写进文件的票据，不会因为某台主机连不上就不存在了。因此最后那次重读遇到 Apple 连不上时只报一条警告，只有包里确实没有票据才会让发布失败。这两张证书不能互换——安装包和 bundle 由系统里两个不同的部分来判定，`productsign` 会直接拒绝 Application 证书。本机上决定安装包签不签的是**安装包**那张身份：没有它时 `npm run dist:pkg` 照样能构建，只是明说这个包未签名、跳过 `productsign`，而不是失败。**bundle** 不是这样把关的——electron-builder 会自己在钥匙串里找到身份给它签名，所以机器上只要有证书（一张开发证书就够）就会签出一个带签名的 bundle；想让那台机器产出未签名的 bundle，用 `CSC_IDENTITY_AUTO_DISCOVERY=false`。发布流程从不依赖这种自动发现：`CSC_LINK` 明确指定 runner 用哪张证书。

**`v0.1.1` 及更早的发布会被拦，因为那些都还没签名。** 那些下载里没有签名、也没有公证，所以 Gatekeeper 会拒绝它。两种形状被拒的时刻不同，而 `.pkg` 在前：它在被打开时就受到评估，那时还没有任何 `Seek.app` 可以右键，所以属于「已装好的应用」的那条办法，选安装包的人照着做走不通。在已发布的 `v0.1.1` 那个 `.pkg` 上实测：`pkgutil --check-signature` 回答 `no signature`，`spctl -a -t install` 回答 `rejected`，理由是 `no usable signature`。下面这些是那些发布需要做的。

`.pkg` 要你把**下载下来的那个文件**上的标记清掉，然后再打开一次——或者在被拒之后的一小时内，进「系统设置 → 隐私与安全性」点**仍要打开**：

```bash
xattr -d com.apple.quarantine ~/Downloads/Seek-<版本>-arm64-mac.pkg
```

`.zip` 要动的则是应用本身：解压、把 `Seek.app` 拖进 `应用程序`，然后右键它选**打开**——或者清掉装好的那个包上的标记：

```bash
xattr -dr com.apple.quarantine /Applications/Seek.app
```

**签名之后，一个已签名的发布里还留着一处不对称。** Apple 给的票据是 stapling 到安装包上的，而 `.zip` 不是能贴上票据的东西：里面那个应用由同一张证书签名，但自己不带上票据，所以它第一次启动能不能过，取决于那台机器能不能连上 Apple。什么都不用处理的，是 `.pkg` 这一种形状。

**包里有什么、没有什么。** 内核在应用*里面*，不在旁边：`Contents/Resources/src/` 装的就是这个仓库里那 50 个 TypeScript 文件，`Contents/Resources/app.asar` 装的是构建好的页面和主进程（`docs/decisions.md` 默认值 26）。**包里没有模型、也没有权重**，所以不点名 `llama-server` 时，bot 用的仍是内核自带的占位句，和什么都不点名的 `npm start` 一模一样。**`v0.1.0` 及更早**是接模型之前打的，那些包里只有占位句；用这棵树构建出来的两段都接得上，靠的是下面那一节点名的那几个变量。首次启动造世界的方式也和下面那次运行一样——一个房间、它的 bot，以及库旁边的名册——而那个房间的 `created_at` 是内核的种子常量，不是你安装的那一刻，只是目前没有任何地方把它画出来。

应用把数据放在 Electron 自己给这个应用的 user-data 目录里，`SEEK_DATA_DIR` 可以指到别处。

## 跑界面

```bash
cd ui
npm install     # 只有第一次需要
npm run build
npm start
```

改页面本身的时候用 `npm run dev`：Vite 带着热更新把 `index.html` 服起来，再把 `SEEK_UI_DEV_URL` 设成那个服务器的地址——`http://localhost:5173`，也就是 `ui/vite.config.mjs` 不写端口时 Vite 自己用的那个——窗口打开的就是服出来的那一页，而不是构建好的那一页，于是改一行不必 `npm run build` 也能看见。

一个压在同一个内核上的 Electron 窗口：选房间、打字、按回车，那个房间里的 bot 就会回应。**要不要回应**是第一段，只要你点名一个模型它就是真模型：把 `SEEK_SERVER` 指向一个跑着的 `llama-server`，`SEEK_WINDOW` 写一次判断能读多少，判断就来自 watch 模型——由内核自己的 `watch-server.ts` 绑在那个服务器上，问的是 `src/prompts/watch-v1.json` 声明的那道题——于是它在自己判断该说话时才说，而不是每条都回。两个都不设（也就是这个构建发布时的样子），判断就是内核自带的占位实现，窗口顶上的一条窄带会说明你现在看的是哪一种。**回什么**是第二段，而且是另一个服务器：把 `SEEK_WORK_SERVER` 指向另一个 `llama-server`，那句话就是模型自己的文字，经由 `src/prompts/work-v1.json` 给它的 `say` 调用说出来——所以名册的 **work** 行必须声称那个服务器在服务的模型，因为一个服务器只服务一个模型，而两行可以各自点名（`docs/decisions.md` 默认值 24）。不设的话，说的就是 `src/main.ts` 里 `stubDecide` 的那句话。两段各要一个 origin 是刻意的，而 `SEEK_WINDOW` 仍跟着 `SEEK_SERVER`，因为它是「一次判断能读多少」，而一轮 turn 的提示词是每轮拿 work 服务器自己的窗口重新校验的。两条窄带各自独立拒绝，所以 watch 行有服务器、work 行没有的库照样打开，用占位实现回话，并且把两件事同时说出来。你点名了、应用却没有用上的服务器（连不上、服务的是另一个模型、或者只给了不成对的一个）不会挡住窗口打开：那条窄带会点名它，并用错误色说明原因——库在本地，里面的消息不依赖那个服务器（`docs/decisions.md` 默认值 27）。每条消息下面都有「reply in thread」：打开的面板就是库里已经记下的那条链，在面板里回复走的是同一个调用，只是点名了它在回应哪条消息。占位实现的回应仍然落在房间里而不是面板里，因为 `stubDecide` 说那句话时不点名它在回应什么；模型的回应则挂回叫醒它的那条消息，所以画在面板里。第一次启动时还没有库，于是它自己造一个：内核自带的那个房间、一个叫 Echo 的 bot，以及写在库旁边的 `agents.yml`——里面是这个 bot 说话要用的那两个 agent。所以窗口一打开就是能说话的地方，而不是一张空列表，那个文件此后也一直留在那里等着被改。它打开 Electron 自己的用户数据目录下的 `seek-data/seek.json`，用 `SEEK_DATA_DIR` 可以指到别处——想把仓库里的 `seek-data/`（连名册一起）打开，就是这么指。`npm run dist:mac` 构建的就是这个仓库发布的应用：electron-builder 把页面和主进程打成一个 arm64 应用包，放在 `ui/release/` 下；机器上有 `Developer ID Application` 身份就签名，没有就留成未签名（`docs/decisions.md` 默认值 26）。

## 跑原型

```bash
cd prototype
npm install     # 只有第一次需要
npm start
```

一个 Electron 桌面客户端，飞书式四栏布局：消息、话题、联系人、群组和账号。所有东西都存在本地（`~/Library/Application Support/Seek/seek-data/`），包括图片和文件附件。见 `prototype/README.md`。

## 两块地基

1. **消息是共享的事实，上下文是私有的解读。** 一个房间只有一份消息记录，但每个 agent 有自己的视角、记忆和花费。
2. **省下的钱发生在第一段。** 每一轮，agent 先用零成本规则和一次廉价判断决定要不要动作；只有判断为要，才进入真正的 agent 循环。不花钱的那一段，才是「永远活着」这件事付得起的原因。

## 资产

标志是一枚装着瞳孔的气泡 —— 它在说话，也在观察。`assets/icon.svg` 是唯一源文件；`node assets/render-icons.js` 从它重新生成全部 PNG。那个脚本除 Node 之外什么都不需要：它逐采样点判定图形、自己写出 PNG，因为图标足够简单，引入一个光栅化依赖的成本比省下的更多。

`assets/social-card.html` 是 1280×640 的链接预览图；`assets/render-social-card.js` 用原型自带的 Electron 二进制把它截成 PNG，因为文字排版是纯 Node 唯一做不了的事。

## 许可

MIT —— 见 `LICENSE`。原型的视觉样式是对飞书桌面端观感的参考性复刻；边界写在 `NOTICE.md`。
