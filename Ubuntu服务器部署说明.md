# Ubuntu 服务器部署说明

## 1. 准备环境

```bash
sudo apt update
sudo apt install -y git curl

curl -fsSL https://deb.nodesource.com/setup_24.x | sudo -E bash -
sudo apt install -y nodejs

node -v
npm -v
```

## 2. 拉取项目

```bash
sudo mkdir -p /opt/leased-line-ledger-system
sudo chown -R "$USER":"$USER" /opt/leased-line-ledger-system

git clone https://github.com/MagicalMiku39/LeasedLineManageSystem.git /opt/leased-line-ledger-system
cd /opt/leased-line-ledger-system
```

GitHub 仓库不包含业务数据库。首次部署后数据库为空，需要重新导入 Excel。

## 3. 安装依赖并初始化

```bash
npm install
npm run db:init
npm run build
```

## 4. 生成 HTTPS 自签名证书

如果你没有正式域名证书，可以先生成自签名证书：

```bash
mkdir -p certs

DNS_NAME=服务器IP或域名

openssl req -x509 -newkey rsa:2048 -nodes \
  -keyout certs/server.key \
  -out certs/server.crt \
  -days 1095 \
  -subj "/CN=${DNS_NAME}" \
  -addext "subjectAltName=DNS:${DNS_NAME},IP:${DNS_NAME},DNS:localhost"
```

自签名证书首次访问时浏览器会提示“不安全”，需要手动信任或继续访问。生产环境如有域名，建议后续换成正式 CA 证书。

## 5. 临时启动 HTTPS

```bash
HOST=0.0.0.0 \
PORT=3443 \
HTTP_REDIRECT_PORT=3001 \
HTTPS_KEY_FILE=certs/server.key \
HTTPS_CERT_FILE=certs/server.crt \
AUTH_COOKIE_SECURE=true \
npm run start:prod
```

访问：

```text
https://服务器IP:3443
```

首次打开时，系统会要求初始化管理员账号：

1. 设置账号和密码，密码至少 8 位。
2. 系统生成 Google Authenticator 设置密钥。
3. 在 Google Authenticator 中选择手动输入密钥。
4. 使用账号、密码和 6 位动态验证码登录。

登录成功后，7 天内可自动登录。会话保存在服务端，浏览器只保存 HttpOnly Cookie。

## 6. 开放防火墙

如果 Ubuntu 开启了 ufw：

```bash
sudo ufw allow 3443/tcp
sudo ufw allow 3001/tcp
sudo ufw status
```

云服务器还需要在云平台安全组放行 TCP `3443`。如果需要 HTTP 自动跳转 HTTPS，也放行 TCP `3001`。

## 7. 配置 systemd 常驻运行

```bash
sudo cp deploy/leased-line.service /etc/systemd/system/leased-line.service
sudo systemctl daemon-reload
sudo systemctl enable leased-line
sudo systemctl start leased-line
sudo systemctl status leased-line
```

查看日志：

```bash
journalctl -u leased-line -f
```

systemd 模板默认：

1. HTTPS 端口：`3443`
2. HTTP 跳转端口：`3001`
3. 证书路径：`/opt/leased-line-ledger-system/certs/server.crt`
4. 私钥路径：`/opt/leased-line-ledger-system/certs/server.key`

## 8. 更新版本

```bash
cd /opt/leased-line-ledger-system
git pull
npm install
npm run build
sudo systemctl restart leased-line
```

## 9. 数据说明

运行后会自动创建：

```text
data/ledger.db
uploads/
```

这些是运行期数据，不会进入 Git。跨设备迁移时默认不复制数据库；需要数据时建议在新服务器重新导入 Excel。

管理员账号、密码哈希、Google Authenticator 密钥和登录会话也保存在 `data/ledger.db` 中。因此不同服务器默认需要单独初始化管理员。

## 10. Agent Mail 邮件授权与抄送

同步代码后不能直接沿用 Windows 的邮箱授权。项目依赖包含腾讯官方 CLI，无需额外全局安装；需要在阿里云服务器上，以运行服务的同一用户及相同 HOME 环境完成一次 OAuth。

先检查实际运行用户：

```bash
sudo systemctl show leased-line -p User --value
```

若输出为空，表示使用仓库默认模板，由 root 运行。此时使用 `sudo -i` 后执行下面命令。若设为专用用户，应通过 `sudo -iu 实际用户名` 切换，勿混用不同用户的授权。

```bash
cd /opt/leased-line-ledger-system
npm ci
npm run build
npm run mail:login
npm run mail:status
```

执行登录后，复制 CLI 输出的完整授权链接，在自己电脑的浏览器中打开并完成授权；服务器无需图形浏览器。确认 `logged_in` 为 `true`。若登录失败或超时，先核查命令报错，不要连续重试。

使用同一服务用户编辑 `data/mail-settings.json`，示例仅展示格式，请替换为实际私有配置：

```json
{
  "defaultCc": ["copy@example.com"]
}
```

该文件在 Git 忽略目录中，需在新服务器单独配置；不要将本机 OAuth 凭据复制到服务器。设置文件权限后重启：

```bash
chmod 600 data/mail-settings.json
sudo systemctl restart leased-line
```

若服务提示未授权而终端已授权，检查 service 的 `User`、`HOME` 和运行环境是否与授权时一致。可通过 `sudo systemctl edit leased-line` 显式设置正确的 HOME，例如默认 root 用户为 `[Service]` 下的 `Environment=HOME=/root`，修改后执行 `sudo systemctl daemon-reload` 并重启。服务器需要能联网访问腾讯授权及邮件接口。

进入“运营中心 → 客户经理邮箱”重新配置客户经理收件邮箱（这些映射保存在本地数据库）。先预览，核对收件人及抄送后发送；“已提交发送”表示腾讯接受请求，实际投递情况以邮箱管理端为准。官方流程见 [Agent Mail CLI 接入文档](https://agent.qq.com/doc/cli-setup.md)。

## 11. 动态 IP 访问：设备证书端口

公司专线 IP 固定，继续用防火墙白名单访问 3443。IP 不固定的手机走单独的端口：该端口对外开放，但只接受持有本系统签发的设备证书的连接，没有证书连登录页都看不到；进入后仍需账号、密码和验证码。默认关闭，现有访问方式不受影响。

以下操作都在系统的 **设置** 页面完成，需要从公司网络打开系统。创建证书机构、保存端口设置和签发证书时，都要再输入一次 Google Authenticator 验证码。

1. **创建证书机构（只做一次）。** 文件保存在 `certs/client/`（已排除 Git，可用环境变量 `CLIENT_CERT_DIR` 指定其他目录）。其中 `ca.key` 可以签发新设备证书，所以目录不能放在 OneDrive 等云同步文件夹内，系统会拒绝创建。请单独备份；丢失后需要重新创建，所有设备都要重新导入。
2. **开启端口。** 在“访问端口”打开开关，填端口（如 `8443`）和证书默认有效天数后保存。保存后立即生效，无需重启，服务重启后也会按保存的设置自动开启。端口启动失败时页面会提示原因，3443 不受影响。
3. **放行防火墙和云平台安全组。** 页面改不了防火墙，需要另外操作，见下方命令。
4. **下发证书。** 在“下发证书”填设备名并签发，下载 `.p12` 文件并记下导入密码。文件和密码都只出现一次，服务器不保存，丢失后只能吊销并重新签发。把文件和密码分两条渠道发给使用人，对方在 App 中导入后删除文件。每台手机单独签发，不要共用同一份证书；证书到期前需要重新签发并导入。
5. **吊销。** 手机丢失或人员离职时，在“已下发的证书”里点吊销，下一个请求起生效，无需重启。

防火墙命令：TCP `8443` 对所有来源开放；TCP `3443` 只放行公司专线 IP。

```bash
sudo ufw allow 8443/tcp
sudo ufw delete allow 3443/tcp
sudo ufw allow from <公司专线IP> to any port 3443 proto tcp
```

先确认公司专线能访问 3443、手机能访问 8443，再收紧规则，避免把自己挡在外面。如果已经放行 TCP `3001` 的 HTTP 跳转，它也应同样只对公司 IP 开放，或者关闭。

**系统内置的防护：** 这个端口只接受 TLS 1.3，手机需要 Android 10 或以上。每个 IP 最多同时 20 个连接、每分钟 120 个新连接，超出的连接直接断开，一分钟内自动恢复；握手超过 10 秒未完成也会断开。登录或验证码连续错 5 次，来自同一 IP 或同一张设备证书的尝试锁定 15 分钟，到时自动解除，其他来源不受影响。

**防火墙层限速（建议）：** 上面的限制在系统内部生效，来自大量不同 IP 的冲击需要防火墙和云平台的 DDoS 防护来挡。不要用 `ufw limit`：它在 30 秒内超过 6 个连接就封 IP，而手机打开一次页面就可能开 6 个连接。可以在 `/etc/ufw/before.rules` 的 `COMMIT` 之前加入下面这行，再执行 `sudo ufw reload`：

```text
-A ufw-before-input -p tcp --dport 8443 --syn -m hashlimit --hashlimit-above 240/min --hashlimit-burst 120 --hashlimit-mode srcip --hashlimit-name ledger8443 -j DROP
```

端口不是 8443 时相应修改。改完先用手机确认仍能正常访问。

**安全日志：** 设置页底部可以查看登录成功和失败、锁定、设置页验证码错误、创建证书机构、端口设置、证书签发和吊销的记录，含时间、账号和来源（IP 或设备证书），保存在数据库 `security_log` 表，保留 180 天。不记录密码和验证码；账号不存在时不记录输入的账号名。握手阶段就被拒绝的连接和命令行操作不在其中。通过设备证书端口登录时不能查看。

**保持更新：** 这个端口对外开放后，TLS 层的漏洞发生在验证证书之前，请及时更新 Node.js 和系统安全补丁。手机请设置锁屏：登录状态保持 7 天，丢失后请立刻吊销证书。

**电脑浏览器使用证书（Windows）：** 为这台电脑单独签发一张证书，双击 `.p12` 文件，存储位置选“当前用户”，输入导入密码，不要勾选“标记此密钥为可导出”。证书存储**不要选“自动选择”**，选“将所有的证书都放入下列存储”，再选“个人”：放到“其他人”里浏览器找不到；自动选择还可能把证书机构装进受信任的根证书，那样这台电脑会信任它签发的任何网站证书。如果弹出“是否安装此根证书”，选“否”。完全关闭浏览器再打开，访问设备证书端口，在弹窗里选这张证书。v2.1.3 之前签发的证书在 Windows 上私钥无法使用（表现为 `ERR_BAD_SSL_CLIENT_AUTH_CERT`），需要吊销后重新签发；手机不受影响。

通过设备证书端口登录时，设置页只能查看，不能创建、签发或吊销。打不开页面时，可以在服务器项目目录下用命令行操作证书：

```bash
node server/scripts/client-cert.js init
node server/scripts/client-cert.js issue 张三手机 --days 180
node server/scripts/client-cert.js list
node server/scripts/client-cert.js revoke 张三手机
```

命令行签发的 `.p12` 文件保存在 `certs/client/issued/`，发出后请删除。
