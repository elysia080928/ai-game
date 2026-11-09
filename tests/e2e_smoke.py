"""端到端冒烟测试：python tests/e2e_smoke.py（需要先启动服务）。

验证注册、随机地图、路线互斥、遭遇预告、精英奖励、镜像核心、存档恢复与账号隔离。
"""

import http.cookiejar
import json
import os
import random
import time
import urllib.error
import urllib.request
from pathlib import Path

BASE = os.environ.get("BASE_URL", "http://127.0.0.1:8099")
CONTENT = json.loads((Path(__file__).resolve().parent.parent / "content" / "game.json").read_text("utf-8"))


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


def advance_state(client):
    """推进剧情，直到回到地图或完成。"""
    for _ in range(30):
        state = client.state()
        if state["phase"] in ("map", "complete"):
            return state
        assert state["phase"] in ("before_story", "after_story"), state
        story = state.get("story") or {}
        if story.get("options"):
            client.ok("/api/story/choose", {"optionId": story["options"][0]["id"]})
        else:
            client.ok("/api/story/advance", {"skip": True})
    raise AssertionError("剧情无法推进")


def advance_to_node(client):
    for _ in range(30):
        state = client.state()
        if state["phase"] == "node":
            return state
        assert state["phase"] in ("before_story", "after_story"), state
        story = state.get("story") or {}
        if story.get("options"):
            client.ok("/api/story/choose", {"optionId": story["options"][0]["id"]})
        else:
            client.ok("/api/story/advance", {"skip": True})
    raise AssertionError("无法进入节点")


def map_status(state):
    return {node["id"]: node["status"] for node in state["map"]["nodes"]}


def expected_forecast(encounter_id):
    plan = CONTENT["encounters"][encounter_id]["plan"]
    expected = set()
    for item in plan:
        if item["turn"] not in (1, 2):
            continue
        enemy = CONTENT["enemies"][item["enemy"]]
        expected.add((
            item["turn"],
            item["column"],
            enemy["name"],
            enemy["atk"],
            enemy["hp"],
            enemy.get("width", 1),
            enemy.get("attackPattern", "forward"),
            tuple(enemy.get("abilities", [])),
            enemy.get("shield", 0),
            enemy.get("guard", 0),
            enemy.get("shift", 0),
            enemy.get("anchor", 0),
            enemy.get("onDeploy"),
            enemy.get("onDestroy"),
        ))
    return expected


def battle_forecast(battle):
    return {
        (
            item["turn"],
            item["column"],
            item["name"],
            item["atk"],
            item["hp"],
            item["width"],
            item["attackPattern"],
            tuple(item["abilities"]),
            item["shield"],
            item["guard"],
            item["shift"],
            item["anchor"],
            item["onDeploy"],
            item["onDestroy"],
        )
        for item in battle["forecast"]
    }


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
            width = card.get("width", 1)
            for column in range(5 - width, 0, -1):
                if all(
                    battle["board"]["player"][column - 1 + offset] is None
                    for offset in range(width)
                ):
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


def win_battle(client, encounter_id, expected_hand=6):
    for attempt in range(8):
        battle = client.ok("/api/battle/reset", {})["battle"]
        assert battle["turn"] == 1 and battle["energy"] == 4, battle
        assert len(battle["hand"]) == expected_hand, (expected_hand, len(battle["hand"]))
        assert battle_forecast(battle) == expected_forecast(encounter_id), (attempt, battle["forecast"])
        battle = play_loop(client, battle)
        if battle["result"] == "win":
            client.ok("/api/battle/confirm", {})
            return
    raise AssertionError(f"{encounter_id} 多次重试仍未获胜")


def find_path(adjacency, start, goal):
    queue = [(start, [start])]
    seen = {start}
    while queue:
        node_id, path = queue.pop(0)
        if node_id == goal:
            return path
        for child in adjacency.get(node_id, ()):
            if child not in seen:
                seen.add(child)
                queue.append((child, path + [child]))
    raise AssertionError(f"地图缺少 {start} -> {goal} 的路线")


def plan_elite_route(state):
    nodes = {node["id"]: node for node in state["map"]["nodes"]}
    adjacency = {}
    for edge in state["map"]["edges"]:
        adjacency.setdefault(edge["from"], []).append(edge["to"])
    elite = next(node_id for node_id, node in nodes.items() if node["role"] == "elite")
    boss = next(node_id for node_id, node in nodes.items() if node["role"] == "boss")
    current = state["completed"][-1]
    route = find_path(adjacency, current, elite)[1:] + find_path(adjacency, elite, boss)[1:]
    assert len(route) == state["runLength"] - 1, (route, state["runLength"])
    roles = [nodes[node_id]["role"] for node_id in route]
    assert "elite" in roles and "late" in roles and "boss" in roles, roles
    expected = 4 if state["mapType"] == "map2" else 2
    assert sum(1 for role in roles if role == "battle") == expected, roles
    assert sum(1 for role in roles if role == "event") == expected, roles
    event_types = [nodes[node_id]["type"] for node_id in route if nodes[node_id]["role"] == "event"]
    assert len(event_types) == len(set(event_types)), event_types
    return route


def complete_event(client, node_type):
    client.ok(f"/api/{node_type}/leave", {})
    assert client.state()["phase"] == "after_story"


def test_route(client):
    state = advance_to_node(client)
    assert state["node"]["role"] == "start", state["node"]
    early_encounter = state["node"]["encounter"]
    assert early_encounter in ("battle1", "early_patrol", "early_pincer")
    early_reward = CONTENT["encounters"][early_encounter]["reward"]["gold"]
    win_battle(client, early_encounter)
    state = client.state()
    assert state["phase"] == "after_story" and state["gold"] == early_reward, state
    assert state["eliteReward"] is None, "普通战不应出现三选一奖励"
    client.ok("/api/battle/confirm", {})
    assert client.state()["gold"] == early_reward, "重复确认不能重复发奖"

    state = advance_state(client)
    assert state["phase"] == "map" and state["map"]["runLength"] == 8, state
    map_before = state["map"]
    route = plan_elite_route(state)
    statuses = set(map_status(state).values())
    assert "locked" in statuses, statuses
    assert len(map_before["nodes"]) == len(state["map"]["nodes"])

    # 地图与遭遇随存档持久化，重新登录不会重抽。
    client.ok("/api/logout", {})
    assert client.request("/api/state")[0] == 401
    client.ok("/api/login", {"username": client.username, "password": client.password})
    restored = client.state()
    assert restored["phase"] == "map"
    assert restored["map"] == map_before, "重新登录后地图发生变化"

    siblings = []
    first_expected = route[0]
    available = restored["map"]["available"]
    assert first_expected in available, (first_expected, available)
    siblings = [node_id for node_id in available if node_id != first_expected]
    locked = next(node_id for node_id, status in map_status(restored).items() if status == "locked")
    client.fail("/api/map/select", {"nodeId": locked})
    client.fail("/api/map/select", {"nodeId": restored["completed"][-1]})

    first_step = True
    while route:
        expected = route.pop(0)
        state = advance_state(client)
        assert state["phase"] == "map", state
        assert expected in state["map"]["available"], (expected, state["map"]["available"])
        if siblings and not first_step:
            for sibling in siblings:
                assert map_status(state)[sibling] == "closed", (sibling, state["map"])
            siblings = []
        first_step = False
        client.ok("/api/map/select", {"nodeId": expected})
        state = advance_to_node(client)
        assert state["node"]["id"] == expected, (state["node"], expected)
        node = state["node"]
        gold_before = state["gold"]
        if node["type"] == "battle":
            win_battle(client, node["encounter"])
            state = client.state()
            reward = CONTENT["encounters"][node["encounter"]]["reward"]["gold"]
            assert state["gold"] == gold_before + reward, (node, gold_before, state["gold"])
            if node["role"] == "elite":
                assert state["phase"] == "elite_reward", state
                reward_view = state["eliteReward"]
                assert len(reward_view["candidates"]) == 3, reward_view
                assert reward_view["deckFull"] is False
                deck_before = len(state["deck"])
                uids_before = {card["uid"] for card in state["deck"]}
                pick = reward_view["candidates"][0]["cardId"]
                client.ok("/api/elite/reward/choose", {"cardId": pick})
                state = client.state()
                assert state["phase"] == "after_story"
                assert len(state["deck"]) == deck_before + 1, state["deck"]
                assert len({card["uid"] for card in state["deck"]}) == len(state["deck"])
                assert state["deck"][-1]["uid"] not in uids_before
                assert state["deck"][-1]["cardId"] == pick
                client.ok("/api/elite/reward/choose", {"cardId": pick})
                assert len(client.state()["deck"]) == deck_before + 1, "重复领奖不能重复加卡"
                client.ok("/api/elite/reward/leave", {})
                assert len(client.state()["deck"]) == deck_before + 1
            else:
                assert state["phase"] == "after_story", state
        else:
            complete_event(client, node["type"])
        if node["role"] == "boss":
            assert CONTENT["encounters"][node["encounter"]]["reward"]["gold"] == 0, "终点战不应配置金币奖励"
    state = advance_to_node(client)
    assert state["phase"] == "node" and state["mapType"] == "map2", state
    assert state["node"]["role"] == "start", state["node"]
    assert state["canStartMap2"] is False
    assert state["gold"] == 0 and len(state["deck"]) == 8, state
    return state


def test_second_map(client):
    state = client.state()
    assert state["phase"] == "node" and state["mapType"] == "map2", state
    assert state["canStartMap2"] is False
    assert state["gold"] == 0, state
    assert len(state["deck"]) == 8 and state["map"] is None

    state = advance_to_node(client)
    assert state["node"]["role"] == "start", state["node"]
    win_battle(client, state["node"]["encounter"])
    state = advance_state(client)
    assert state["phase"] == "map" and state["mapType"] == "map2", state
    assert state["runLength"] == 12, state
    assert sorted({node["column"] for node in state["map"]["nodes"]}) == list(range(12)), state
    boss_node = next(node for node in state["map"]["nodes"] if node["role"] == "boss")
    assert boss_node["column"] == 11, boss_node
    assert boss_node["encounter"] == "boss2" and boss_node["name"] == "深层核心", boss_node

    map_before = state["map"]
    client.ok("/api/logout", {})
    client.ok("/api/login", {"username": client.username, "password": client.password})
    restored = client.state()
    assert restored["phase"] == "map" and restored["map"] == map_before, "第二张地图刷新后变化"
    assert restored["mapType"] == "map2" and restored["runLength"] == 12

    route = plan_elite_route(restored)
    while route:
        expected = route.pop(0)
        state = advance_state(client)
        assert state["phase"] == "map", state
        assert expected in state["map"]["available"], (expected, state["map"]["available"])
        client.ok("/api/map/select", {"nodeId": expected})
        state = advance_to_node(client)
        node = state["node"]
        if node["type"] == "battle":
            win_battle(client, node["encounter"])
            state = client.state()
            if node["role"] == "elite":
                assert state["phase"] == "elite_reward", state
                assert len(state["eliteReward"]["candidates"]) == 3
                pick = state["eliteReward"]["candidates"][0]["cardId"]
                client.ok("/api/elite/reward/choose", {"cardId": pick})
                client.ok("/api/elite/reward/leave", {})
            else:
                assert state["phase"] == "after_story", state
        else:
            complete_event(client, node["type"])
    state = advance_state(client)
    assert state["phase"] == "complete" and state["mapType"] == "map2", state
    assert len(state["completed"]) == 12
    assert state["canStartMap2"] is False
    client.fail("/api/game/map2", {})
    return state


def main():
    wait_for_server()

    anon = Client()
    anon.fail("/api/state", status=401)

    bad = Client()
    bad.fail("/api/register", {"username": "x", "password": "12345678"})
    bad.fail("/api/register", {"username": "validname", "password": "short"})

    name = "u" + "".join(random.choice("abcdefghijklmnopqrstuvwxyz0123456789") for _ in range(10))
    client = Client()
    client.username = name
    client.password = "test-pass-123"
    client.ok("/api/register", {"username": name, "password": client.password})
    state = client.state()
    assert state["phase"] == "before_story" and state["gold"] == 0, state
    assert state["node"]["role"] == "start" and "mapData" not in state
    assert len(state["deck"]) == 8 and len({card["uid"] for card in state["deck"]}) == 8
    assert state["map"] is None
    assert state["runLength"] == 8

    other = Client()
    other_name = "u" + "".join(random.choice("abcdefghijklmnopqrstuvwxyz0123456789") for _ in range(10))
    other.ok("/api/register", {"username": other_name, "password": "test-pass-456"})
    other_initial = other.state()

    other.fail("/api/game/map2", {})
    finished = test_route(client)
    assert finished["complete"] is False and finished["mapType"] == "map2"
    assert finished["phase"] == "node" and finished["node"]["role"] == "start"

    finished = test_second_map(client)
    assert finished["complete"] is True and finished["mapType"] == "map2"

    assert other.state() == other_initial, "账号隔离失败"

    client.fail("/api/game/new", {"confirm": False})
    client.ok("/api/game/new", {"confirm": True})
    state = client.state()
    assert state["phase"] == "before_story" and state["gold"] == 0
    assert state["node"]["role"] == "start"
    assert state["runLength"] == 8
    assert state["mapType"] == "map1" and state["canStartMap2"] is False
    assert other.state() == other_initial, "新游戏不应影响其他账号"

    client.ok("/api/logout", {})
    client.fail("/api/state", status=401)
    print("ok 随机地图路线、第二张地图、遭遇预告、精英奖励、存档恢复、账号隔离与完成画面")
    print("端到端冒烟测试全部通过")


if __name__ == "__main__":
    main()
