# LeasedLineManageSystem

专线台账管理系统，使用 React、Express 和 SQLite，支持台账导入、客户经理统计及集团收入分析。

## 本地运行

建议使用 Node.js 24。安装依赖后运行 `npm run build`，Windows 使用 `start-https.cmd`，Ubuntu 参考 `Ubuntu服务器部署说明.md`。默认 HTTPS 端口为 3443，首次使用需要设置账号及 Google Authenticator。

## 集团收入

1. 进入“集团收入”，点击顶部“导入 Excel”，上传 BOSS Excel 并检查收入预览，再确认导入。
2. 月份取报表“月份”列，默认最新已导入月份。客户经理默认选择现有 18 人，清空可查看全部。
3. 点击客户经理查看集团，点击集团查看产品收入、月度趋势、当前台账和核对信息。
4. 延伸服务在集团详情登记：报表已包含的服务不重复增加收入；报表未包含且已确认的收入按 6% 除税后单列补充。报表修订后需复核补录。

报表收入为信息化收入；台账资费为含税出账收入。专线卫士按 6%、其他产品按 9% 换算预计信息化收入。无历史快照、未完成产品映射时只提供当前台账推算，不能视为历史准确对账。金额使用原表单位。

KPI 开关影响关联台账的数量与预计金额，集团报表总收入不截断为 KPI 产品范围。专线延伸服务独立展示，不增加专线数量。

## 欠费预警邮件

1. 依赖中包含腾讯官方 `@tencent-qqmail/agently-cli`，执行 `npm install` 或 `npm ci` 一并安装对应平台的 CLI。
2. 在**运行系统服务的同一操作系统账户**下执行 `npm run mail:login`，打开命令输出的原始链接完成 OAuth；用 `npm run mail:status` 查看授权状态。Windows PowerShell 使用 `npm.cmd`。Ubuntu systemd 的运行用户需单独授权，OpenClaw 或另一台电脑中的授权不会自动迁移。
3. 进入“运营中心 → 客户经理邮箱”，选择经理、填写收件邮箱并保存。优先使用台账工号匹配，没有工号时才使用姓名；相同姓名但工号不同的经理需分别设置。
4. 点击专线条目的“提醒”，核对收件人、报告主题和欠费明细后点击“发送报告”。每封报告仅包含当前这一条专线，提交成功才将条目标为提醒。“已提交发送”表示腾讯接受发送请求，不等于收件人已收到或阅读。
5. 预览 15 分钟有效。邮箱、专线信息变更时需重新预览；相同报告成功提交后不重复发送。失败或结果待核实时可查看最近发送记录，再通过 [Agent Mail 管理端](https://agent.qq.com) 核实。系统不会自动重发不确定的请求。
6. 所有预警邮件强制带默认抄送，地址仅配置在服务器 `data/mail-settings.json` 的 `defaultCc` 数组中，不写入源码。也可通过 `WARNING_MAIL_CC` 环境变量配置（多个地址用分号分隔），或用 `AGENT_MAIL_SETTINGS_FILE` 指定其他本地配置文件。配置缺失或无效时拒绝发送，预览会展示抄送对象；配置变更后需重新预览。

安装及授权参考[腾讯官方接入文档](https://agent.qq.com/doc/cli-setup.md)。OAuth 凭据由 CLI 保存在服务账户环境，项目不读取或复制令牌；客户经理邮箱与发送记录保存在 SQLite 中。迁移或发布代码时继续排除这些本地数据与授权凭据。

## Android 客户端

`android/` 是安卓远程客户端：在 App 内填写服务器的 HTTPS 地址，首次连接核对证书 SHA-256 指纹后访问，只允许 HTTPS。APK 由 GitHub Actions（`.github/workflows/android-apk.yml`）云端构建，签名密钥通过仓库 Secrets 提供。详见 [android/README.md](android/README.md)。

## 验证与数据

运行 `npm test` 与 `npm run build`。测试使用独立临时数据库。`data/`、`uploads/`、`certs/` 与浏览器验证截图均排除 Git，不随代码发布业务数据。
