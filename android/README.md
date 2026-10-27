# 专线台账 · Android 远程客户端

在安卓手机上访问已部署的专线台账系统。App 本身不保存业务数据，界面和登录（账号、密码、Google Authenticator）都来自服务器。

## 安全要点

- 只接受 `https://` 地址，明文 http 一律拒绝。
- 服务器用自签名证书时，首次连接会显示证书的 SHA-256 指纹，核对一致后点“信任并连接”；以后只接受这一张证书，证书变化会提示并停止连接。
- 服务器使用正式（受信任 CA 签发、域名匹配）证书时，按 Android 标准 HTTPS 校验，无需确认指纹。
- 只在 App 内打开服务器本身的页面；其他 https 链接交给手机浏览器。

查看服务器当前证书指纹（Windows PowerShell，在项目目录执行）：

```powershell
$c = New-Object System.Security.Cryptography.X509Certificates.X509Certificate2 (Resolve-Path certs\server.crt).Path
[BitConverter]::ToString([Security.Cryptography.SHA256]::Create().ComputeHash($c.RawData)).Replace('-', ':')
```

输出与 App 显示的指纹逐位一致即可。

## 获取 APK

由 GitHub Actions 云端构建（`.github/workflows/android-apk.yml`），触发方式：

- 推送 `android/` 下的改动到 `main`；
- 推送 `v*` 版本标签，APK 同时附加到该版本的 Release；
- 在仓库 Actions 页面选择 “Android APK” → “Run workflow” 手动运行。

完成后在该次运行页面底部 “Artifacts” 下载 APK（压缩包内即 `.apk`）。

## 签名密钥（只需配置一次）

在仓库 Settings → Secrets and variables → Actions 中添加：

| 名称 | 内容 |
| --- | --- |
| `ANDROID_KEYSTORE_BASE64` | 签名密钥文件的 Base64 |
| `ANDROID_KEYSTORE_PASSWORD` | 密钥库密码 |
| `ANDROID_KEY_ALIAS` | 密钥别名 |
| `ANDROID_KEY_PASSWORD` | 密钥密码 |

未配置时仍会生成可安装的 APK，但每次构建签名不同，新版本无法覆盖安装旧版本。签名密钥文件和密码不要提交到仓库，并妥善备份：丢失后已安装的 App 只能卸载重装。

## 手机端使用

1. 安装 APK（需在系统设置中允许“安装未知来源应用”）。
2. 输入服务器地址，例如 `https://192.168.1.20:3443`（Windows 本机）或云服务器的地址。
3. 核对证书指纹 → 信任并连接 → 用原账号、密码和验证码登录，7 天内免登录。
4. 导入 Excel 时从手机文件中选择；导出的 Excel 保存在“下载/专线台账”。
5. 在首页按返回键可退出、更换服务器或重新确认证书。

服务器在 Windows 本机时，手机需与电脑在同一网络，并在 Windows 防火墙中放行 TCP 3443 入站。

## 本地构建（可选）

安装 Android Studio（含 Android SDK 35），打开 `android/` 目录，或执行 `gradlew assembleRelease`。
