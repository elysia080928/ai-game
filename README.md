# 机偶回路 · MVP

单人肉鸽卡牌 + 视觉小说的最小可玩版本。固定路线：**战斗 1 → 招募 → 奇遇 → 战斗 2 → 完成画面**。

- 前端：原生 HTML / CSS / JavaScript（`static/`）
- 后端：Python + FastAPI（`app/`），战斗、金币、招募、奇遇、剧情与存档都由服务端结算
- 数据：SQLite 保存账号与存档；卡牌、敌人、遭遇、节点与剧情在 `content/game.json`

## 本地运行

```bash
pip install -r requirements.txt
uvicorn app.main:app --reload
```

打开 <http://127.0.0.1:8000>，注册账号即可开始。数据库默认写入 `data/game.db`（已被 `.gitignore` 忽略）。

## 测试

```bash
python tests/test_rules.py
```

覆盖起手保底、高费锁定、回合能量、回收返能、指令目标校验、超限弃牌、战斗终止、招募仅一次、金币不足、奇遇仅一次、剧情推进与新局重置。

启动服务后还可以运行端到端测试：

```bash
python tests/e2e_smoke.py     # API 流程、越权、重复提交、账号隔离
node tests/ui_smoke.js        # 无头 Edge 界面流程（需本机安装 Edge）
```

## Docker

```bash
docker build -t ai-game-mvp .
docker run -p 7860:7860 -v $(pwd)/data:/app/data ai-game-mvp
```

镜像默认监听 `PORT=7860`（可用环境变量覆盖），数据目录为 `DATA_DIR=/app/data`。

## 部署到魔搭创空间

- 端口按平台要求使用 7860；启动命令由 Dockerfile 提供。
- 必须把 `/app/data` 挂到平台提供的持久化目录；平台若不提供持久化卷，容器重启或重新部署后账号与存档可能丢失。部署前需要在平台上核实容器文件系统与卷的实际行为，本仓库不做持久性保证。
- 平台提供 HTTPS 时设置 `COOKIE_SECURE=1`，让会话 Cookie 只走加密连接。

## MVP 规则要点

- 双方 4 列、领袖 15 生命；玩家结束后从左到右攻击，敌方按预告计划部署并攻击。
- 首回合 4 能量，之后每回合 +2 且可保留；回收返还 `max(1, 实际支付 // 2)`。
- 起手 6 张（≥4 张费用≤2、≥1 张低费单位），之后每回合抽 2 张；6 费牌第 3 回合起可抽；牌堆耗尽不洗回。
- 手牌超过 10 张时先抽完，再由玩家选择弃牌；单场每张卡只能使用一次。
- 战斗 1 胜利 +20 金币；招募固定报价、最多购买一次；奇遇使一张已有单位本趟攻击 +1。
- 每节点有前置/后置占位剧情，可跳过整段；节点结果不可跳过，结算后保存。

## 目录

```
app/        FastAPI 入口、战斗规则、冒险流程、数据库与鉴权
content/    卡牌 / 敌人 / 遭遇 / 招募 / 剧情配置
static/     前端页面、样式与逻辑
tests/      规则自检脚本
```
