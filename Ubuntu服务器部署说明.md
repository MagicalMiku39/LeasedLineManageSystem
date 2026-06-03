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

