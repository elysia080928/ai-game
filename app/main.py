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
from pydantic import BaseModel

from . import auth, db, game
from . import battle as B

USERNAME_RE = re.compile(r"^[A-Za-z0-9_]{3,20}$")
COOKIE_SECURE = os.environ.get("COOKIE_SECURE", "0") == "1"
STATIC_DIR = Path(__file__).resolve().parent.parent / "static"

app = FastAPI(title="AI Game MVP")
db.init()

BATTLES = {}


class AuthBody(BaseModel):
    username: str
    password: str


class StoryBody(BaseModel):
    skip: bool = False


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


class CalibrationBody(BaseModel):
    cardId: str
    effect: str


class RecycleCardBody(BaseModel):
    cardId: str


class DriftChooseBody(BaseModel):
    cardId: str


class SignalBody(BaseModel):
    action: str
    cardId: str


class MapSelectBody(BaseModel):
    nodeId: str


class StoryChooseBody(BaseModel):
    optionId: str


class NewGameBody(BaseModel):
    confirm: bool = False


@app.exception_handler(B.GameError)
def game_error_handler(request: Request, exc: B.GameError):
    return JSONResponse(status_code=400, content={"detail": str(exc)})


def current_user(request: Request):
    user = auth.user_from_request(request)
    if user is None:
        raise HTTPException(status_code=401, detail="未登录")
    return user


def _load_state(user_id):
    row = db.conn().execute("SELECT state FROM saves WHERE user_id = ?", (user_id,)).fetchone()
    if row is None:
        return game.new_state()
    try:
        state, changed = game.migrate_state(json.loads(row["state"]))
    except (ValueError, B.GameError):
        raise HTTPException(status_code=500, detail="存档无法读取，已保留原数据")
    if changed:
        _save_state(user_id, state)
    return state


def _save_state(user_id, state):
    db.conn().execute(
        "UPDATE saves SET state = ?, revision = revision + 1, updated_at = ? WHERE user_id = ?",
        (json.dumps(state, ensure_ascii=False), time.time(), user_id),
    )
    db.conn().commit()


def _client_ip(request):
    return request.client.host if request.client else "unknown"


def _set_cookie(response, token):
    response.set_cookie(
        auth.COOKIE_NAME,
        token,
        max_age=auth.SESSION_TTL,
        httponly=True,
        samesite="lax",
        secure=COOKIE_SECURE,
        path="/",
    )


def _register_save(user_id):
    state = game.new_state()
    db.conn().execute(
        "INSERT INTO saves(user_id, state, revision, updated_at) VALUES (?, ?, 1, ?)",
        (user_id, json.dumps(state, ensure_ascii=False), time.time()),
    )


@app.post("/api/register")
def register(body: AuthBody, request: Request, response: Response):
    auth.rate_limit(f"register:{_client_ip(request)}", 5, 60)
    username = body.username.strip()
    if not USERNAME_RE.fullmatch(username):
        raise HTTPException(status_code=400, detail="用户名需为 3-20 位字母、数字或下划线")
    if not (8 <= len(body.password) <= 128):
        raise HTTPException(status_code=400, detail="密码长度需为 8-128 位")
    with db.LOCK:
        conn = db.conn()
        if conn.execute("SELECT id FROM users WHERE username = ?", (username,)).fetchone():
            raise HTTPException(status_code=409, detail="用户名已被占用")
        cursor = conn.execute(
            "INSERT INTO users(username, password_hash, created_at) VALUES (?, ?, ?)",
            (username, auth.hash_password(body.password), time.time()),
        )
        user_id = cursor.lastrowid
        _register_save(user_id)
        conn.commit()
        state = _load_state(user_id)
    token = auth.create_session(user_id)
    _set_cookie(response, token)
    return {"username": username, "state": game.public_state(state)}


@app.post("/api/login")
def login(body: AuthBody, request: Request, response: Response):
    ip = _client_ip(request)
    auth.rate_limit(f"login:{ip}", 15, 60)
    auth.rate_limit(f"login-user:{body.username.strip().lower()}:{ip}", 8, 60)
    username = body.username.strip()
    with db.LOCK:
        conn = db.conn()
        row = conn.execute(
            "SELECT id, username, password_hash FROM users WHERE username = ?", (username,)
        ).fetchone()
        if row is None or not auth.verify_password(body.password, row["password_hash"]):
            raise HTTPException(status_code=401, detail="用户名或密码错误")
        user_id = row["id"]
        state = _load_state(user_id)
    token = auth.create_session(user_id)
    _set_cookie(response, token)
    return {"username": row["username"], "state": game.public_state(state)}


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
        state = _load_state(user["id"])
    return {"username": user["username"], "state": game.public_state(state), "battle": None}


@app.post("/api/game/new")
def new_game(body: NewGameBody, user=Depends(current_user)):
    if not body.confirm:
        raise HTTPException(status_code=400, detail="需要确认覆盖当前冒险")
    with db.LOCK:
        state = game.new_state()
        _save_state(user["id"], state)
        BATTLES.pop(user["id"], None)
    return {"state": game.public_state(state), "battle": None}


@app.post("/api/story/advance")
def story_advance(body: StoryBody, user=Depends(current_user)):
    with db.LOCK:
        state = _load_state(user["id"])
        game.advance_story(state, skip_whole_slot=body.skip)
        _save_state(user["id"], state)
        if state["phase"] != "node":
            BATTLES.pop(user["id"], None)
    return {"state": game.public_state(state), "battle": None}


@app.post("/api/story/choose")
def story_choose(body: StoryChooseBody, user=Depends(current_user)):
    with db.LOCK:
        state = _load_state(user["id"])
        game.choose_story_option(state, body.optionId)
        _save_state(user["id"], state)
        BATTLES.pop(user["id"], None)
    return {"state": game.public_state(state), "battle": None}


@app.post("/api/map/select")
def map_select(body: MapSelectBody, user=Depends(current_user)):
    with db.LOCK:
        state = _load_state(user["id"])
        game.select_node(state, body.nodeId)
        _save_state(user["id"], state)
        BATTLES.pop(user["id"], None)
    return {"state": game.public_state(state), "battle": None}


def _current_battle(user_id, state):
    node = game.current_node(state)
    if state["phase"] != "node" or node is None or node["type"] != "battle":
        raise B.GameError("当前不在战斗节点")
    battle_state = BATTLES.get(user_id)
    if battle_state is None:
        raise B.GameError("战斗尚未开始，请重新进入")
    return battle_state


def _make_battle(user_id, state):
    node = game.current_node(state)
    if state["phase"] != "node" or node is None or node["type"] != "battle":
        raise B.GameError("当前不在战斗节点")
    battle_state = B.make_battle(
        state["cards"],
        game.ENCOUNTERS[node["encounter"]],
        game.CARDS,
        game.ENEMIES,
        rng=random.Random(),
    )
    BATTLES[user_id] = battle_state
    return battle_state


def _battle_response(state, battle_state):
    return {"state": game.public_state(state), "battle": B.view(battle_state)}


@app.post("/api/battle/start")
def battle_start(user=Depends(current_user)):
    with db.LOCK:
        state = _load_state(user["id"])
        battle_state = BATTLES.get(user["id"]) or _make_battle(user["id"], state)
        return _battle_response(state, battle_state)


@app.post("/api/battle/reset")
def battle_reset(user=Depends(current_user)):
    with db.LOCK:
        state = _load_state(user["id"])
        battle_state = _make_battle(user["id"], state)
        return _battle_response(state, battle_state)


@app.post("/api/battle/deploy")
def battle_deploy(body: DeployBody, user=Depends(current_user)):
    with db.LOCK:
        state = _load_state(user["id"])
        battle_state = _current_battle(user["id"], state)
        B.deploy(battle_state, body.uid, body.column)
        return _battle_response(state, battle_state)


@app.post("/api/battle/command")
def battle_command(body: CommandBody, user=Depends(current_user)):
    with db.LOCK:
        state = _load_state(user["id"])
        battle_state = _current_battle(user["id"], state)
        B.play_command(battle_state, body.uid, body.targetUid)
        return _battle_response(state, battle_state)


@app.post("/api/battle/recycle")
def battle_recycle(body: RecycleBody, user=Depends(current_user)):
    with db.LOCK:
        state = _load_state(user["id"])
        battle_state = _current_battle(user["id"], state)
        B.recycle(battle_state, body.column)
        return _battle_response(state, battle_state)


@app.post("/api/battle/discard")
def battle_discard(body: DiscardBody, user=Depends(current_user)):
    with db.LOCK:
        state = _load_state(user["id"])
        battle_state = _current_battle(user["id"], state)
        B.discard(battle_state, body.uids)
        return _battle_response(state, battle_state)


@app.post("/api/battle/end")
def battle_end(user=Depends(current_user)):
    with db.LOCK:
        state = _load_state(user["id"])
        battle_state = _current_battle(user["id"], state)
        B.end_turn(battle_state, rng=random.Random())
        return _battle_response(state, battle_state)


@app.post("/api/battle/retry")
def battle_retry(user=Depends(current_user)):
    with db.LOCK:
        state = _load_state(user["id"])
        battle_state = _make_battle(user["id"], state)
        return _battle_response(state, battle_state)


@app.post("/api/battle/confirm")
def battle_confirm(user=Depends(current_user)):
    with db.LOCK:
        state = _load_state(user["id"])
        node = game.current_node(state)
        if node is not None and node["id"] in state["completed"]:
            return {"state": game.public_state(state), "battle": None}
        battle_state = _current_battle(user["id"], state)
        if battle_state["phase"] != "over":
            raise B.GameError("战斗尚未结束")
        if battle_state["result"] != "win":
            raise B.GameError("战斗失败，无法结算")
        game.confirm_battle_result(state)
        _save_state(user["id"], state)
        BATTLES.pop(user["id"], None)
    return {"state": game.public_state(state), "battle": None}


@app.post("/api/recruit/buy")
def recruit_buy(body: RecruitBody, user=Depends(current_user)):
    with db.LOCK:
        state = _load_state(user["id"])
        game.recruit_buy(state, body.offerId)
        _save_state(user["id"], state)
    return {"state": game.public_state(state), "battle": None}


@app.post("/api/recruit/leave")
def recruit_leave(user=Depends(current_user)):
    with db.LOCK:
        state = _load_state(user["id"])
        game.recruit_leave(state)
        _save_state(user["id"], state)
        BATTLES.pop(user["id"], None)
    return {"state": game.public_state(state), "battle": None}


@app.post("/api/signal/apply")
def signal_apply(body: SignalBody, user=Depends(current_user)):
    with db.LOCK:
        state = _load_state(user["id"])
        game.signal_apply(state, body.action, body.cardId)
        _save_state(user["id"], state)
        BATTLES.pop(user["id"], None)
    return {"state": game.public_state(state), "battle": None}


@app.post("/api/signal/leave")
def signal_leave(user=Depends(current_user)):
    with db.LOCK:
        state = _load_state(user["id"])
        game.signal_leave(state)
        _save_state(user["id"], state)
        BATTLES.pop(user["id"], None)
    return {"state": game.public_state(state), "battle": None}


@app.post("/api/adventure/apply")
def adventure_apply(body: AdventureBody, user=Depends(current_user)):
    with db.LOCK:
        state = _load_state(user["id"])
        game.adventure_apply(state, body.cardId, body.effect)
        _save_state(user["id"], state)
        BATTLES.pop(user["id"], None)
    return {"state": game.public_state(state), "battle": None}


@app.post("/api/adventure/leave")
def adventure_leave(user=Depends(current_user)):
    with db.LOCK:
        state = _load_state(user["id"])
        game.adventure_leave(state)
        _save_state(user["id"], state)
        BATTLES.pop(user["id"], None)
    return {"state": game.public_state(state), "battle": None}


@app.post("/api/calibration/apply")
def calibration_apply(body: CalibrationBody, user=Depends(current_user)):
    with db.LOCK:
        state = _load_state(user["id"])
        game.calibration_apply(state, body.cardId, body.effect)
        _save_state(user["id"], state)
        BATTLES.pop(user["id"], None)
    return {"state": game.public_state(state), "battle": None}


@app.post("/api/calibration/leave")
def calibration_leave(user=Depends(current_user)):
    with db.LOCK:
        state = _load_state(user["id"])
        game.calibration_leave(state)
        _save_state(user["id"], state)
        BATTLES.pop(user["id"], None)
    return {"state": game.public_state(state), "battle": None}


@app.post("/api/recycle/apply")
def recycle_apply(body: RecycleCardBody, user=Depends(current_user)):
    with db.LOCK:
        state = _load_state(user["id"])
        game.recycle_apply(state, body.cardId)
        _save_state(user["id"], state)
        BATTLES.pop(user["id"], None)
    return {"state": game.public_state(state), "battle": None}


@app.post("/api/recycle/leave")
def recycle_leave(user=Depends(current_user)):
    with db.LOCK:
        state = _load_state(user["id"])
        game.recycle_leave(state)
        _save_state(user["id"], state)
        BATTLES.pop(user["id"], None)
    return {"state": game.public_state(state), "battle": None}


@app.post("/api/drift/choose")
def drift_choose(body: DriftChooseBody, user=Depends(current_user)):
    with db.LOCK:
        state = _load_state(user["id"])
        game.drift_choose(state, body.cardId)
        _save_state(user["id"], state)
        BATTLES.pop(user["id"], None)
    return {"state": game.public_state(state), "battle": None}


@app.post("/api/drift/reroll")
def drift_reroll(user=Depends(current_user)):
    with db.LOCK:
        state = _load_state(user["id"])
        game.drift_reroll(state)
        _save_state(user["id"], state)
    return {"state": game.public_state(state), "battle": None}


@app.post("/api/drift/leave")
def drift_leave(user=Depends(current_user)):
    with db.LOCK:
        state = _load_state(user["id"])
        game.drift_leave(state)
        _save_state(user["id"], state)
        BATTLES.pop(user["id"], None)
    return {"state": game.public_state(state), "battle": None}


app.mount("/", StaticFiles(directory=str(STATIC_DIR), html=True), name="static")
