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
        state = json.loads(row[0])
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
