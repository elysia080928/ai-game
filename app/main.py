"""FastAPI 入口：账号、存档、节点流程与战斗接口。"""

import json
import os
import random
import re
import time
from pathlib import Path

from fastapi import Depends, FastAPI, HTTPException, Request, Response
from fastapi.responses import JSONResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field, StrictInt

from . import auth, db, game
from . import battle as B

USERNAME_RE = re.compile(r"^[A-Za-z0-9_]{3,20}$")
COOKIE_SECURE = os.environ.get("COOKIE_SECURE", "0") == "1"
TRUST_PROXY = os.environ.get("TRUST_PROXY", "0") == "1"
MAX_BODY_BYTES = 64 * 1024
STATIC_DIR = Path(__file__).resolve().parent.parent / "static"
THIRD_CHAPTER_LABEL = f"{game.map_meta('map3')['chapter']} · {game.map_meta('map3')['title']}"
CG_CATALOG = (
    {"id": "opening_sky", "title": "晴空伸手", "chapter": "序章", "path": "cg/晴空伸手.png"},
    {"id": "campfire_stars", "title": "篝火星河", "chapter": THIRD_CHAPTER_LABEL, "path": "cg/篝火星河.png"},
    {"id": "campfire_woods", "title": "林间篝火", "chapter": THIRD_CHAPTER_LABEL, "path": "cg/林间篝火.png"},
    {"id": "campfire_knees", "title": "篝火抱膝", "chapter": THIRD_CHAPTER_LABEL, "path": "cg/篝火抱膝.png"},
    {"id": "campfire_warm", "title": "篝火暖手", "chapter": THIRD_CHAPTER_LABEL, "path": "cg/篝火暖手.png"},
    {"id": "boss_warning", "title": "档案警报", "chapter": THIRD_CHAPTER_LABEL, "path": "cg/cg-dungeon-warning-turn-v2.png"},
)
CG_BY_ID = {item["id"]: item for item in CG_CATALOG}
CG_BY_PATH = {item["path"]: item["id"] for item in CG_CATALOG}

app = FastAPI(title="若你坠入记忆之海")
db.init()


@app.middleware("http")
async def guard_requests(request: Request, call_next):
    length = request.headers.get("content-length")
    if length is not None:
        try:
            too_large = int(length) > MAX_BODY_BYTES
        except ValueError:
            too_large = True
        if too_large:
            return JSONResponse(status_code=413, content={"detail": "请求体过大"})
    if request.method == "POST":
        try:
            auth.rate_limit(f"post:{_client_ip(request)}", 600, 60)
        except HTTPException as exc:
            return JSONResponse(status_code=exc.status_code, content={"detail": exc.detail})
    return await call_next(request)


class AuthBody(BaseModel):
    username: str = Field(max_length=64)
    password: str = Field(max_length=256)


class StoryBody(BaseModel):
    skip: bool = False
    transition: bool = False


class CgUnlockBody(BaseModel):
    cgId: str = Field(min_length=1, max_length=64)


class DeployBody(BaseModel):
    uid: int
    column: int


class CommandBody(BaseModel):
    uid: int
    targetUid: int


class RecycleBody(BaseModel):
    column: int


class DiscardBody(BaseModel):
    uids: list[int]


class RecruitBody(BaseModel):
    offerId: str


class AdventureBody(BaseModel):
    cardId: str
    effect: str
    cardUid: str | None = None


class CalibrationBody(BaseModel):
    cardId: str
    effect: str
    cardUid: str | None = None


class RecycleCardBody(BaseModel):
    cardId: str
    cardUid: str | None = None


class DriftChooseBody(BaseModel):
    cardId: str
    cardUid: str | None = None


class EliteRewardBody(BaseModel):
    cardId: str


class ShopBuyBody(BaseModel):
    offerId: str
    cardUid: str | None = None


class TrialChooseBody(BaseModel):
    trialId: str


class SupplyChooseBody(BaseModel):
    round: StrictInt
    cardId: str


class SupplySkipBody(BaseModel):
    round: StrictInt


class SupplySwapBody(BaseModel):
    cardId: str
    payment: str
    removeUid: str | None = None


class SupplyChallengeBody(BaseModel):
    challengeId: str


class TrainingChooseBody(BaseModel):
    challengeId: str


class RelayBody(BaseModel):
    choice: str


class SignalBody(BaseModel):
    action: str
    cardId: str
    cardUid: str | None = None


class MapSelectBody(BaseModel):
    nodeId: str


class StoryChooseBody(BaseModel):
    optionId: str


class NewGameBody(BaseModel):
    confirm: bool = False
    slotId: StrictInt | None = None


@app.exception_handler(B.GameError)
def game_error_handler(request: Request, exc: B.GameError):
    return JSONResponse(status_code=400, content={"detail": str(exc)})


def current_user(request: Request):
    user = auth.user_from_request(request)
    if user is None:
        raise HTTPException(status_code=401, detail="未登录")
    return user


def _valid_slot(slot_id):
    if not isinstance(slot_id, int) or isinstance(slot_id, bool) or not 1 <= slot_id <= 3:
        raise B.GameError("存档槽位无效")
    return slot_id


def _load_state(user_id, slot_id):
    row = db.conn().execute(
        "SELECT state, revision FROM save_slots WHERE user_id = ? AND slot_id = ?",
        (user_id, slot_id),
    ).fetchone()
    if row is None:
        raise B.GameError("该存档槽为空")
    try:
        state, changed = game.migrate_state(json.loads(row["state"]))
    except (ValueError, B.GameError, KeyError, TypeError, AttributeError):
        raise HTTPException(status_code=500, detail="存档无法读取，已保留原数据")
    state["_rev"] = row["revision"]
    if changed:
        conn = db.conn()
        conn.execute(
            "INSERT INTO save_backups(user_id, slot_id, state, created_at) VALUES (?, ?, ?, ?)",
            (user_id, slot_id, row["state"], time.time()),
        )
        conn.execute(
            """DELETE FROM save_backups WHERE user_id = ? AND id NOT IN (
                SELECT id FROM save_backups WHERE user_id = ? AND slot_id = ? ORDER BY id DESC LIMIT 5
            ) AND slot_id = ?""",
            (user_id, user_id, slot_id, slot_id),
        )
        conn.commit()
        _save_state(user_id, state, slot_id)
    return state


def _save_state(user_id, state, slot_id):
    payload = dict(state)
    expected = payload.pop("_rev", None)
    encoded = json.dumps(payload, ensure_ascii=False)
    conn = db.conn()
    if expected is None:
        cursor = conn.execute(
            "UPDATE save_slots SET state = ?, revision = revision + 1, updated_at = ? WHERE user_id = ? AND slot_id = ?",
            (encoded, time.time(), user_id, slot_id),
        )
    else:
        cursor = conn.execute(
            "UPDATE save_slots SET state = ?, revision = revision + 1, updated_at = ? WHERE user_id = ? AND slot_id = ? AND revision = ?",
            (encoded, time.time(), user_id, slot_id, expected),
        )
    if cursor.rowcount == 0:
        if expected is not None:
            conn.rollback()
            raise HTTPException(status_code=409, detail="存档已被其他请求更新，请刷新后重试")
        conn.execute(
            "INSERT INTO save_slots(user_id, slot_id, state, revision, updated_at) VALUES (?, ?, ?, 1, ?)",
            (user_id, slot_id, encoded, time.time()),
        )
    conn.commit()
    if expected is not None:
        state["_rev"] = expected + 1


def _load_battle(user_id, slot_id):
    row = db.conn().execute(
        "SELECT state FROM battle_slots WHERE user_id = ? AND slot_id = ?", (user_id, slot_id)
    ).fetchone()
    if row is None:
        return None
    try:
        battle_state = json.loads(row["state"])
    except (ValueError, TypeError, AttributeError):
        _clear_battle(user_id, slot_id)
        return None
    repaired = B.repair_board(battle_state)
    migrated = B.repair_forecast_timing(battle_state)
    if repaired or migrated:
        _store_battle(user_id, battle_state, slot_id)
    return battle_state


def _store_battle(user_id, battle_state, slot_id):
    conn = db.conn()
    now = time.time()
    conn.execute(
        """INSERT INTO battle_slots(user_id, slot_id, state, updated_at) VALUES (?, ?, ?, ?)
        ON CONFLICT(user_id, slot_id) DO UPDATE SET state = excluded.state, updated_at = excluded.updated_at""",
        (user_id, slot_id, json.dumps(battle_state, ensure_ascii=False), now),
    )
    conn.execute(
        "UPDATE save_slots SET updated_at = ? WHERE user_id = ? AND slot_id = ?",
        (now, user_id, slot_id),
    )
    conn.commit()


def _clear_battle(user_id, slot_id):
    conn = db.conn()
    conn.execute("DELETE FROM battle_slots WHERE user_id = ? AND slot_id = ?", (user_id, slot_id))
    conn.commit()


def _client_ip(request):
    if TRUST_PROXY:
        forwarded = request.headers.get("x-forwarded-for")
        if forwarded:
            return forwarded.split(",")[0].strip()
    return request.client.host if request.client else "unknown"


def _is_https(request):
    if request.url.scheme == "https":
        return True
    if TRUST_PROXY:
        forwarded = request.headers.get("x-forwarded-proto", "")
        return forwarded.split(",")[0].strip().lower() == "https"
    return False


def _set_cookie(response, token, request):
    response.set_cookie(
        auth.COOKIE_NAME,
        token,
        max_age=auth.SESSION_TTL,
        httponly=True,
        samesite="lax",
        secure=COOKIE_SECURE or _is_https(request),
        path="/",
    )


def _register_save(user_id):
    state = game.new_state()
    db.conn().execute(
        "INSERT INTO save_slots(user_id, slot_id, state, revision, updated_at) VALUES (?, 1, ?, 1, ?)",
        (user_id, json.dumps(state, ensure_ascii=False), time.time()),
    )


def _save_slots(user):
    with db.LOCK:
        rows = {
            row["slot_id"]: row
            for row in db.conn().execute(
                "SELECT slot_id, state, updated_at FROM save_slots WHERE user_id = ?",
                (user["id"],),
            )
        }
        slots = []
        for slot_id in range(1, 4):
            row = rows.get(slot_id)
            item = {"slotId": slot_id, "empty": row is None, "updatedAt": None}
            if row is not None:
                item["updatedAt"] = row["updated_at"]
                try:
                    state, _ = game.migrate_state(json.loads(row["state"]))
                    public = game.public_state(state)
                except (ValueError, B.GameError, KeyError, TypeError, AttributeError):
                    item["corrupt"] = True
                else:
                    item.update(
                        chapter=public["mapMeta"]["chapter"],
                        mapTitle=public["mapMeta"]["title"],
                        progress=public["progress"],
                        runLength=public["runLength"],
                        nodeName=public["node"]["name"] if public["node"] else "路线完成",
                        complete=public["complete"],
                    )
            slots.append(item)
        return {"username": user["username"], "activeSlot": user["slot"], "slots": slots}


def _set_active_slot(user, slot_id):
    auth.set_session_slot(user["session_token"], slot_id)
    user["slot"] = slot_id


def _cg_ids_from_state(state):
    ids = set()
    story = game.public_state(state).get("story")
    if story and story.get("background") in CG_BY_PATH:
        ids.add(CG_BY_PATH[story["background"]])
    if state.get("phase") in ("map_story", "before_story", "after_story"):
        lines = game.story_lines(state)
        for line in lines[: max(0, state.get("storyLine", 0))]:
            cg_id = CG_BY_PATH.get(line.get("background"))
            if cg_id:
                ids.add(cg_id)
    map_type = game.current_map_type(state)
    if map_type in ("map2", "map3"):
        ids.add("opening_sky")
    if map_type == "map3":
        nodes = state.get("mapData", {}).get("nodes", [])
        completed = set(state.get("completed") or [])
        final_event = {
            node["id"] for node in nodes
            if node.get("role") == "event" and node.get("column") == game.THIRD_MAP_FINAL_EVENT_COLUMN
        }
        if completed & final_event:
            ids.update({"campfire_stars", "campfire_woods", "campfire_knees", "campfire_warm"})
        if any(node.get("role") == "boss" and node["id"] in completed for node in nodes):
            ids.add("boss_warning")
    return ids


def _ensure_cg_backfill(user_id):
    pending = db.conn().execute(
        "SELECT 1 FROM cg_backfill_pending WHERE user_id = ?", (user_id,)
    ).fetchone()
    if pending is None:
        return
    ids = {"opening_sky"}
    rows = db.conn().execute(
        "SELECT state FROM save_slots WHERE user_id = ?", (user_id,)
    ).fetchall()
    for row in rows:
        try:
            state, _ = game.migrate_state(json.loads(row["state"]))
        except (ValueError, B.GameError, KeyError, TypeError, AttributeError):
            continue
        ids.update(_cg_ids_from_state(state))
    now = time.time()
    for cg_id in ids & CG_BY_ID.keys():
        db.conn().execute(
            "INSERT OR IGNORE INTO cg_unlocks(user_id, cg_id, unlocked_at) VALUES (?, ?, ?)",
            (user_id, cg_id, now),
        )
    db.conn().execute("DELETE FROM cg_backfill_pending WHERE user_id = ?", (user_id,))
    db.conn().commit()


def _cg_gallery(user_id):
    _ensure_cg_backfill(user_id)
    unlocked = {
        row["cg_id"] for row in db.conn().execute(
            "SELECT cg_id FROM cg_unlocks WHERE user_id = ?", (user_id,)
        )
    }
    return [dict(item) for item in CG_CATALOG if item["id"] in unlocked]


@app.post("/api/register")
def register(body: AuthBody, request: Request, response: Response):
    auth.rate_limit(f"register:{_client_ip(request)}", 5, 60)
    username = body.username.strip()
    if not USERNAME_RE.fullmatch(username):
        raise HTTPException(status_code=400, detail="用户名需为 3-20 位字母、数字或下划线")
    if not (8 <= len(body.password) <= 128):
        raise HTTPException(status_code=400, detail="密码长度需为 8-128 位")
    password_hash = auth.hash_password(body.password)
    with db.LOCK:
        conn = db.conn()
        try:
            if conn.execute("SELECT id FROM users WHERE username = ?", (username,)).fetchone():
                raise HTTPException(status_code=409, detail="用户名已被占用")
            cursor = conn.execute(
                "INSERT INTO users(username, password_hash, created_at) VALUES (?, ?, ?)",
                (username, password_hash, time.time()),
            )
            user_id = cursor.lastrowid
            _register_save(user_id)
            conn.commit()
        except Exception:
            conn.rollback()
            raise
        state = _load_state(user_id, 1)
    token = auth.create_session(user_id)
    _set_cookie(response, token, request)
    return {"username": username, "state": game.public_state(state)}


@app.post("/api/login")
def login(body: AuthBody, request: Request, response: Response):
    ip = _client_ip(request)
    auth.rate_limit(f"login:{ip}", 15, 60)
    auth.rate_limit(f"login-user:{body.username.strip().lower()}:{ip}", 8, 60)
    username = body.username.strip()
    with db.LOCK:
        row = db.conn().execute(
            "SELECT id, username, password_hash FROM users WHERE username = ?", (username,)
        ).fetchone()
    if row is None:
        auth.hash_password(body.password)
        raise HTTPException(status_code=401, detail="用户名或密码错误")
    if not auth.verify_password(body.password, row["password_hash"]):
        raise HTTPException(status_code=401, detail="用户名或密码错误")
    user_id = row["id"]
    token = auth.create_session(user_id)
    _set_cookie(response, token, request)
    return {"username": row["username"], "state": None}


@app.post("/api/logout")
def logout(request: Request, response: Response):
    token = request.cookies.get(auth.COOKIE_NAME)
    if token:
        auth.delete_session(token)
    response.delete_cookie(auth.COOKIE_NAME, path="/")
    return {"ok": True}


@app.get("/api/state")
def get_state(user=Depends(current_user)):
    with db.LOCK:
        row = db.conn().execute(
            "SELECT 1 FROM save_slots WHERE user_id = ? AND slot_id = ?", (user["id"], user["slot"])
        ).fetchone()
        state = _load_state(user["id"], user["slot"]) if row else None
    return {"username": user["username"], "state": game.public_state(state) if state else None, "battle": None}


@app.get("/api/save-slots")
def get_save_slots(user=Depends(current_user)):
    return _save_slots(user)


@app.get("/api/cg-gallery")
def get_cg_gallery(user=Depends(current_user)):
    with db.LOCK:
        return {"items": _cg_gallery(user["id"])}


@app.post("/api/cg-unlock")
def unlock_cg(body: CgUnlockBody, user=Depends(current_user)):
    if body.cgId not in CG_BY_ID:
        raise B.GameError("未知 CG")
    with db.LOCK:
        db.conn().execute(
            "INSERT OR IGNORE INTO cg_unlocks(user_id, cg_id, unlocked_at) VALUES (?, ?, ?)",
            (user["id"], body.cgId, time.time()),
        )
        db.conn().commit()
        return {"items": _cg_gallery(user["id"])}


@app.post("/api/save-slots/{slot_id}/select")
def select_save_slot(slot_id: int, user=Depends(current_user)):
    _valid_slot(slot_id)
    with db.LOCK:
        exists = db.conn().execute(
            "SELECT 1 FROM save_slots WHERE user_id = ? AND slot_id = ?", (user["id"], slot_id)
        ).fetchone()
        if not exists:
            raise B.GameError("该存档槽为空")
        state = _load_state(user["id"], slot_id)
        battle_state = _load_battle(user["id"], slot_id)
        _set_active_slot(user, slot_id)
    return {
        "username": user["username"], "activeSlot": slot_id,
        "state": game.public_state(state), "battle": B.view(battle_state) if battle_state else None,
    }


@app.delete("/api/save-slots/{slot_id}")
def delete_save_slot(slot_id: int, user=Depends(current_user)):
    _valid_slot(slot_id)
    with db.LOCK:
        conn = db.conn()
        conn.execute("DELETE FROM save_slots WHERE user_id = ? AND slot_id = ?", (user["id"], slot_id))
        conn.execute("DELETE FROM battle_slots WHERE user_id = ? AND slot_id = ?", (user["id"], slot_id))
        conn.execute("DELETE FROM save_backups WHERE user_id = ? AND slot_id = ?", (user["id"], slot_id))
        fallback = conn.execute(
            "SELECT slot_id FROM save_slots WHERE user_id = ? ORDER BY updated_at DESC LIMIT 1", (user["id"],)
        ).fetchone()
        fallback_slot = fallback["slot_id"] if fallback else 1
        conn.execute(
            "UPDATE users SET recent_slot = ? WHERE id = ? AND recent_slot = ?",
            (fallback_slot, user["id"], slot_id),
        )
        if user["slot"] == slot_id:
            conn.execute(
                "UPDATE sessions SET active_slot = ? WHERE token_hash = ?",
                (fallback_slot, auth.token_hash(user["session_token"])),
            )
            user["slot"] = fallback_slot
        conn.commit()
    return _save_slots(user)


@app.post("/api/game/new")
def new_game(body: NewGameBody, user=Depends(current_user)):
    slot_id = _valid_slot(body.slotId if body.slotId is not None else user["slot"])
    with db.LOCK:
        existing = db.conn().execute(
            "SELECT state FROM save_slots WHERE user_id = ? AND slot_id = ?", (user["id"], slot_id)
        ).fetchone()
        if existing:
            try:
                game.migrate_state(json.loads(existing["state"]))
            except (ValueError, B.GameError, KeyError, TypeError, AttributeError):
                raise HTTPException(status_code=500, detail="存档无法读取，已保留原数据")
        if existing and not body.confirm:
            raise HTTPException(status_code=400, detail="需要确认覆盖该存档槽")
        _set_active_slot(user, slot_id)
        state = game.new_state()
        _save_state(user["id"], state, slot_id)
        _clear_battle(user["id"], slot_id)
    return {"username": user["username"], "state": game.public_state(state), "battle": None}


@app.post("/api/game/map2")
def new_map2(user=Depends(current_user)):
    with db.LOCK:
        state = _load_state(user["id"], user["slot"])
        if not game.can_start_map2(state):
            raise game.GameError("需要先通关地图一")
        state = game.new_state(map_type="map2")
        _save_state(user["id"], state, user["slot"])
        _clear_battle(user["id"], user["slot"])
    return {"username": user["username"], "state": game.public_state(state), "battle": None}


@app.post("/api/game/map3")
def new_map3(user=Depends(current_user)):
    with db.LOCK:
        state = _load_state(user["id"], user["slot"])
        if not game.can_start_map3(state):
            raise game.GameError("需要先通关地图二")
        state = game.new_state(map_type="map3")
        _save_state(user["id"], state, user["slot"])
        _clear_battle(user["id"], user["slot"])
    return {"username": user["username"], "state": game.public_state(state), "battle": None}


@app.post("/api/story/advance")
def story_advance(body: StoryBody, user=Depends(current_user)):
    with db.LOCK:
        state = _load_state(user["id"], user["slot"])
        if body.transition:
            if body.skip:
                raise game.GameError("转场请求非法")
            game.finish_transition(state)
        else:
            game.advance_story(state, skip_whole_slot=body.skip)
        _save_state(user["id"], state, user["slot"])
        if state["phase"] != "node":
            _clear_battle(user["id"], user["slot"])
    return {"state": game.public_state(state), "battle": None}


@app.post("/api/story/choose")
def story_choose(body: StoryChooseBody, user=Depends(current_user)):
    with db.LOCK:
        state = _load_state(user["id"], user["slot"])
        game.choose_story_option(state, body.optionId)
        _save_state(user["id"], state, user["slot"])
        _clear_battle(user["id"], user["slot"])
    return {"state": game.public_state(state), "battle": None}


@app.post("/api/map/select")
def map_select(body: MapSelectBody, user=Depends(current_user)):
    with db.LOCK:
        state = _load_state(user["id"], user["slot"])
        game.select_node(state, body.nodeId)
        _save_state(user["id"], state, user["slot"])
        _clear_battle(user["id"], user["slot"])
    return {"state": game.public_state(state), "battle": None}


def _current_battle(user_id, state, slot_id):
    node = game.current_node(state)
    if state["phase"] != "node" or node is None or node["type"] != "battle":
        raise B.GameError("当前不在战斗节点")
    battle_state = _load_battle(user_id, slot_id)
    if battle_state is None or battle_state.get("nodeId") != node["id"]:
        _clear_battle(user_id, slot_id)
        raise B.GameError("战斗尚未开始，请重新进入")
    return battle_state


def _make_battle(user_id, state, slot_id):
    node = game.current_node(state)
    if state["phase"] != "node" or node is None or node["type"] != "battle":
        raise B.GameError("当前不在战斗节点")
    challenge = game.battle_challenge(state)
    extra_plan = None
    first_turn_energy = B.FIRST_TURN_ENERGY
    if challenge:
        first_turn_energy -= challenge["energyPenalty"]
        if challenge.get("extraEnemy"):
            extra_plan = [
                {
                    "turn": 1,
                    "column": challenge["column"],
                    "enemy": challenge["extraEnemy"],
                }
            ]
    battle_state = B.make_battle(
        state["cards"],
        game.ENCOUNTERS[node["encounter"]],
        game.CARDS,
        game.ENEMIES,
        rng=random.Random(),
        first_turn_energy=first_turn_energy,
        extra_plan=extra_plan,
        opening_draw=B.OPENING_DRAW + state.get("pendingDrawBonus", 0),
    )
    battle_state["nodeId"] = node["id"]
    drawn_uids = battle_state.pop("_drawnUids", [])
    _store_battle(user_id, battle_state, slot_id)
    battle_state["_responseDrawnUids"] = drawn_uids
    return battle_state


def _battle_response(state, battle_state, drawn_uids=None):
    if drawn_uids is None:
        drawn_uids = battle_state.pop("_responseDrawnUids", None)
    response = {"state": game.public_state(state), "battle": B.view(battle_state)}
    if drawn_uids is not None:
        response["drawnUids"] = drawn_uids
    return response


def _finish_final_boss_result(user_id, state, slot_id, battle_state):
    if (
        not game.is_final_boss(state)
        or battle_state is None
        or battle_state.get("phase") != "over"
        or battle_state.get("result") not in ("win", "lose")
    ):
        return None
    game.finish_final_boss_battle(state, battle_state["result"])
    _save_state(user_id, state, slot_id)
    _clear_battle(user_id, slot_id)
    return {"state": game.public_state(state), "battle": None}


def _abandon_lost_challenge(state, user_id, slot_id):
    previous = _load_battle(user_id, slot_id)
    if (
        previous is not None
        and previous.get("phase") == "over"
        and previous.get("result") != "win"
        and game.abandon_failed_challenge(state)
    ):
        _save_state(user_id, state, slot_id)


@app.post("/api/battle/start")
def battle_start(user=Depends(current_user)):
    with db.LOCK:
        state = _load_state(user["id"], user["slot"])
        node = game.current_node(state)
        battle_state = _load_battle(user["id"], user["slot"])
        finalized = _finish_final_boss_result(user["id"], state, user["slot"], battle_state)
        if finalized:
            return finalized
        if (
            battle_state is None
            or state["phase"] != "node"
            or node is None
            or node["type"] != "battle"
            or battle_state.get("nodeId") != node["id"]
        ):
            battle_state = _make_battle(user["id"], state, user["slot"])
        return _battle_response(state, battle_state)


@app.post("/api/battle/reset")
def battle_reset(user=Depends(current_user)):
    with db.LOCK:
        state = _load_state(user["id"], user["slot"])
        if game.is_final_boss(state):
            battle_state = _load_battle(user["id"], user["slot"])
            finalized = _finish_final_boss_result(user["id"], state, user["slot"], battle_state)
            if finalized:
                return finalized
            if battle_state is not None:
                raise B.GameError("最终 Boss 战不能重置")
        _abandon_lost_challenge(state, user["id"], user["slot"])
        battle_state = _make_battle(user["id"], state, user["slot"])
        return _battle_response(state, battle_state)


@app.post("/api/battle/deploy")
def battle_deploy(body: DeployBody, user=Depends(current_user)):
    with db.LOCK:
        state = _load_state(user["id"], user["slot"])
        battle_state = _current_battle(user["id"], state, user["slot"])
        B.deploy(battle_state, body.uid, body.column)
        _store_battle(user["id"], battle_state, user["slot"])
        return _battle_response(state, battle_state)


@app.post("/api/battle/tutorial")
def battle_tutorial(body: StoryBody, user=Depends(current_user)):
    with db.LOCK:
        state = _load_state(user["id"], user["slot"])
        battle_state = _current_battle(user["id"], state, user["slot"])
        B.tutorial_continue(battle_state, skip=body.skip)
        _store_battle(user["id"], battle_state, user["slot"])
        return _battle_response(state, battle_state)


@app.post("/api/battle/command")
def battle_command(body: CommandBody, user=Depends(current_user)):
    with db.LOCK:
        state = _load_state(user["id"], user["slot"])
        battle_state = _current_battle(user["id"], state, user["slot"])
        battle_state["combatEvents"] = []
        B.play_command(battle_state, body.uid, body.targetUid)
        events = battle_state.pop("combatEvents")
        _store_battle(user["id"], battle_state, user["slot"])
        return {**_battle_response(state, battle_state), "combatEvents": events}


@app.post("/api/battle/recycle")
def battle_recycle(body: RecycleBody, user=Depends(current_user)):
    with db.LOCK:
        state = _load_state(user["id"], user["slot"])
        battle_state = _current_battle(user["id"], state, user["slot"])
        B.recycle(battle_state, body.column)
        _store_battle(user["id"], battle_state, user["slot"])
        return _battle_response(state, battle_state)


@app.post("/api/battle/discard")
def battle_discard(body: DiscardBody, user=Depends(current_user)):
    with db.LOCK:
        state = _load_state(user["id"], user["slot"])
        battle_state = _current_battle(user["id"], state, user["slot"])
        drawn_uids = B.discard(battle_state, body.uids)
        _store_battle(user["id"], battle_state, user["slot"])
        return _battle_response(state, battle_state, drawn_uids)


@app.post("/api/battle/end")
def battle_end(user=Depends(current_user)):
    with db.LOCK:
        state = _load_state(user["id"], user["slot"])
        battle_state = _current_battle(user["id"], state, user["slot"])
        battle_state["combatEvents"] = []
        B.end_turn(battle_state, rng=random.Random())
        events = battle_state.pop("combatEvents")
        drawn_uids = battle_state.pop("_drawnUids", [])
        response = _finish_final_boss_result(user["id"], state, user["slot"], battle_state)
        if response is None:
            _store_battle(user["id"], battle_state, user["slot"])
            response = _battle_response(state, battle_state, drawn_uids)
        return {**response, "combatEvents": events}


@app.post("/api/battle/retry")
def battle_retry(user=Depends(current_user)):
    with db.LOCK:
        state = _load_state(user["id"], user["slot"])
        battle_state = _load_battle(user["id"], user["slot"])
        finalized = _finish_final_boss_result(user["id"], state, user["slot"], battle_state)
        if finalized:
            return finalized
        if game.is_final_boss(state) and battle_state is not None:
            raise B.GameError("最终 Boss 战不能重试")
        _abandon_lost_challenge(state, user["id"], user["slot"])
        battle_state = _make_battle(user["id"], state, user["slot"])
        return _battle_response(state, battle_state)


@app.post("/api/battle/return")
def battle_return(user=Depends(current_user)):
    with db.LOCK:
        state = _load_state(user["id"], user["slot"])
        battle_state = _current_battle(user["id"], state, user["slot"])
        finalized = _finish_final_boss_result(user["id"], state, user["slot"], battle_state)
        if finalized:
            return finalized
        if battle_state.get("phase") != "over" or battle_state.get("result") != "lose":
            raise B.GameError("只有战败后可以返回地图")
        _abandon_lost_challenge(state, user["id"], user["slot"])
        game.return_failed_battle_to_map(state)
        _save_state(user["id"], state, user["slot"])
        _clear_battle(user["id"], user["slot"])
    return {"state": game.public_state(state), "battle": None}


@app.post("/api/battle/confirm")
def battle_confirm(user=Depends(current_user)):
    with db.LOCK:
        state = _load_state(user["id"], user["slot"])
        node = game.current_node(state)
        if node is not None and node["id"] in state["completed"]:
            return {"state": game.public_state(state), "battle": None}
        battle_state = _current_battle(user["id"], state, user["slot"])
        finalized = _finish_final_boss_result(user["id"], state, user["slot"], battle_state)
        if finalized:
            return finalized
        if battle_state["phase"] != "over":
            raise B.GameError("战斗尚未结束")
        if battle_state["result"] != "win":
            raise B.GameError("战斗失败，无法结算")
        game.confirm_battle_result(state)
        _save_state(user["id"], state, user["slot"])
        _clear_battle(user["id"], user["slot"])
    return {"state": game.public_state(state), "battle": None}


@app.post("/api/elite/reward/choose")
def elite_reward_choose(body: EliteRewardBody, user=Depends(current_user)):
    with db.LOCK:
        state = _load_state(user["id"], user["slot"])
        game.elite_reward_choose(state, body.cardId)
        _save_state(user["id"], state, user["slot"])
        _clear_battle(user["id"], user["slot"])
    return {"state": game.public_state(state), "battle": None}


@app.post("/api/elite/reward/leave")
def elite_reward_leave(user=Depends(current_user)):
    with db.LOCK:
        state = _load_state(user["id"], user["slot"])
        game.elite_reward_leave(state)
        _save_state(user["id"], state, user["slot"])
        _clear_battle(user["id"], user["slot"])
    return {"state": game.public_state(state), "battle": None}


@app.post("/api/supply/choose")
def supply_choose(body: SupplyChooseBody, user=Depends(current_user)):
    with db.LOCK:
        state = _load_state(user["id"], user["slot"])
        game.supply_choose(state, body.round, body.cardId)
        _save_state(user["id"], state, user["slot"])
    return {"state": game.public_state(state), "battle": None}


@app.post("/api/supply/skip")
def supply_skip(body: SupplySkipBody, user=Depends(current_user)):
    with db.LOCK:
        state = _load_state(user["id"], user["slot"])
        game.supply_skip(state, body.round)
        _save_state(user["id"], state, user["slot"])
    return {"state": game.public_state(state), "battle": None}


@app.post("/api/supply/swap")
def supply_swap(body: SupplySwapBody, user=Depends(current_user)):
    with db.LOCK:
        state = _load_state(user["id"], user["slot"])
        game.supply_swap_choose(state, body.cardId, body.payment, body.removeUid)
        _save_state(user["id"], state, user["slot"])
    return {"state": game.public_state(state), "battle": None}


@app.post("/api/supply/swap/skip")
def supply_swap_skip(user=Depends(current_user)):
    with db.LOCK:
        state = _load_state(user["id"], user["slot"])
        game.supply_swap_skip(state)
        _save_state(user["id"], state, user["slot"])
    return {"state": game.public_state(state), "battle": None}


@app.post("/api/supply/challenge")
def supply_challenge(body: SupplyChallengeBody, user=Depends(current_user)):
    with db.LOCK:
        state = _load_state(user["id"], user["slot"])
        game.supply_challenge_accept(state, body.challengeId)
        _save_state(user["id"], state, user["slot"])
    return {"state": game.public_state(state), "battle": None}


@app.post("/api/supply/challenge/skip")
def supply_challenge_skip(user=Depends(current_user)):
    with db.LOCK:
        state = _load_state(user["id"], user["slot"])
        game.supply_challenge_skip(state)
        _save_state(user["id"], state, user["slot"])
    return {"state": game.public_state(state), "battle": None}


@app.post("/api/recruit/buy")
def recruit_buy(body: RecruitBody, user=Depends(current_user)):
    with db.LOCK:
        state = _load_state(user["id"], user["slot"])
        game.recruit_buy(state, body.offerId)
        _save_state(user["id"], state, user["slot"])
    return {"state": game.public_state(state), "battle": None}


@app.post("/api/recruit/leave")
def recruit_leave(user=Depends(current_user)):
    with db.LOCK:
        state = _load_state(user["id"], user["slot"])
        game.recruit_leave(state)
        _save_state(user["id"], state, user["slot"])
        _clear_battle(user["id"], user["slot"])
    return {"state": game.public_state(state), "battle": None}


@app.post("/api/signal/apply")
def signal_apply(body: SignalBody, user=Depends(current_user)):
    with db.LOCK:
        state = _load_state(user["id"], user["slot"])
        game.signal_apply(state, body.action, body.cardId, body.cardUid)
        _save_state(user["id"], state, user["slot"])
        _clear_battle(user["id"], user["slot"])
    return {"state": game.public_state(state), "battle": None}


@app.post("/api/signal/leave")
def signal_leave(user=Depends(current_user)):
    with db.LOCK:
        state = _load_state(user["id"], user["slot"])
        game.signal_leave(state)
        _save_state(user["id"], state, user["slot"])
        _clear_battle(user["id"], user["slot"])
    return {"state": game.public_state(state), "battle": None}


@app.post("/api/adventure/apply")
def adventure_apply(body: AdventureBody, user=Depends(current_user)):
    with db.LOCK:
        state = _load_state(user["id"], user["slot"])
        game.adventure_apply(state, body.cardId, body.effect, body.cardUid)
        _save_state(user["id"], state, user["slot"])
        _clear_battle(user["id"], user["slot"])
    return {"state": game.public_state(state), "battle": None}


@app.post("/api/adventure/leave")
def adventure_leave(user=Depends(current_user)):
    with db.LOCK:
        state = _load_state(user["id"], user["slot"])
        game.adventure_leave(state)
        _save_state(user["id"], state, user["slot"])
        _clear_battle(user["id"], user["slot"])
    return {"state": game.public_state(state), "battle": None}


@app.post("/api/calibration/apply")
def calibration_apply(body: CalibrationBody, user=Depends(current_user)):
    with db.LOCK:
        state = _load_state(user["id"], user["slot"])
        game.calibration_apply(state, body.cardId, body.effect, body.cardUid)
        _save_state(user["id"], state, user["slot"])
        _clear_battle(user["id"], user["slot"])
    return {"state": game.public_state(state), "battle": None}


@app.post("/api/calibration/leave")
def calibration_leave(user=Depends(current_user)):
    with db.LOCK:
        state = _load_state(user["id"], user["slot"])
        game.calibration_leave(state)
        _save_state(user["id"], state, user["slot"])
        _clear_battle(user["id"], user["slot"])
    return {"state": game.public_state(state), "battle": None}


@app.post("/api/recycle/apply")
def recycle_apply(body: RecycleCardBody, user=Depends(current_user)):
    with db.LOCK:
        state = _load_state(user["id"], user["slot"])
        game.recycle_apply(state, body.cardId, body.cardUid)
        _save_state(user["id"], state, user["slot"])
        _clear_battle(user["id"], user["slot"])
    return {"state": game.public_state(state), "battle": None}


@app.post("/api/recycle/leave")
def recycle_leave(user=Depends(current_user)):
    with db.LOCK:
        state = _load_state(user["id"], user["slot"])
        game.recycle_leave(state)
        _save_state(user["id"], state, user["slot"])
        _clear_battle(user["id"], user["slot"])
    return {"state": game.public_state(state), "battle": None}


@app.post("/api/drift/choose")
def drift_choose(body: DriftChooseBody, user=Depends(current_user)):
    with db.LOCK:
        state = _load_state(user["id"], user["slot"])
        game.drift_choose(state, body.cardId)
        _save_state(user["id"], state, user["slot"])
        _clear_battle(user["id"], user["slot"])
    return {"state": game.public_state(state), "battle": None}


@app.post("/api/drift/reroll")
def drift_reroll(user=Depends(current_user)):
    with db.LOCK:
        state = _load_state(user["id"], user["slot"])
        game.drift_reroll(state)
        _save_state(user["id"], state, user["slot"])
    return {"state": game.public_state(state), "battle": None}


@app.post("/api/drift/leave")
def drift_leave(user=Depends(current_user)):
    with db.LOCK:
        state = _load_state(user["id"], user["slot"])
        game.drift_leave(state)
        _save_state(user["id"], state, user["slot"])
        _clear_battle(user["id"], user["slot"])
    return {"state": game.public_state(state), "battle": None}


@app.post("/api/shop/buy")
def shop_buy(body: ShopBuyBody, user=Depends(current_user)):
    with db.LOCK:
        state = _load_state(user["id"], user["slot"])
        game.shop_buy(state, body.offerId, body.cardUid)
        _save_state(user["id"], state, user["slot"])
        _clear_battle(user["id"], user["slot"])
    return {"state": game.public_state(state), "battle": None}


@app.post("/api/shop/leave")
def shop_leave(user=Depends(current_user)):
    with db.LOCK:
        state = _load_state(user["id"], user["slot"])
        game.shop_leave(state)
        _save_state(user["id"], state, user["slot"])
        _clear_battle(user["id"], user["slot"])
    return {"state": game.public_state(state), "battle": None}


@app.post("/api/trial/choose")
def trial_choose(body: TrialChooseBody, user=Depends(current_user)):
    with db.LOCK:
        state = _load_state(user["id"], user["slot"])
        game.trial_choose(state, body.trialId)
        _save_state(user["id"], state, user["slot"])
    return {"state": game.public_state(state), "battle": None}


@app.post("/api/trial/choose-card")
def trial_choose_card(body: DriftChooseBody, user=Depends(current_user)):
    with db.LOCK:
        state = _load_state(user["id"], user["slot"])
        game.trial_choose_card(state, body.cardId)
        _save_state(user["id"], state, user["slot"])
        _clear_battle(user["id"], user["slot"])
    return {"state": game.public_state(state), "battle": None}


@app.post("/api/trial/claim")
def trial_claim(user=Depends(current_user)):
    with db.LOCK:
        state = _load_state(user["id"], user["slot"])
        game.trial_claim(state)
        _save_state(user["id"], state, user["slot"])
        _clear_battle(user["id"], user["slot"])
    return {"state": game.public_state(state), "battle": None}


@app.post("/api/trial/leave")
def trial_leave(user=Depends(current_user)):
    with db.LOCK:
        state = _load_state(user["id"], user["slot"])
        game.trial_leave(state)
        _save_state(user["id"], state, user["slot"])
        _clear_battle(user["id"], user["slot"])
    return {"state": game.public_state(state), "battle": None}


@app.post("/api/drones/apply")
def drones_apply(body: AdventureBody, user=Depends(current_user)):
    with db.LOCK:
        state = _load_state(user["id"], user["slot"])
        game.drones_apply(state, body.cardId, body.effect, body.cardUid)
        _save_state(user["id"], state, user["slot"])
        _clear_battle(user["id"], user["slot"])
    return {"state": game.public_state(state), "battle": None}


@app.post("/api/drones/leave")
def drones_leave(user=Depends(current_user)):
    with db.LOCK:
        state = _load_state(user["id"], user["slot"])
        game.drones_leave(state)
        _save_state(user["id"], state, user["slot"])
        _clear_battle(user["id"], user["slot"])
    return {"state": game.public_state(state), "battle": None}


@app.post("/api/training/choose")
def training_choose(body: TrainingChooseBody, user=Depends(current_user)):
    with db.LOCK:
        state = _load_state(user["id"], user["slot"])
        game.training_choose(state, body.challengeId)
        _save_state(user["id"], state, user["slot"])
        _clear_battle(user["id"], user["slot"])
    return {"state": game.public_state(state), "battle": None}


@app.post("/api/training/leave")
def training_leave(user=Depends(current_user)):
    with db.LOCK:
        state = _load_state(user["id"], user["slot"])
        game.training_leave(state)
        _save_state(user["id"], state, user["slot"])
        _clear_battle(user["id"], user["slot"])
    return {"state": game.public_state(state), "battle": None}


@app.post("/api/relay/choose")
def relay_choose(body: RelayBody, user=Depends(current_user)):
    if body.choice != "keep":
        raise HTTPException(status_code=400, detail="无效的中继站选项")
    with db.LOCK:
        state = _load_state(user["id"], user["slot"])
        game.relay_keep(state)
        _save_state(user["id"], state, user["slot"])
        _clear_battle(user["id"], user["slot"])
    return {"state": game.public_state(state), "battle": None}


@app.post("/api/relay/cut")
def relay_cut(body: DriftChooseBody, user=Depends(current_user)):
    with db.LOCK:
        state = _load_state(user["id"], user["slot"])
        game.relay_cut(state, body.cardId, body.cardUid)
        _save_state(user["id"], state, user["slot"])
        _clear_battle(user["id"], user["slot"])
    return {"state": game.public_state(state), "battle": None}


@app.post("/api/relay/leave")
def relay_leave(user=Depends(current_user)):
    with db.LOCK:
        state = _load_state(user["id"], user["slot"])
        game.relay_leave(state)
        _save_state(user["id"], state, user["slot"])
        _clear_battle(user["id"], user["slot"])
    return {"state": game.public_state(state), "battle": None}


app.mount("/", StaticFiles(directory=str(STATIC_DIR), html=True), name="static")
