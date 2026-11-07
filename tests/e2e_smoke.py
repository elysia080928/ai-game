"""端到端冒烟测试：python tests/e2e_smoke.py（需要先启动服务）。

验证注册、剧情选项与跳过、选关、两条四节点路线、奇遇、预告、重复请求与账号隔离。
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


def win_battle(client, encounter_id):
    for attempt in range(8):
        battle = client.ok("/api/battle/reset", {})["battle"]
        assert battle["turn"] == 1 and battle["energy"] == 4 and len(battle["hand"]) == 6
        if attempt == 0 and encounter_id == "battle1":
            entries = {(item["turn"], item["column"]) for item in battle["forecast"]}
            assert entries == {(1, 1), (2, 3)}, entries
        if attempt == 0 and encounter_id == "battle2":
            entries = {(item["turn"], item["column"]) for item in battle["forecast"]}
            assert entries == {(1, 2), (1, 4), (2, 3)}, entries
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
    for illegal in ("adventure", "battle2", "battle1"):
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


def finish_route(client):
    state = advance_to_map(client)
    status = map_status(state)
    assert status["adventure"] == "available", status
    client.ok("/api/map/select", {"nodeId": "adventure"})
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
    assert state["route"] == "recruit" and state["phase"] == "before_story"
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

    state = finish_route(client)
    assert map_status(state)["signal"] == "closed", state["map"]
    client.fail("/api/map/select", {"nodeId": "signal"})
    client.fail("/api/map/select", {"nodeId": "recruit"})
    striker = adventure_phase(client, "striker")
    assert striker["level"] == 1 and striker["hpBonus"] == 2

    state = advance_to_map(client)
    assert map_status(state)["battle2"] == "available"
    client.ok("/api/map/select", {"nodeId": "battle2"})
    advance_to_node(client)
    assert client.state()["node"]["id"] == "battle2"
    win_battle(client, "battle2")
    state = client.state()
    assert state["gold"] == 10, "战斗 2 不发金币"
    for _ in range(5):
        state = client.state()
        if state["phase"] == "complete":
            break
        client.ok("/api/story/advance", {"skip": True})
    assert client.state()["phase"] == "complete"
    client.fail("/api/map/select", {"nodeId": "battle2"})
    print("ok 招募路线：战斗 1 → 招募 → 维修 → 战斗 2 → 完成")
    return client


def signal_route():
    name = "u" + "".join(random.choice("abcdefghijklmnopqrstuvwxyz0123456789") for _ in range(10))
    client = Client()
    client.ok("/api/register", {"username": name, "password": "test-pass-456"})
    state = battle1_to_map(client, "battle1_signal")
    client.ok("/api/map/select", {"nodeId": "signal"})
    client.fail("/api/map/select", {"nodeId": "recruit"})
    state = client.state()
    assert state["route"] == "signal" and state["phase"] == "before_story"
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

    state = finish_route(client)
    assert map_status(state)["recruit"] == "closed", state["map"]
    striker = adventure_phase(client, "striker")
    assert striker["level"] == 2 and striker["hpBonus"] == 2, striker

    state = advance_to_map(client)
    assert map_status(state)["battle2"] == "available"
    client.ok("/api/map/select", {"nodeId": "battle2"})
    advance_to_node(client)
    win_battle(client, "battle2")
    state = client.state()
    assert state["gold"] == 20, "信号路线不经过招募，战斗 2 不发金币"
    for _ in range(5):
        state = client.state()
        if state["phase"] == "complete":
            break
        client.ok("/api/story/advance", {"skip": True})
    assert client.state()["phase"] == "complete"
    print("ok 信号路线：战斗 1 → 信号 → 维修 → 战斗 2 → 完成")
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
    assert recruit_state["complete"] and recruit_state["gold"] == 10

    signal = signal_route()
    signal_state = signal.state()
    assert signal_state["complete"] and signal_state["gold"] == 20
    print("ok 两条路线互斥、汇合与完成画面")

    # 新游戏需要确认；不影响另一账号
    recruit.fail("/api/game/new", {"confirm": False})
    recruit.ok("/api/game/new", {"confirm": True})
    state = recruit.state()
    assert state["phase"] == "before_story" and state["gold"] == 0
    assert state["node"]["id"] == "battle1"
    assert signal.state()["gold"] == 20, "账号隔离失败"
    print("ok 新游戏覆盖确认与账号隔离")

    recruit.ok("/api/logout", {})
    recruit.fail("/api/state", status=401)
    assert signal.state()["phase"] == "complete"
    print("ok 登出")

    print("端到端冒烟测试全部通过")


if __name__ == "__main__":
    main()
