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

## 4. 临时启动

```bash
HOST=0.0.0.0 PORT=3001 npm run start:prod
```

访问：

```text
http://服务器IP:3001
```

首次打开时，系统会要求初始化管理员账号：

1. 设置账号和密码，密码至少 8 位。
2. 系统生成 Google Authenticator 设置密钥。
3. 在 Google Authenticator 中选择手动输入密钥。
4. 使用账号、密码和 6 位动态验证码登录。

登录成功后，7 天内可自动登录。会话保存在服务端，浏览器只保存 HttpOnly Cookie。

## 5. 开放防火墙

如果 Ubuntu 开启了 ufw：

```bash
sudo ufw allow 3001/tcp
sudo ufw status
```

云服务器还需要在云平台安全组放行 TCP `3001`。

## 6. 配置 systemd 常驻运行

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

## 7. 更新版本

```bash
cd /opt/leased-line-ledger-system
git pull
npm install
npm run build
sudo systemctl restart leased-line
```

## 8. 数据说明

运行后会自动创建：

```text
data/ledger.db
uploads/
```

这些是运行期数据，不会进入 Git。跨设备迁移时默认不复制数据库；需要数据时建议在新服务器重新导入 Excel。

管理员账号、密码哈希、Google Authenticator 密钥和登录会话也保存在 `data/ledger.db` 中。因此不同服务器默认需要单独初始化管理员。
