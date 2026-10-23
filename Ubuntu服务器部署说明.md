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
