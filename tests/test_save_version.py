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
from app import game as game_data

DB_PATH = Path(DATA.name) / "game.db"


def enter_start_battle(client):
    for _ in range(40):
        state = client.get("/api/state").json()["state"]
        if state["phase"] == "node":
            return state
        if state["phase"] == "map":
            start_id = state["node"]["id"]
            assert state["map"]["available"] == [start_id], state["map"]
            response = client.post("/api/map/select", json={"nodeId": start_id})
        elif state["phase"] == "transition":
            response = client.post("/api/story/advance", json={"transition": True})
        else:
            assert state["phase"] in ("map_story", "before_story", "after_story"), state
            response = client.post("/api/story/advance", json={"skip": True})
        assert response.status_code == 200, response.text
    raise AssertionError("未能进入起点战斗节点")

# Seed a real v1 schema before importing the app so startup exercises the upgrade path.
legacy = sqlite3.connect(DB_PATH)
legacy.executescript("""
CREATE TABLE users (id INTEGER PRIMARY KEY AUTOINCREMENT, username TEXT UNIQUE NOT NULL, password_hash TEXT NOT NULL, created_at REAL NOT NULL);
CREATE TABLE sessions (token_hash TEXT PRIMARY KEY, user_id INTEGER NOT NULL, expires_at REAL NOT NULL);
CREATE TABLE saves (user_id INTEGER PRIMARY KEY, state TEXT NOT NULL, revision INTEGER NOT NULL DEFAULT 1, updated_at REAL NOT NULL);
CREATE TABLE save_backups (id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER NOT NULL, state TEXT NOT NULL, created_at REAL NOT NULL);
CREATE TABLE battles (user_id INTEGER PRIMARY KEY, state TEXT NOT NULL, updated_at REAL NOT NULL);
PRAGMA user_version=1;
""")
legacy.execute("INSERT INTO users VALUES (900, 'migration_fixture', 'unused', 1)")
legacy_state = json.dumps(game_data.new_state(), ensure_ascii=False)
legacy.execute("INSERT INTO saves VALUES (900, ?, 7, 11)", (legacy_state,))
legacy.execute("INSERT INTO save_backups VALUES (1, 900, 'legacy-backup', 10)")
legacy.execute("INSERT INTO battles VALUES (900, 'legacy-battle', 12)")
legacy.commit()
legacy.close()

from fastapi.testclient import TestClient  # noqa: E402

from app import db  # noqa: E402
from app import main as api  # noqa: E402
from app.main import app  # noqa: E402

def test_save_version():
    migrated = sqlite3.connect(DB_PATH)
    assert migrated.execute("PRAGMA user_version").fetchone()[0] == 2
    assert migrated.execute("SELECT state, revision, updated_at FROM save_slots WHERE user_id=900 AND slot_id=1").fetchone() == (legacy_state, 7, 11)
    assert migrated.execute("SELECT state, updated_at FROM battle_slots WHERE user_id=900 AND slot_id=1").fetchone() == ("legacy-battle", 12)
    assert migrated.execute("SELECT slot_id, state FROM save_backups WHERE user_id=900").fetchone() == (1, "legacy-backup")
    assert migrated.execute("SELECT COUNT(*) FROM saves").fetchone()[0] == 0
    assert migrated.execute("SELECT COUNT(*) FROM battles").fetchone()[0] == 0
    migrated.close()
    restored, changed = api.game.migrate_state(json.loads(api.db.conn().execute(
        "SELECT state FROM save_slots WHERE user_id=900 AND slot_id=1"
    ).fetchone()[0]))
    assert not changed and api.game.public_state(restored)["phase"] == "map_story"
    client = TestClient(app)
    response = client.post(
        "/api/register", json={"username": "futuresave123", "password": "test-pass-123"}
    )
    assert response.status_code == 200, response.text
    assert response.json()["state"]["phase"] == "map_story"
    assert client.post("/api/battle/start").status_code == 400
    response = client.post("/api/story/advance", json={"skip": False})
    assert response.status_code == 200, response.text
    saved_opening = client.get("/api/state").json()["state"]
    assert saved_opening["phase"] == "map_story" and saved_opening["story"]["line"] == 2
    response = client.post("/api/story/advance", json={"skip": True})
    assert response.status_code == 200 and response.json()["state"]["phase"] == "transition"
    assert response.json()["state"]["transitionTarget"] == "map"
    premature = client.post("/api/story/advance", json={"skip": True})
    assert premature.status_code == 400
    assert client.get("/api/state").json()["state"]["phase"] == "transition"
    response = client.post("/api/story/advance", json={"transition": True})
    assert response.status_code == 200 and response.json()["state"]["phase"] == "map"
    assert response.json()["state"]["map"]["available"] == [response.json()["state"]["node"]["id"]]
    assert client.post("/api/battle/start").status_code == 400
    start_id = response.json()["state"]["node"]["id"]
    selected = client.post("/api/map/select", json={"nodeId": start_id})
    assert selected.status_code == 200 and selected.json()["state"]["phase"] == "before_story"

    conn = sqlite3.connect(DB_PATH)
    try:
        user_id = conn.execute("SELECT id FROM users WHERE username = 'futuresave123'").fetchone()[0]
        row = conn.execute("SELECT state FROM save_slots WHERE user_id = ? AND slot_id = 1", (user_id,)).fetchone()
        assert row is not None, "注册后没有写入存档"
        slots = client.get("/api/save-slots").json()["slots"]
        assert len(slots) == 3 and [slot["empty"] for slot in slots] == [False, True, True]
        invalid_slot = client.post("/api/game/new", json={"slotId": True, "confirm": True})
        assert invalid_slot.status_code == 422, invalid_slot.text
        no_confirmation = client.post("/api/game/new", json={"slotId": 1, "confirm": False})
        assert no_confirmation.status_code == 400, no_confirmation.text
        original = json.loads(row[0])
        original.pop("schemaVersion", None)
        legacy_raw = json.dumps(original, ensure_ascii=False, sort_keys=True)
        conn.execute("UPDATE save_slots SET state = ? WHERE user_id = ? AND slot_id = 1", (legacy_raw, user_id))
        conn.commit()

        response = client.get("/api/state")
        assert response.status_code == 200, response.text
        backup = conn.execute(
            "SELECT state FROM save_backups WHERE user_id = ? AND slot_id = 1 ORDER BY id DESC LIMIT 1", (user_id,)
        ).fetchone()
        assert backup is not None and backup[0] == legacy_raw, "迁移前应备份旧存档"

        state = json.loads(conn.execute("SELECT state FROM save_slots WHERE user_id = ? AND slot_id = 1", (user_id,)).fetchone()[0])
        state["schemaVersion"] = 999
        state["futureField"] = "keep-me"
        raw = json.dumps(state, ensure_ascii=False, sort_keys=True)
        conn.execute("UPDATE save_slots SET state = ? WHERE user_id = ? AND slot_id = 1", (raw, user_id))
        conn.commit()

        response = client.get("/api/state")
        assert response.status_code == 500, response.text
        assert "存档无法读取" in response.text, response.text
        overwrite = client.post("/api/game/new", json={"slotId": 1, "confirm": True})
        assert overwrite.status_code == 500, overwrite.text

        preserved = conn.execute("SELECT state FROM save_slots WHERE user_id = ? AND slot_id = 1", (user_id,)).fetchone()[0]
        assert preserved == raw, "无法读取的存档不应被改写"
        assert json.loads(preserved)["schemaVersion"] == 999
        assert json.loads(preserved)["futureField"] == "keep-me"

        # 并发保存使用版本号做乐观校验：旧快照不能覆盖新写入。
        conn.execute("DELETE FROM save_slots WHERE user_id = ? AND slot_id = 1", (user_id,))
        conn.commit()
        base = api.game.new_state()
        api._save_state(user_id, base, 1)
        first = api._load_state(user_id, 1)
        second = api._load_state(user_id, 1)
        first["gold"] += 1
        api._save_state(user_id, first, 1)
        try:
            api._save_state(user_id, second, 1)
        except api.HTTPException as exc:
            assert exc.status_code == 409, exc
        else:
            raise AssertionError("过期版本写入应返回 409")

        # 缺失存档行时，保存操作应补回，而不是静默丢弃进度。
        conn.execute("DELETE FROM save_slots WHERE user_id = ? AND slot_id = 1", (user_id,))
        conn.commit()
        response = client.post("/api/game/new", json={"confirm": False})
        assert response.status_code == 200, response.text
        assert conn.execute("SELECT 1 FROM save_slots WHERE user_id = ? AND slot_id = 1", (user_id,)).fetchone() is not None

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
        state = enter_start_battle(battle_client)
        started = battle_client.post("/api/battle/start").json()["battle"]
        assert started and started["phase"] == "player"
        resumed = battle_client.post("/api/battle/start").json()["battle"]
        assert resumed["hand"] == started["hand"]
        assert resumed["board"] == started["board"]
        assert resumed["hp"] == started["hp"]
        assert resumed["tutorial"]["index"] == 0

        # A second login gets the account's latest slot, while the already-open session stays on slot 1.
        second_session = TestClient(app)
        login = second_session.post(
            "/api/login", json={"username": "battlepersist", "password": "password123"}
        )
        assert login.status_code == 200
        assert second_session.get("/api/save-slots").json()["activeSlot"] == 1
        response = second_session.post("/api/game/new", json={"slotId": 2})
        assert response.status_code == 200, response.text
        assert second_session.get("/api/save-slots").json()["activeSlot"] == 2
        third_session = TestClient(app)
        assert third_session.post(
            "/api/login", json={"username": "battlepersist", "password": "password123"}
        ).status_code == 200
        assert third_session.get("/api/save-slots").json()["activeSlot"] == 2
        third_session.close()
        enter_start_battle(second_session)
        assert second_session.post("/api/battle/start").status_code == 200
        assert battle_client.get("/api/state").json()["state"] == state
        assert battle_client.post("/api/battle/start").json()["battle"] == resumed
        assert conn.execute(
            "SELECT 1 FROM battle_slots WHERE user_id = (SELECT id FROM users WHERE username='battlepersist') AND slot_id=1"
        ).fetchone() is not None
        assert conn.execute(
            "SELECT 1 FROM save_slots WHERE user_id = (SELECT id FROM users WHERE username='battlepersist') AND slot_id=2"
        ).fetchone() is not None
        deleted = second_session.delete("/api/save-slots/2")
        assert deleted.status_code == 200, deleted.text
        assert deleted.json()["slots"][1]["empty"] is True
        assert deleted.json()["activeSlot"] == 1
        assert conn.execute(
            "SELECT 1 FROM save_slots WHERE user_id = (SELECT id FROM users WHERE username='battlepersist') AND slot_id=1"
        ).fetchone() is not None
        assert conn.execute(
            "SELECT 1 FROM battle_slots WHERE user_id = (SELECT id FROM users WHERE username='battlepersist') AND slot_id=2"
        ).fetchone() is None
        assert battle_client.post("/api/battle/start").json()["battle"] == resumed
        second_session.close()
        rejected = battle_client.post("/api/battle/end")
        assert rejected.status_code == 400, rejected.text
        assert battle_client.post("/api/battle/start").json()["battle"] == resumed
        response = battle_client.post("/api/battle/tutorial", json={})
        assert response.status_code == 200, response.text
        resumed = response.json()["battle"]
        unit = next(c for c in resumed["hand"] if c["cardId"] == "shell")
        response = battle_client.post("/api/battle/deploy", json={"uid": unit["uid"], "column": 2})
        assert response.status_code == 200, response.text
        saved = response.json()["battle"]
        assert saved["tutorial"]["index"] == 2
        assert battle_client.post("/api/battle/start").json()["battle"] == saved
        response = battle_client.post("/api/battle/deploy", json={"uid": unit["uid"], "column": 2})
        assert response.status_code == 400
        assert battle_client.post("/api/battle/start").json()["battle"] == saved
        assert battle_client.post("/api/battle/retry").json()["battle"] == started
        response = battle_client.post("/api/battle/tutorial", json={"skip": True})
        assert response.status_code == 200, response.text
        resumed = response.json()["battle"]
        assert resumed["tutorial"] is None
        assert battle_client.post("/api/battle/start").json()["battle"]["tutorial"] is None
        battle_user_id = conn.execute(
            "SELECT id FROM users WHERE username = 'battlepersist'"
        ).fetchone()[0]
        stored = json.loads(conn.execute(
            "SELECT state FROM battle_slots WHERE user_id = ? AND slot_id = 1", (battle_user_id,)
        ).fetchone()[0])
        uid = max([card["uid"] for card in stored["hand"]] + [9000]) + 1
        stored["hand"].append(
            {"uid": uid, "cardId": "twin_rail", "level": 1, "atkBonus": 0, "hpBonus": 0}
        )
        stored["next_uid"] = max(stored.get("next_uid", 1), uid + 1)
        conn.execute(
            "UPDATE battle_slots SET state = ? WHERE user_id = ? AND slot_id = 1",
            (json.dumps(stored, ensure_ascii=False), battle_user_id),
        )
        conn.commit()
        resumed = battle_client.post("/api/battle/start").json()["battle"]
        twin_rail = next(card for card in resumed["hand"] if card["cardId"] == "twin_rail")
        deployed = battle_client.post(
            "/api/battle/deploy", json={"uid": twin_rail["uid"], "column": 1}
        )
        assert deployed.status_code == 200, deployed.text
        assert deployed.json()["battle"]["board"]["player"][0]["uid"] == deployed.json()["battle"]["board"]["player"][1]["uid"]
        recycled = battle_client.post("/api/battle/recycle", json={"column": 1})
        assert recycled.status_code == 200, recycled.text
        assert recycled.json()["battle"]["board"]["player"][:2] == [None, None], "跨请求回收双轨机偶应释放两格"

        battle_user_id = conn.execute(
            "SELECT id FROM users WHERE username = 'battlepersist'"
        ).fetchone()[0]
        broken = json.loads(conn.execute(
            "SELECT state FROM battle_slots WHERE user_id = ? AND slot_id = 1", (battle_user_id,)
        ).fetchone()[0])
        broken["board"]["player"][1] = deployed.json()["battle"]["board"]["player"][1]
        conn.execute(
            "UPDATE battle_slots SET state = ? WHERE user_id = ? AND slot_id = 1",
            (json.dumps(broken, ensure_ascii=False), battle_user_id),
        )
        conn.commit()
        repaired = battle_client.post("/api/battle/start").json()["battle"]
        assert repaired["board"]["player"][:2] == [None, None], "旧存档遗留的宽体幽灵格应被清除"
        stored = json.loads(conn.execute(
            "SELECT state FROM battle_slots WHERE user_id = ? AND slot_id = 1", (battle_user_id,)
        ).fetchone()[0])
        assert stored["board"]["player"][:2] == [None, None], "旧占位修复后应立即写回存档"

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

        # 战败后重置战斗也必须移除补给挑战压力。
        reset_client = TestClient(app)
        response = reset_client.post(
            "/api/register", json={"username": "challengereset", "password": "password123"}
        )
        assert response.status_code == 200, response.text
        enter_start_battle(reset_client)
        assert reset_client.post("/api/battle/start").status_code == 200
        reset_user_id = conn.execute(
            "SELECT id FROM users WHERE username = 'challengereset'"
        ).fetchone()[0]
        reset_state = json.loads(conn.execute(
            "SELECT state FROM save_slots WHERE user_id = ? AND slot_id = 1", (reset_user_id,)
        ).fetchone()[0])
        reset_state["pendingChallenges"] = [{"id": "supply_energy", "rewardSeed": 1}]
        conn.execute(
            "UPDATE save_slots SET state = ? WHERE user_id = ? AND slot_id = 1",
            (json.dumps(reset_state, ensure_ascii=False), reset_user_id),
        )
        reset_battle = json.loads(conn.execute(
            "SELECT state FROM battle_slots WHERE user_id = ? AND slot_id = 1", (reset_user_id,)
        ).fetchone()[0])
        reset_battle["phase"] = "over"
        reset_battle["result"] = "lose"
        conn.execute(
            "UPDATE battle_slots SET state = ? WHERE user_id = ? AND slot_id = 1",
            (json.dumps(reset_battle, ensure_ascii=False), reset_user_id),
        )
        conn.commit()
        response = reset_client.post("/api/battle/reset")
        assert response.status_code == 200, response.text
        assert response.json()["state"]["pendingChallenge"] is None
        assert response.json()["battle"]["energy"] == 4
        stored = json.loads(conn.execute(
            "SELECT state FROM save_slots WHERE user_id = ? AND slot_id = 1", (reset_user_id,)
        ).fetchone()[0])
        assert stored["pendingChallenges"] == []
        lost = json.loads(conn.execute(
            "SELECT state FROM battle_slots WHERE user_id = ? AND slot_id = 1", (reset_user_id,)
        ).fetchone()[0])
        lost["phase"] = "over"
        lost["result"] = "lose"
        conn.execute(
            "UPDATE battle_slots SET state = ? WHERE user_id = ? AND slot_id = 1",
            (json.dumps(lost, ensure_ascii=False), reset_user_id),
        )
        conn.commit()
        returned = reset_client.post("/api/battle/return")
        assert returned.status_code == 200, returned.text
        assert returned.json()["state"]["phase"] == "map"
        assert returned.json()["state"]["completed"] == []
        assert returned.json()["state"]["gold"] == 0
        assert returned.json()["state"]["map"]["available"] == [returned.json()["state"]["node"]["id"]]
        assert returned.json()["battle"] is None
        assert reset_client.get("/api/state").json()["state"]["phase"] == "map"
        assert reset_client.post("/api/battle/return").status_code == 400
        assert reset_client.post("/api/battle/start").status_code == 400
        reset_client.close()

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
    print("ok v1 存档迁移、未来版本保护和会话槽位隔离")


if __name__ == "__main__":
    test_save_version()
