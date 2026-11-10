"""存档版本守卫：python tests/test_save_version.py（无需启动服务）。"""

import json
import os
import sqlite3
import sys
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
DATA = tempfile.TemporaryDirectory()
os.environ["DATA_DIR"] = DATA.name
sys.path.insert(0, str(ROOT))

from fastapi.testclient import TestClient  # noqa: E402

from app import db  # noqa: E402
from app import main as api  # noqa: E402
from app.main import app  # noqa: E402

DB_PATH = Path(DATA.name) / "game.db"


def main():
    client = TestClient(app)
    response = client.post(
        "/api/register", json={"username": "futuresave123", "password": "test-pass-123"}
    )
    assert response.status_code == 200, response.text
    response = client.post("/api/story/advance", json={"skip": False})
    assert response.status_code == 200, response.text

    conn = sqlite3.connect(DB_PATH)
    try:
        row = conn.execute("SELECT state FROM saves").fetchone()
        assert row is not None, "注册后没有写入存档"
        original = json.loads(row[0])
        original.pop("schemaVersion", None)
        legacy_raw = json.dumps(original, ensure_ascii=False, sort_keys=True)
        conn.execute("UPDATE saves SET state = ?", (legacy_raw,))
        conn.commit()

        response = client.get("/api/state")
        assert response.status_code == 200, response.text
        backup = conn.execute(
            "SELECT state FROM save_backups ORDER BY id DESC LIMIT 1"
        ).fetchone()
        assert backup is not None and backup[0] == legacy_raw, "迁移前应备份旧存档"

        state = json.loads(conn.execute("SELECT state FROM saves").fetchone()[0])
        state["schemaVersion"] = 999
        state["futureField"] = "keep-me"
        raw = json.dumps(state, ensure_ascii=False, sort_keys=True)
        conn.execute("UPDATE saves SET state = ?", (raw,))
        conn.commit()

        response = client.get("/api/state")
        assert response.status_code == 500, response.text
        assert "存档无法读取" in response.text, response.text

        preserved = conn.execute("SELECT state FROM saves").fetchone()[0]
        assert preserved == raw, "无法读取的存档不应被改写"
        assert json.loads(preserved)["schemaVersion"] == 999
        assert json.loads(preserved)["futureField"] == "keep-me"

        # 并发保存使用版本号做乐观校验：旧快照不能覆盖新写入。
        user_id = conn.execute(
            "SELECT id FROM users WHERE username = 'futuresave123'"
        ).fetchone()[0]
        conn.execute("DELETE FROM saves")
        conn.commit()
        base = api._load_state(user_id)
        api._save_state(user_id, base)
        first = api._load_state(user_id)
        second = api._load_state(user_id)
        first["gold"] += 1
        api._save_state(user_id, first)
        try:
            api._save_state(user_id, second)
        except api.HTTPException as exc:
            assert exc.status_code == 409, exc
        else:
            raise AssertionError("过期版本写入应返回 409")

        # 缺失存档行时，保存操作应补回，而不是静默丢弃进度。
        conn.execute("DELETE FROM saves")
        conn.commit()
        response = client.post("/api/game/new", json={"confirm": True})
        assert response.status_code == 200, response.text
        assert conn.execute("SELECT 1 FROM saves").fetchone() is not None

        # 注册中途失败不能留下没有存档的账号。
        original = api._register_save

        def fail_save(user_id):
            raise RuntimeError("boom")

        api._register_save = fail_save
        try:
            try:
                client.post(
                    "/api/register",
                    json={"username": "orphan_check", "password": "password123"},
                )
            except RuntimeError:
                pass
            else:
                raise AssertionError("模拟注册失败应抛出异常")
        finally:
            api._register_save = original
        response = client.post(
            "/api/register",
            json={"username": "healthy_check", "password": "password123"},
        )
        assert response.status_code == 200, response.text
        names = [
            row[0]
            for row in conn.execute(
                "SELECT username FROM users WHERE username IN ('orphan_check', 'healthy_check')"
            )
        ]
        assert names == ["healthy_check"], "失败注册不应留下孤儿账号"

        # 战斗状态写入数据库：再次请求仍能恢复同一场战斗。
        battle_client = TestClient(app)
        response = battle_client.post(
            "/api/register", json={"username": "battlepersist", "password": "password123"}
        )
        assert response.status_code == 200, response.text
        for _ in range(40):
            state = battle_client.get("/api/state").json()["state"]
            if state["phase"] == "node":
                break
            assert state["phase"] in ("before_story", "after_story"), state
            response = battle_client.post("/api/story/advance", json={"skip": True})
            assert response.status_code == 200, response.text
        else:
            raise AssertionError("未能进入战斗节点")
        started = battle_client.post("/api/battle/start").json()["battle"]
        assert started and started["phase"] == "player"
        resumed = battle_client.post("/api/battle/start").json()["battle"]
        assert resumed["hand"] == started["hand"]
        assert resumed["board"] == started["board"]
        assert resumed["hp"] == started["hp"]
        unit = next(
            (
                card
                for card in resumed["hand"]
                if card["type"] == "unit"
                and card["cost"] <= resumed["energy"]
                and (card.get("width") or 1) == 1
            ),
            None,
        )
        if unit is not None:
            deployed = battle_client.post(
                "/api/battle/deploy", json={"uid": unit["uid"], "column": 1}
            )
            assert deployed.status_code == 200, deployed.text
            again = battle_client.post("/api/battle/start").json()["battle"]
            assert again["board"] == deployed.json()["battle"]["board"]
        battle_client.close()

        # 过期会话不能再读取存档。
        conn.execute("UPDATE sessions SET expires_at = 0")
        conn.commit()
        response = client.get("/api/state")
        assert response.status_code == 401, response.text
    finally:
        conn.close()

    client.close()
    if db._conn is not None:
        db._conn.close()
        db._conn = None
    DATA.cleanup()
    print("ok 未知未来版本存档被拒绝，数据库原记录保持不变")


if __name__ == "__main__":
    main()
