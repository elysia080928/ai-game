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
from pydantic import BaseModel, Field

from . import auth, db, game
from . import battle as B

USERNAME_RE = re.compile(r"^[A-Za-z0-9_]{3,20}$")
COOKIE_SECURE = os.environ.get("COOKIE_SECURE", "0") == "1"
TRUST_PROXY = os.environ.get("TRUST_PROXY", "0") == "1"
MAX_BODY_BYTES = 64 * 1024
STATIC_DIR = Path(__file__).resolve().parent.parent / "static"

app = FastAPI(title="AI Game MVP")
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


class TrialChooseBody(BaseModel):
    trialId: str


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


@app.exception_handler(B.GameError)
def game_error_handler(request: Request, exc: B.GameError):
    return JSONResponse(status_code=400, content={"detail": str(exc)})


def current_user(request: Request):
    user = auth.user_from_request(request)
    if user is None:
        raise HTTPException(status_code=401, detail="未登录")
    return user


def _load_state(user_id):
    row = db.conn().execute(
        "SELECT state, revision FROM saves WHERE user_id = ?", (user_id,)
    ).fetchone()
    if row is None:
        return game.new_state()
    try:
        state, changed = game.migrate_state(json.loads(row["state"]))
    except (ValueError, B.GameError):
        raise HTTPException(status_code=500, detail="存档无法读取，已保留原数据")
    state["_rev"] = row["revision"]
    if changed:
        conn = db.conn()
        conn.execute(
            "INSERT INTO save_backups(user_id, state, created_at) VALUES (?, ?, ?)",
            (user_id, row["state"], time.time()),
        )
        conn.execute(
            """DELETE FROM save_backups WHERE user_id = ? AND id NOT IN (
                SELECT id FROM save_backups WHERE user_id = ? ORDER BY id DESC LIMIT 5
            )""",
            (user_id, user_id),
        )
        conn.commit()
        _save_state(user_id, state)
    return state


def _save_state(user_id, state):
    payload = dict(state)
    expected = payload.pop("_rev", None)
    encoded = json.dumps(payload, ensure_ascii=False)
    conn = db.conn()
    if expected is None:
        cursor = conn.execute(
            "UPDATE saves SET state = ?, revision = revision + 1, updated_at = ? WHERE user_id = ?",
            (encoded, time.time(), user_id),
        )
    else:
        cursor = conn.execute(
            "UPDATE saves SET state = ?, revision = revision + 1, updated_at = ? WHERE user_id = ? AND revision = ?",
            (encoded, time.time(), user_id, expected),
        )
    if cursor.rowcount == 0:
        if expected is not None:
            conn.rollback()
            raise HTTPException(status_code=409, detail="存档已被其他请求更新，请刷新后重试")
        conn.execute(
            "INSERT INTO saves(user_id, state, revision, updated_at) VALUES (?, ?, 1, ?)",
            (user_id, encoded, time.time()),
        )
    conn.commit()
    if expected is not None:
        state["_rev"] = expected + 1


def _load_battle(user_id):
    row = db.conn().execute(
        "SELECT state FROM battles WHERE user_id = ?", (user_id,)
    ).fetchone()
    if row is None:
        return None
    try:
        return json.loads(row["state"])
    except ValueError:
        _clear_battle(user_id)
        return None


def _store_battle(user_id, battle_state):
    conn = db.conn()
    conn.execute(
        """INSERT INTO battles(user_id, state, updated_at) VALUES (?, ?, ?)
        ON CONFLICT(user_id) DO UPDATE SET state = excluded.state, updated_at = excluded.updated_at""",
        (user_id, json.dumps(battle_state, ensure_ascii=False), time.time()),
    )
    conn.commit()


def _clear_battle(user_id):
    conn = db.conn()
    conn.execute("DELETE FROM battles WHERE user_id = ?", (user_id,))
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
        state = _load_state(user_id)
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
    with db.LOCK:
        user_id = row["id"]
        state = _load_state(user_id)
    token = auth.create_session(user_id)
    _set_cookie(response, token, request)
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
        _clear_battle(user["id"])
    return {"username": user["username"], "state": game.public_state(state), "battle": None}


@app.post("/api/game/map2")
def new_map2(user=Depends(current_user)):
    with db.LOCK:
        state = _load_state(user["id"])
        if not game.can_start_map2(state):
            raise game.GameError("需要先通关地图一")
        state = game.new_state(map_type="map2")
        _save_state(user["id"], state)
        _clear_battle(user["id"])
    return {"username": user["username"], "state": game.public_state(state), "battle": None}


@app.post("/api/game/map3")
def new_map3(user=Depends(current_user)):
    with db.LOCK:
        state = _load_state(user["id"])
        if not game.can_start_map3(state):
            raise game.GameError("需要先通关地图二")
        state = game.new_state(map_type="map3")
        _save_state(user["id"], state)
        _clear_battle(user["id"])
    return {"username": user["username"], "state": game.public_state(state), "battle": None}


@app.post("/api/story/advance")
def story_advance(body: StoryBody, user=Depends(current_user)):
    with db.LOCK:
        state = _load_state(user["id"])
        game.advance_story(state, skip_whole_slot=body.skip)
        _save_state(user["id"], state)
        if state["phase"] != "node":
            _clear_battle(user["id"])
    return {"state": game.public_state(state), "battle": None}


@app.post("/api/story/choose")
def story_choose(body: StoryChooseBody, user=Depends(current_user)):
    with db.LOCK:
        state = _load_state(user["id"])
        game.choose_story_option(state, body.optionId)
        _save_state(user["id"], state)
        _clear_battle(user["id"])
    return {"state": game.public_state(state), "battle": None}


@app.post("/api/map/select")
def map_select(body: MapSelectBody, user=Depends(current_user)):
    with db.LOCK:
        state = _load_state(user["id"])
        game.select_node(state, body.nodeId)
        _save_state(user["id"], state)
        _clear_battle(user["id"])
    return {"state": game.public_state(state), "battle": None}


def _current_battle(user_id, state):
    node = game.current_node(state)
    if state["phase"] != "node" or node is None or node["type"] != "battle":
        raise B.GameError("当前不在战斗节点")
    battle_state = _load_battle(user_id)
    if battle_state is None or battle_state.get("nodeId") != node["id"]:
        _clear_battle(user_id)
        raise B.GameError("战斗尚未开始，请重新进入")
    return battle_state


def _make_battle(user_id, state):
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
    _store_battle(user_id, battle_state)
    return battle_state


def _battle_response(state, battle_state):
    return {"state": game.public_state(state), "battle": B.view(battle_state)}


@app.post("/api/battle/start")
def battle_start(user=Depends(current_user)):
    with db.LOCK:
        state = _load_state(user["id"])
        node = game.current_node(state)
        battle_state = _load_battle(user["id"])
        if (
            battle_state is None
            or state["phase"] != "node"
            or node is None
            or node["type"] != "battle"
            or battle_state.get("nodeId") != node["id"]
        ):
            battle_state = _make_battle(user["id"], state)
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
        _store_battle(user["id"], battle_state)
        return _battle_response(state, battle_state)


@app.post("/api/battle/tutorial")
def battle_tutorial(body: StoryBody, user=Depends(current_user)):
    with db.LOCK:
        state = _load_state(user["id"])
        battle_state = _current_battle(user["id"], state)
        B.tutorial_continue(battle_state, skip=body.skip)
        _store_battle(user["id"], battle_state)
        return _battle_response(state, battle_state)


@app.post("/api/battle/command")
def battle_command(body: CommandBody, user=Depends(current_user)):
    with db.LOCK:
        state = _load_state(user["id"])
        battle_state = _current_battle(user["id"], state)
        B.play_command(battle_state, body.uid, body.targetUid)
        _store_battle(user["id"], battle_state)
        return _battle_response(state, battle_state)


@app.post("/api/battle/recycle")
def battle_recycle(body: RecycleBody, user=Depends(current_user)):
    with db.LOCK:
        state = _load_state(user["id"])
        battle_state = _current_battle(user["id"], state)
        B.recycle(battle_state, body.column)
        _store_battle(user["id"], battle_state)
        return _battle_response(state, battle_state)


@app.post("/api/battle/discard")
def battle_discard(body: DiscardBody, user=Depends(current_user)):
    with db.LOCK:
        state = _load_state(user["id"])
        battle_state = _current_battle(user["id"], state)
        B.discard(battle_state, body.uids)
        _store_battle(user["id"], battle_state)
        return _battle_response(state, battle_state)


@app.post("/api/battle/end")
def battle_end(user=Depends(current_user)):
    with db.LOCK:
        state = _load_state(user["id"])
        battle_state = _current_battle(user["id"], state)
        B.end_turn(battle_state, rng=random.Random())
        _store_battle(user["id"], battle_state)
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
        _clear_battle(user["id"])
    return {"state": game.public_state(state), "battle": None}


@app.post("/api/elite/reward/choose")
def elite_reward_choose(body: EliteRewardBody, user=Depends(current_user)):
    with db.LOCK:
        state = _load_state(user["id"])
        game.elite_reward_choose(state, body.cardId)
        _save_state(user["id"], state)
        _clear_battle(user["id"])
    return {"state": game.public_state(state), "battle": None}


@app.post("/api/elite/reward/leave")
def elite_reward_leave(user=Depends(current_user)):
    with db.LOCK:
        state = _load_state(user["id"])
        game.elite_reward_leave(state)
        _save_state(user["id"], state)
        _clear_battle(user["id"])
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
        _clear_battle(user["id"])
    return {"state": game.public_state(state), "battle": None}


@app.post("/api/signal/apply")
def signal_apply(body: SignalBody, user=Depends(current_user)):
    with db.LOCK:
        state = _load_state(user["id"])
        game.signal_apply(state, body.action, body.cardId, body.cardUid)
        _save_state(user["id"], state)
        _clear_battle(user["id"])
    return {"state": game.public_state(state), "battle": None}


@app.post("/api/signal/leave")
def signal_leave(user=Depends(current_user)):
    with db.LOCK:
        state = _load_state(user["id"])
        game.signal_leave(state)
        _save_state(user["id"], state)
        _clear_battle(user["id"])
    return {"state": game.public_state(state), "battle": None}


@app.post("/api/adventure/apply")
def adventure_apply(body: AdventureBody, user=Depends(current_user)):
    with db.LOCK:
        state = _load_state(user["id"])
        game.adventure_apply(state, body.cardId, body.effect, body.cardUid)
        _save_state(user["id"], state)
        _clear_battle(user["id"])
    return {"state": game.public_state(state), "battle": None}


@app.post("/api/adventure/leave")
def adventure_leave(user=Depends(current_user)):
    with db.LOCK:
        state = _load_state(user["id"])
        game.adventure_leave(state)
        _save_state(user["id"], state)
        _clear_battle(user["id"])
    return {"state": game.public_state(state), "battle": None}


@app.post("/api/calibration/apply")
def calibration_apply(body: CalibrationBody, user=Depends(current_user)):
    with db.LOCK:
        state = _load_state(user["id"])
        game.calibration_apply(state, body.cardId, body.effect, body.cardUid)
        _save_state(user["id"], state)
        _clear_battle(user["id"])
    return {"state": game.public_state(state), "battle": None}


@app.post("/api/calibration/leave")
def calibration_leave(user=Depends(current_user)):
    with db.LOCK:
        state = _load_state(user["id"])
        game.calibration_leave(state)
        _save_state(user["id"], state)
        _clear_battle(user["id"])
    return {"state": game.public_state(state), "battle": None}


@app.post("/api/recycle/apply")
def recycle_apply(body: RecycleCardBody, user=Depends(current_user)):
    with db.LOCK:
        state = _load_state(user["id"])
        game.recycle_apply(state, body.cardId, body.cardUid)
        _save_state(user["id"], state)
        _clear_battle(user["id"])
    return {"state": game.public_state(state), "battle": None}


@app.post("/api/recycle/leave")
def recycle_leave(user=Depends(current_user)):
    with db.LOCK:
        state = _load_state(user["id"])
        game.recycle_leave(state)
        _save_state(user["id"], state)
        _clear_battle(user["id"])
    return {"state": game.public_state(state), "battle": None}


@app.post("/api/drift/choose")
def drift_choose(body: DriftChooseBody, user=Depends(current_user)):
    with db.LOCK:
        state = _load_state(user["id"])
        game.drift_choose(state, body.cardId)
        _save_state(user["id"], state)
        _clear_battle(user["id"])
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
        _clear_battle(user["id"])
    return {"state": game.public_state(state), "battle": None}


@app.post("/api/shop/buy")
def shop_buy(body: ShopBuyBody, user=Depends(current_user)):
    with db.LOCK:
        state = _load_state(user["id"])
        game.shop_buy(state, body.offerId)
        _save_state(user["id"], state)
        _clear_battle(user["id"])
    return {"state": game.public_state(state), "battle": None}


@app.post("/api/shop/leave")
def shop_leave(user=Depends(current_user)):
    with db.LOCK:
        state = _load_state(user["id"])
        game.shop_leave(state)
        _save_state(user["id"], state)
        _clear_battle(user["id"])
    return {"state": game.public_state(state), "battle": None}


@app.post("/api/trial/choose")
def trial_choose(body: TrialChooseBody, user=Depends(current_user)):
    with db.LOCK:
        state = _load_state(user["id"])
        game.trial_choose(state, body.trialId)
        _save_state(user["id"], state)
    return {"state": game.public_state(state), "battle": None}


@app.post("/api/trial/choose-card")
def trial_choose_card(body: DriftChooseBody, user=Depends(current_user)):
    with db.LOCK:
        state = _load_state(user["id"])
        game.trial_choose_card(state, body.cardId)
        _save_state(user["id"], state)
        _clear_battle(user["id"])
    return {"state": game.public_state(state), "battle": None}


@app.post("/api/trial/claim")
def trial_claim(user=Depends(current_user)):
    with db.LOCK:
        state = _load_state(user["id"])
        game.trial_claim(state)
        _save_state(user["id"], state)
        _clear_battle(user["id"])
    return {"state": game.public_state(state), "battle": None}


@app.post("/api/trial/leave")
def trial_leave(user=Depends(current_user)):
    with db.LOCK:
        state = _load_state(user["id"])
        game.trial_leave(state)
        _save_state(user["id"], state)
        _clear_battle(user["id"])
    return {"state": game.public_state(state), "battle": None}


@app.post("/api/drones/apply")
def drones_apply(body: AdventureBody, user=Depends(current_user)):
    with db.LOCK:
        state = _load_state(user["id"])
        game.drones_apply(state, body.cardId, body.effect, body.cardUid)
        _save_state(user["id"], state)
        _clear_battle(user["id"])
    return {"state": game.public_state(state), "battle": None}


@app.post("/api/drones/leave")
def drones_leave(user=Depends(current_user)):
    with db.LOCK:
        state = _load_state(user["id"])
        game.drones_leave(state)
        _save_state(user["id"], state)
        _clear_battle(user["id"])
    return {"state": game.public_state(state), "battle": None}


@app.post("/api/training/choose")
def training_choose(body: TrainingChooseBody, user=Depends(current_user)):
    with db.LOCK:
        state = _load_state(user["id"])
        game.training_choose(state, body.challengeId)
        _save_state(user["id"], state)
        _clear_battle(user["id"])
    return {"state": game.public_state(state), "battle": None}


@app.post("/api/training/leave")
def training_leave(user=Depends(current_user)):
    with db.LOCK:
        state = _load_state(user["id"])
        game.training_leave(state)
        _save_state(user["id"], state)
        _clear_battle(user["id"])
    return {"state": game.public_state(state), "battle": None}


@app.post("/api/relay/choose")
def relay_choose(body: RelayBody, user=Depends(current_user)):
    if body.choice != "keep":
        raise HTTPException(status_code=400, detail="无效的中继站选项")
    with db.LOCK:
        state = _load_state(user["id"])
        game.relay_keep(state)
        _save_state(user["id"], state)
        _clear_battle(user["id"])
    return {"state": game.public_state(state), "battle": None}


@app.post("/api/relay/cut")
def relay_cut(body: DriftChooseBody, user=Depends(current_user)):
    with db.LOCK:
        state = _load_state(user["id"])
        game.relay_cut(state, body.cardId, body.cardUid)
        _save_state(user["id"], state)
        _clear_battle(user["id"])
    return {"state": game.public_state(state), "battle": None}


@app.post("/api/relay/leave")
def relay_leave(user=Depends(current_user)):
    with db.LOCK:
        state = _load_state(user["id"])
        game.relay_leave(state)
        _save_state(user["id"], state)
        _clear_battle(user["id"])
    return {"state": game.public_state(state), "battle": None}


app.mount("/", StaticFiles(directory=str(STATIC_DIR), html=True), name="static")
