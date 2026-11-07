"""端到端冒烟测试：python tests/e2e_smoke.py（需要先启动服务）。

依次验证：注册、越权、剧情推进、两场战斗、招募、奇遇、完成、重复提交与新局覆盖、账号隔离。
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
        client.ok("/api/story/advance", {"skip": False})
    raise AssertionError("无法进入节点")


def play_battle(client):
    battle = client.ok("/api/battle/reset", {})["battle"]
    for _ in range(80):
        if battle["phase"] == "over":
            break
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

    assert battle["phase"] == "over", battle["phase"]
    if battle["result"] != "win":
        return False
    client.ok("/api/battle/confirm", {})
    return True


def win_battle(client):
    for _ in range(8):
        if play_battle(client):
            return
    raise AssertionError("多次重试仍未获胜")


def main():
    wait_for_server()

    # 未登录访问
    anon = Client()
    anon.fail("/api/state", status=401)

    name = "u" + "".join(random.choice("abcdefghijklmnopqrstuvwxyz0123456789") for _ in range(10))
    client = Client()
    client.fail("/api/register", {"username": "x", "password": "12345678"})
    client.fail("/api/register", {"username": name, "password": "short"})
    client.ok("/api/register", {"username": name, "password": "test-pass-123"})
    state = client.state()
    assert state["phase"] == "before_story" and state["gold"] == 0, state
    assert len(state["deck"]) == 8
    print("ok 注册与新存档")

    # 战斗 1
    advance_to_node(client)
    battle = client.ok("/api/battle/reset", {})["battle"]
    assert battle["turn"] == 1 and battle["energy"] == 4 and len(battle["hand"]) == 6
    assert battle["forecast"], "战斗开始时应有敌方预告"
    client.fail("/api/battle/deploy", {"uid": 999999, "column": 1})
    win_battle(client)
    state = client.state()
    assert state["phase"] == "after_story" and state["gold"] == 20, state
    # 重复确认不能重复发奖
    client.ok("/api/battle/confirm", {})
    assert client.state()["gold"] == 20
    print("ok 战斗 1、胜利奖励与重复确认")

    # 招募
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
    print("ok 招募、同名升级与单次购买")

    # 奇遇
    advance_to_node(client)
    state = client.state()
    assert state["node"]["type"] == "adventure"
    before = next(card for card in state["deck"] if card["cardId"] == "striker")
    client.ok("/api/adventure/choose", {"cardId": "striker"})
    state = client.state()
    assert state["phase"] == "after_story"
    striker = next(card for card in state["deck"] if card["cardId"] == "striker")
    assert striker["atk"] == before["atk"] + 1, (before, striker)
    print("ok 奇遇强化")

    # 战斗 2
    advance_to_node(client)
    state = client.state()
    assert state["node"]["id"] == "battle2"
    win_battle(client)
    state = client.state()
    assert state["gold"] == 10, "战斗 2 不发金币"
    print("ok 战斗 2（无奖励）")

    # 完成
    for _ in range(10):
        state = client.state()
        if state["phase"] == "complete":
            break
        assert state["phase"] in ("after_story", "before_story"), state
        client.ok("/api/story/advance", {"skip": True})
    assert client.state()["phase"] == "complete"
    print("ok 完成画面")

    # 新游戏需要确认
    client.fail("/api/game/new", {"confirm": False})
    client.ok("/api/game/new", {"confirm": True})
    state = client.state()
    assert state["phase"] == "before_story" and state["gold"] == 0 and state["nodeIndex"] == 0
    print("ok 新游戏覆盖确认")

    # 账号隔离
    other = Client()
    other_name = "v" + "".join(random.choice("abcdefghijklmnopqrstuvwxyz0123456789") for _ in range(10))
    other.ok("/api/register", {"username": other_name, "password": "test-pass-456"})
    assert other.state()["gold"] == 0
    assert client.state()["gold"] == 0
    other.fail("/api/game/new", {"confirm": False})
    print("ok 账号隔离")

    # 登出
    client.ok("/api/logout", {})
    client.fail("/api/state", status=401)
    print("ok 登出")

    print("端到端冒烟测试全部通过")


if __name__ == "__main__":
    main()
