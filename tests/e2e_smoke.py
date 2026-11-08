"""端到端冒烟测试：python tests/e2e_smoke.py（需要先启动服务）。

验证注册、剧情选项与跳过、选关、三条分支路线、奇遇、挑战、预告、重复请求与账号隔离。
"""

import http.cookiejar
import json
import os
import random
import time
import urllib.error
import urllib.request

BASE = os.environ.get("BASE_URL", "http://127.0.0.1:8099")


class Client:
    def __init__(self):
        self.jar = http.cookiejar.CookieJar()
        self.opener = urllib.request.build_opener(urllib.request.HTTPCookieProcessor(self.jar))

    def request(self, path, payload=None):
        data = None if payload is None else json.dumps(payload).encode("utf-8")
        request = urllib.request.Request(
            BASE + path,
            data=data,
            headers={"Content-Type": "application/json"} if data else {},
            method="GET" if data is None else "POST",
        )
        try:
            with self.opener.open(request) as response:
                return response.status, json.loads(response.read().decode("utf-8"))
        except urllib.error.HTTPError as error:
            body = error.read().decode("utf-8")
            try:
                parsed = json.loads(body)
            except json.JSONDecodeError:
                parsed = {"detail": body}
            return error.code, parsed

    def ok(self, path, payload=None):
        status, body = self.request(path, payload)
        assert status == 200, f"{path} -> {status} {body}"
        return body

    def fail(self, path, payload=None, status=400):
        code, body = self.request(path, payload)
        assert code == status, f"{path} 预期 {status}，实际 {code} {body}"
        return body

    def state(self):
        return self.ok("/api/state")["state"]


def wait_for_server():
    deadline = time.time() + 20
    while time.time() < deadline:
        try:
            urllib.request.urlopen(BASE + "/api/state", timeout=1)
            return
        except urllib.error.HTTPError:
            return
        except Exception:
            time.sleep(0.3)
    raise SystemExit("服务没有在 20 秒内启动")


def advance_to_node(client):
    for _ in range(10):
        state = client.state()
        if state["phase"] == "node":
            return state
        assert state["phase"] in ("before_story", "after_story"), state
        story = state.get("story") or {}
        assert not story.get("options"), "节点前置剧情不应含选项"
        client.ok("/api/story/advance", {"skip": False})
    raise AssertionError("无法进入节点")


def advance_to_map(client):
    for _ in range(10):
        state = client.state()
        if state["phase"] == "map":
            return state
        assert state["phase"] in ("before_story", "after_story"), state
        client.ok("/api/story/advance", {"skip": False})
    raise AssertionError("无法进入选关")


def map_status(state):
    return {node["id"]: node["status"] for node in state["map"]["nodes"]}


def play_loop(client, battle):
    for _ in range(100):
        if battle["phase"] == "over":
            return battle
        if battle["phase"] == "discard":
            uids = [card["uid"] for card in battle["hand"][: battle["discardRequired"]]]
            battle = client.ok("/api/battle/discard", {"uids": uids})["battle"]
            continue

        energy = battle["energy"]
        enemy_units = [(i + 1, unit) for i, unit in enumerate(battle["board"]["enemy"]) if unit]
        spark = next(
            (c for c in battle["hand"] if c.get("damage") is not None and c["cost"] <= energy), None
        )
        if spark and enemy_units:
            _, target = enemy_units[0]
            battle = client.ok(
                "/api/battle/command", {"uid": spark["uid"], "targetUid": target["uid"]}
            )["battle"]
            continue

        repair = next((c for c in battle["hand"] if c.get("heal") is not None and c["cost"] <= energy), None)
        damaged = [
            (i + 1, unit)
            for i, unit in enumerate(battle["board"]["player"])
            if unit and unit["hp"] < unit["maxHp"]
        ]
        if repair and damaged:
            _, target = damaged[0]
            battle = client.ok(
                "/api/battle/command", {"uid": repair["uid"], "targetUid": target["uid"]}
            )["battle"]
            continue

        units = sorted(
            (c for c in battle["hand"] if c["type"] == "unit" and c["cost"] <= energy),
            key=lambda c: c["cost"],
        )
        placed = False
        for card in units:
            for column in (4, 3, 2, 1):
                if battle["board"]["player"][column - 1] is None:
                    battle = client.ok(
                        "/api/battle/deploy", {"uid": card["uid"], "column": column}
                    )["battle"]
                    placed = True
                    break
            if placed:
                break
        if placed:
            continue
        battle = client.ok("/api/battle/end", {})["battle"]
    raise AssertionError("战斗没有在合理回合内结束")


def win_battle(client, encounter_id, extra_forecast=()):
    for attempt in range(8):
        battle = client.ok("/api/battle/reset", {})["battle"]
        assert battle["turn"] == 1 and battle["energy"] == 4 and len(battle["hand"]) == 6
        if attempt == 0 and encounter_id == "battle1":
            entries = {(item["turn"], item["column"]) for item in battle["forecast"]}
            assert entries == {(1, 1), (2, 3)}, entries
        if attempt == 0 and encounter_id == "battle2":
            entries = {(item["turn"], item["column"]) for item in battle["forecast"]}
            assert entries == {(1, 2), (1, 4), (2, 3)} | set(extra_forecast), entries
            assert all(item["turn"] in (1, 2) for item in battle["forecast"])
        battle = play_loop(client, battle)
        if battle["result"] == "win":
            client.ok("/api/battle/confirm", {})
            return
    raise AssertionError(f"{encounter_id} 多次重试仍未获胜")


def battle1_to_map(client, branch_option):
    advance_to_node(client)
    win_battle(client, "battle1")
    state = client.state()
    assert state["phase"] == "after_story" and state["gold"] == 20, state
    client.ok("/api/battle/confirm", {})
    assert client.state()["gold"] == 20, "重复确认不能重复发奖"

    client.ok("/api/story/advance", {"skip": True})
    state = client.state()
    assert state["phase"] == "after_story" and state["story"]["options"], state
    client.fail("/api/story/advance", {"skip": True})
    client.fail("/api/story/advance", {"skip": False})
    client.fail("/api/story/choose", {"optionId": "not-an-option"})
    client.ok("/api/story/choose", {"optionId": branch_option})
    client.fail("/api/story/choose", {"optionId": branch_option})
    state = advance_to_map(client)
    status = map_status(state)
    assert status["battle1"] == "completed"
    assert status["recruit"] == "available" and status["signal"] == "available", status
    assert status["adventure"] == "locked" and status["battle2"] == "locked", status
    assert status["shop"] == "locked" and status["trial"] == "locked", status
    for illegal in (
        "adventure", "calibration", "shop", "trial", "training", "drones", "battle2", "battle1"
    ):
        client.fail("/api/map/select", {"nodeId": illegal})
    return state


def adventure_phase(client, expected_card):
    advance_to_node(client)
    state = client.state()
    assert state["node"]["type"] == "adventure", state
    client.fail("/api/adventure/apply", {"cardId": "spark", "effect": "atk"})
    client.fail("/api/adventure/apply", {"cardId": "striker", "effect": "nope"})
    before = next(card for card in state["deck"] if card["cardId"] == expected_card)
    client.ok("/api/adventure/apply", {"cardId": expected_card, "effect": "hp"})
    state = client.state()
    assert state["phase"] == "after_story"
    after = next(card for card in state["deck"] if card["cardId"] == expected_card)
    assert after["hpBonus"] == before["hpBonus"] + 2, (before, after)
    assert after["atk"] == before["atk"]
    return after


def finish_route(client, node_id="adventure"):
    state = advance_to_map(client)
    status = map_status(state)
    assert status[node_id] == "available", status
    client.ok("/api/map/select", {"nodeId": node_id})
    return state


def calibration_phase(client, expected_card):
    advance_to_node(client)
    state = client.state()
    assert state["node"]["type"] == "calibration", state
    client.fail("/api/calibration/apply", {"cardId": "spark", "effect": "atk"})
    client.fail("/api/calibration/apply", {"cardId": "striker", "effect": "nope"})
    before = next(card for card in state["deck"] if card["cardId"] == expected_card)
    client.ok("/api/calibration/apply", {"cardId": expected_card, "effect": "level"})
    state = client.state()
    assert state["phase"] == "after_story"
    after = next(card for card in state["deck"] if card["cardId"] == expected_card)
    assert after["level"] == before["level"] + 1, (before, after)
    assert after["atkBonus"] == before["atkBonus"] and after["hpBonus"] == before["hpBonus"]
    return after


def drift_phase(client):
    advance_to_node(client)
    state = client.state()
    assert state["node"]["type"] == "drift", state
    drift = state["drift"]
    assert len(drift["candidates"]) == 3, drift
    client.fail("/api/drift/choose", {"cardId": "not-a-card"})
    assert client.state()["gold"] == drift["rerollPrice"]
    client.ok("/api/drift/reroll", {})
    state = client.state()
    assert state["gold"] == 0 and state["drift"]["rerolls"] == 1, state
    client.fail("/api/drift/reroll", {})
    assert client.state()["gold"] == 0
    candidate = state["drift"]["candidates"][0]
    deck_before = {card["cardId"]: card["level"] for card in state["deck"]}
    client.ok("/api/drift/choose", {"cardId": candidate["cardId"]})
    state = client.state()
    assert state["phase"] == "after_story"
    deck_after = {card["cardId"]: card["level"] for card in state["deck"]}
    if candidate["isUpgrade"]:
        assert deck_after[candidate["cardId"]] == deck_before[candidate["cardId"]] + 1
    else:
        assert candidate["cardId"] not in deck_before and deck_after[candidate["cardId"]] == 1
    return state


def recycle_phase(client, card_id):
    advance_to_node(client)
    state = client.state()
    assert state["node"]["type"] == "recycle", state
    client.fail("/api/recycle/apply", {"cardId": "not-a-card"})
    before = next(card for card in state["deck"] if card["cardId"] == card_id)
    price = 5 * before["cost"] + 5 * (before["level"] - 1)
    gold_before = state["gold"]
    client.ok("/api/recycle/apply", {"cardId": card_id})
    state = client.state()
    assert state["phase"] == "after_story"
    assert state["gold"] == gold_before + price, (gold_before, price, state["gold"])
    assert not any(card["cardId"] == card_id for card in state["deck"])
    return state


def shop_phase(client):
    advance_to_node(client)
    state = client.state()
    assert state["node"]["type"] == "shop", state
    shop = state["shop"]
    assert len(shop["offers"]) == 3, shop
    upgrade = next(offer for offer in shop["offers"] if offer["id"] == "ship_upgrade")
    assert upgrade["buyable"] and upgrade["price"] == 8, upgrade
    gold_before = state["gold"]
    client.ok("/api/shop/buy", {"offerId": "ship_upgrade"})
    state = client.state()
    assert state["phase"] == "after_story"
    assert state["gold"] == gold_before - upgrade["price"], (gold_before, state["gold"])
    client.ok("/api/shop/buy", {"offerId": "ship_guard"})
    assert client.state()["gold"] == gold_before - upgrade["price"], "同节点不能购买第二件"
    return state


def trial_phase(client):
    advance_to_node(client)
    state = client.state()
    assert state["node"]["type"] == "trial", state
    trial = state["trial"]
    assert trial["status"] == "choose" and len(trial["trials"]) == 2, trial
    pick = next(item for item in trial["trials"] if item["passed"])
    client.fail("/api/trial/choose", {"trialId": "not-a-trial"})
    client.ok("/api/trial/choose", {"trialId": pick["id"]})
    state = client.state()
    trial = state["trial"]
    assert trial["status"] == "success" and trial["candidates"], trial
    client.fail("/api/trial/claim", {})
    candidate = trial["candidates"][0]["cardId"]
    client.ok("/api/trial/choose-card", {"cardId": candidate})
    state = client.state()
    assert state["phase"] == "after_story"
    client.ok("/api/trial/leave", {})
    assert client.state()["phase"] == "after_story"
    return state


def relay_phase(client):
    advance_to_node(client)
    state = client.state()
    assert state["node"]["type"] == "relay", state
    assert state["relay"]["kept"] is False and state["relay"]["targets"], state["relay"]
    client.fail("/api/relay/choose", {"choice": "cut"})
    client.fail("/api/relay/cut", {"cardId": "spark"})
    client.ok("/api/relay/choose", {"choice": "keep"})
    state = client.state()
    assert state["phase"] == "after_story"
    client.ok("/api/relay/choose", {"choice": "keep"})
    assert client.state()["phase"] == "after_story"
    return state


def drones_phase(client):
    advance_to_node(client)
    state = client.state()
    assert state["node"]["type"] == "drones", state
    assert state["drones"]["atkBonus"] == 1 and state["drones"]["hpBonus"] == 1
    client.fail("/api/drones/apply", {"cardId": "spark", "effect": "atk"})
    client.fail("/api/drones/apply", {"cardId": "striker", "effect": "level"})
    before = next(card for card in state["deck"] if card["cardId"] == "striker")
    client.ok("/api/drones/apply", {"cardId": "striker", "effect": "atk"})
    state = client.state()
    assert state["phase"] == "after_story"
    after = next(card for card in state["deck"] if card["cardId"] == "striker")
    assert after["atkBonus"] == before["atkBonus"] + 1 and after["hpBonus"] == before["hpBonus"]
    client.ok("/api/drones/apply", {"cardId": "striker", "effect": "atk"})
    again = next(card for card in client.state()["deck"] if card["cardId"] == "striker")
    assert again["atkBonus"] == after["atkBonus"], "重复提交不能重复强化"
    return state


def drift_choose(client):
    advance_to_node(client)
    state = client.state()
    assert state["node"]["type"] == "drift", state
    candidate = state["drift"]["candidates"][0]
    client.ok("/api/drift/choose", {"cardId": candidate["cardId"]})
    assert client.state()["phase"] == "after_story"
    return client.state()


def training_phase(client):
    seen = []
    for _ in range(10):
        state = client.state()
        if state["phase"] == "node":
            break
        assert state["phase"] in ("before_story", "after_story"), state
        seen.append(state["story"]["text"])
        client.ok("/api/story/advance", {"skip": False})
    else:
        raise AssertionError("无法进入训练场节点")
    assert any("认出了它" in text for text in seen), seen
    state = client.state()
    assert state["node"]["type"] == "training", state
    assert len(state["training"]["challenges"]) == 2, state["training"]
    client.fail("/api/training/choose", {"challengeId": "not-a-challenge"})
    client.ok("/api/training/choose", {"challengeId": "overload"})
    state = client.state()
    assert state["phase"] == "after_story"
    assert state["pendingChallenge"]["id"] == "overload", state
    client.ok("/api/training/choose", {"challengeId": "low_power"})
    assert client.state()["pendingChallenge"]["id"] == "overload", "重复提交不能改挂挑战"
    return state


def recruit_route():
    name = "u" + "".join(random.choice("abcdefghijklmnopqrstuvwxyz0123456789") for _ in range(10))
    client = Client()
    client.ok("/api/register", {"username": name, "password": "test-pass-123"})
    state = client.state()
    assert state["phase"] == "before_story" and state["gold"] == 0, state
    assert len(state["deck"]) == 8

    state = battle1_to_map(client, "battle1_supply")
    client.ok("/api/logout", {})
    client.ok("/api/login", {"username": name, "password": "test-pass-123"})
    restored = client.state()
    assert restored["phase"] == "map" and restored["gold"] == state["gold"], restored
    assert restored["completed"] == state["completed"], "重新登录后进度丢失"
    print("ok 重新登录仍停留在选关")
    client.ok("/api/map/select", {"nodeId": "recruit"})
    client.fail("/api/map/select", {"nodeId": "signal"})
    state = client.state()
    assert state["route"] == {"supply": "recruit"} and state["phase"] == "before_story"
    assert "补给站" in state["story"]["text"], state["story"]

    advance_to_node(client)
    state = client.state()
    assert state["node"]["type"] == "recruit"
    client.ok("/api/recruit/buy", {"offerId": "bean"})
    state = client.state()
    assert state["gold"] == 10, state
    bean = next(card for card in state["deck"] if card["cardId"] == "bean")
    assert bean["level"] == 2 and len(state["deck"]) == 8
    client.ok("/api/recruit/buy", {"offerId": "guard"})
    assert client.state()["gold"] == 10, "同节点不能购买第二张"
    client.fail("/api/recruit/buy", {"offerId": "not-a-card"})
    client.ok("/api/recruit/leave", {})
    assert client.state()["phase"] == "after_story"

    state = finish_route(client, "calibration")
    assert map_status(state)["signal"] == "closed", state["map"]
    client.fail("/api/map/select", {"nodeId": "signal"})
    client.fail("/api/map/select", {"nodeId": "recruit"})
    client.fail("/api/map/select", {"nodeId": "adventure"})
    striker = calibration_phase(client, "striker")
    assert striker["level"] == 2 and striker["atkBonus"] == 0

    state = advance_to_map(client)
    status = map_status(state)
    assert status["adventure"] == "closed" and status["calibration"] == "completed", status
    assert status["drift_capsule"] == "available" and status["recycle_station"] == "available", status
    client.ok("/api/map/select", {"nodeId": "drift_capsule"})
    state = drift_phase(client)
    assert state["route"] == {
        "supply": "recruit",
        "repair": "calibration",
        "salvage": "drift",
    }, state

    state = advance_to_map(client)
    status = map_status(state)
    assert status["shop"] == "available" and status["trial"] == "available", status
    assert status["battle2"] == "locked", status
    client.ok("/api/map/select", {"nodeId": "trial"})
    state = trial_phase(client)
    assert state["route"] == {
        "supply": "recruit",
        "repair": "calibration",
        "salvage": "drift",
        "economy": "trial",
    }, state

    state = advance_to_map(client)
    status = map_status(state)
    assert status["shop"] == "closed" and status["battle2"] == "available", status
    client.ok("/api/map/select", {"nodeId": "battle2"})
    advance_to_node(client)
    assert client.state()["node"]["id"] == "battle2"
    win_battle(client, "battle2")
    state = client.state()
    assert state["gold"] == 0, "招募 + 卡匣重抽后金币应为 0，战斗 2 不发金币"
    for _ in range(5):
        state = client.state()
        if state["phase"] == "complete":
            break
        client.ok("/api/story/advance", {"skip": True})
    assert client.state()["phase"] == "complete"
    client.fail("/api/map/select", {"nodeId": "battle2"})
    print("ok 招募路线：战斗 1 → 招募 → 校准 → 卡匣 → 观测塔 → 战斗 2 → 完成")
    return client


def signal_route():
    name = "u" + "".join(random.choice("abcdefghijklmnopqrstuvwxyz0123456789") for _ in range(10))
    client = Client()
    client.ok("/api/register", {"username": name, "password": "test-pass-456"})
    state = battle1_to_map(client, "battle1_signal")
    client.ok("/api/map/select", {"nodeId": "signal"})
    client.fail("/api/map/select", {"nodeId": "recruit"})
    state = client.state()
    assert state["route"] == {"supply": "signal"} and state["phase"] == "before_story"
    assert "追着这个信号" in state["story"]["text"], state["story"]

    advance_to_node(client)
    state = client.state()
    assert state["node"]["type"] == "signal"
    client.fail("/api/signal/apply", {"action": "nope", "cardId": "striker"})
    client.fail("/api/signal/apply", {"action": "upgrade", "cardId": "spark"})
    striker_before = next(card for card in state["deck"] if card["cardId"] == "striker")
    client.ok("/api/signal/apply", {"action": "upgrade", "cardId": "striker"})
    state = client.state()
    assert state["phase"] == "after_story"
    striker = next(card for card in state["deck"] if card["cardId"] == "striker")
    assert striker["level"] == 2 and striker["atk"] > striker_before["atk"], (striker_before, striker)

    state = finish_route(client, "adventure")
    assert map_status(state)["recruit"] == "closed", state["map"]
    striker = adventure_phase(client, "striker")
    assert striker["level"] == 2 and striker["hpBonus"] == 2, striker

    state = advance_to_map(client)
    status = map_status(state)
    assert status["calibration"] == "closed" and status["adventure"] == "completed", status
    assert status["drift_capsule"] == "available" and status["recycle_station"] == "available", status
    client.ok("/api/map/select", {"nodeId": "recycle_station"})
    state = recycle_phase(client, "spark")
    assert state["gold"] == 30, state
    assert state["route"] == {
        "supply": "signal",
        "repair": "adventure",
        "salvage": "recycle",
    }, state

    state = advance_to_map(client)
    status = map_status(state)
    assert status["shop"] == "available" and status["trial"] == "available", status
    assert status["battle2"] == "locked", status
    client.ok("/api/map/select", {"nodeId": "shop"})
    state = shop_phase(client)
    assert state["gold"] == 22, state
    assert state["route"] == {
        "supply": "signal",
        "repair": "adventure",
        "salvage": "recycle",
        "economy": "shop",
    }, state

    state = advance_to_map(client)
    status = map_status(state)
    assert status["trial"] == "closed" and status["battle2"] == "available", status
    client.ok("/api/map/select", {"nodeId": "battle2"})
    advance_to_node(client)
    win_battle(client, "battle2")
    state = client.state()
    assert state["gold"] == 22, "回收获得 10 金币、商船花费 8 金币，战斗 2 不发金币"
    for _ in range(5):
        state = client.state()
        if state["phase"] == "complete":
            break
        client.ok("/api/story/advance", {"skip": True})
    assert client.state()["phase"] == "complete"
    print("ok 信号路线：战斗 1 → 信号 → 维修 → 回收 → 商船 → 战斗 2 → 完成")
    return client


def challenge_route():
    name = "u" + "".join(random.choice("abcdefghijklmnopqrstuvwxyz0123456789") for _ in range(10))
    client = Client()
    client.ok("/api/register", {"username": name, "password": "test-pass-789"})
    battle1_to_map(client, "battle1_signal")

    state = advance_to_map(client)
    assert map_status(state)["relay"] == "available", state["map"]
    client.ok("/api/map/select", {"nodeId": "relay"})
    state = relay_phase(client)
    assert state["route"] == {"supply": "relay"}, state

    state = advance_to_map(client)
    status = map_status(state)
    assert status["recruit"] == "closed" and status["signal"] == "closed", status
    assert status["drones"] == "available", status
    client.ok("/api/map/select", {"nodeId": "drones"})
    state = drones_phase(client)
    assert state["route"] == {"supply": "relay", "repair": "drones"}, state

    state = advance_to_map(client)
    assert map_status(state)["drift_capsule"] == "available", state["map"]
    client.ok("/api/map/select", {"nodeId": "drift_capsule"})
    drift_choose(client)

    state = advance_to_map(client)
    status = map_status(state)
    assert status["shop"] == "available" and status["training"] == "available", status
    assert status["battle2"] == "locked", status
    client.ok("/api/map/select", {"nodeId": "training"})
    state = training_phase(client)
    assert state["route"]["economy"] == "training", state

    state = advance_to_map(client)
    assert map_status(state)["battle2"] == "available", state["map"]
    client.ok("/api/map/select", {"nodeId": "battle2"})
    advance_to_node(client)
    assert client.state()["pendingChallenge"]["id"] == "overload"
    win_battle(client, "battle2", extra_forecast={(1, 1)})
    state = client.state()
    assert state["gold"] == 34, state
    assert state["pendingChallenge"] is None, "挑战应在胜利后清空"
    texts = []
    for _ in range(6):
        state = client.state()
        if state["phase"] == "complete":
            break
        texts.append(state["story"]["text"])
        client.ok("/api/story/advance", {"skip": False})
    assert state["phase"] == "complete", state
    assert any("中继站" in text for text in texts), texts
    print("ok 挑战路线：战斗 1 → 中继站 → 无人机 → 卡匣 → 训练场 → 战斗 2 → 完成")
    return client


def main():
    wait_for_server()

    anon = Client()
    anon.fail("/api/state", status=401)

    bad = Client()
    bad.fail("/api/register", {"username": "x", "password": "12345678"})
    bad.fail("/api/register", {"username": "validname", "password": "short"})

    recruit = recruit_route()
    recruit_state = recruit.state()
    assert recruit_state["complete"] and recruit_state["gold"] == 0

    signal = signal_route()
    signal_state = signal.state()
    assert signal_state["complete"] and signal_state["gold"] == 22

    challenge = challenge_route()
    challenge_state = challenge.state()
    assert challenge_state["complete"] and challenge_state["gold"] == 34
    print("ok 三条路线互斥、汇合与完成画面")

    # 新游戏需要确认；不影响另一账号
    recruit.fail("/api/game/new", {"confirm": False})
    recruit.ok("/api/game/new", {"confirm": True})
    state = recruit.state()
    assert state["phase"] == "before_story" and state["gold"] == 0
    assert state["node"]["id"] == "battle1"
    assert signal.state()["gold"] == 22, "账号隔离失败"
    assert challenge.state()["gold"] == 34, "账号隔离失败"
    print("ok 新游戏覆盖确认与账号隔离")

    recruit.ok("/api/logout", {})
    recruit.fail("/api/state", status=401)
    assert signal.state()["phase"] == "complete"
    print("ok 登出")

    print("端到端冒烟测试全部通过")


if __name__ == "__main__":
    main()
