"""规则自检脚本：python tests/test_rules.py（无需 pytest）。"""

import copy
import json
import random
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from app import battle as B  # noqa: E402
from app import game as G  # noqa: E402


def initial_cards():
    return [
        {"cardId": card_id, "level": 1, "atkBonus": 0, "hpBonus": 0}
        for card_id in G.INITIAL_DECK
    ]


def make(seed=0, encounter_id="battle1"):
    return B.make_battle(
        initial_cards(), G.ENCOUNTERS[encounter_id], G.CARDS, G.ENEMIES, rng=random.Random(seed)
    )


def state_at(node_id, phase, completed=None, route=None, flags=None):
    state = G.new_state()
    state["nodeId"] = node_id
    state["phase"] = phase
    state["storyLine"] = 0
    state["completed"] = list(completed or [])
    state["route"] = {"supply": route} if route else {}
    state["flags"] = dict(flags or {})
    state["nodeData"] = {}
    return state


def map_after_battle1(option_id="battle1_supply"):
    state = state_at("battle1", "after_story", completed=["battle1"])
    state["storyLine"] = 1
    G.choose_story_option(state, option_id)
    G.advance_story(state)
    assert state["phase"] == "map", state["phase"]
    return state


def test_opening_hand():
    for seed in range(300):
        b = make(seed)
        assert len(b["hand"]) == 6, seed
        low = [c for c in b["hand"] if B.card_stats(G.CARDS, c["cardId"], c["level"])["cost"] <= 2]
        assert len(low) >= 4, seed
        assert any(
            B.card_stats(G.CARDS, c["cardId"], c["level"])["type"] == "unit" for c in low
        ), seed
        assert all(c["cardId"] != "heavy" for c in b["hand"]), seed


def test_energy_and_high_cost_lock():
    b = make(3)
    assert b["turn"] == 1 and b["energy"] == 4
    B.end_turn(b, random.Random(1))
    assert b["turn"] == 2 and b["energy"] == 6
    assert all(c["cardId"] != "heavy" for c in b["hand"])
    B.end_turn(b, random.Random(2))
    assert b["turn"] == 3 and b["energy"] == 8
    assert any(c["cardId"] == "heavy" for c in b["hand"])


def test_recycle_refund():
    assert [B.recycle_refund(cost) for cost in range(1, 9)] == [1, 1, 1, 2, 2, 3, 3, 4]


def test_deploy_and_recycle():
    b = make(5)
    unit = next(
        c
        for c in b["hand"]
        if B.card_stats(G.CARDS, c["cardId"], c["level"])["type"] == "unit"
        and B.card_stats(G.CARDS, c["cardId"], c["level"])["cost"] <= 2
    )
    cost = B.card_stats(G.CARDS, unit["cardId"], unit["level"])["cost"]
    B.deploy(b, unit["uid"], 1)
    assert b["board"]["player"][0] is not None
    assert b["energy"] == 4 - cost
    assert unit["uid"] in b["used"]
    B.recycle(b, 1)
    assert b["board"]["player"][0] is None
    assert b["energy"] == 4 - cost + B.recycle_refund(cost)


def test_command_needs_valid_target():
    b = make(7)
    repair = next(c for c in b["hand"] if c["cardId"] == "repair")
    try:
        B.play_command(b, repair["uid"], 99999)
    except B.GameError:
        pass
    else:
        raise AssertionError("非法目标应被拒绝")
    assert b["energy"] == 4


def test_battle_terminates():
    b = make(11)
    for _ in range(40):
        if b["phase"] == "over":
            break
        B.end_turn(b, random.Random(99))
    assert b["phase"] == "over"
    assert b["result"] == "lose"


def test_recruit_purchase_once():
    state = state_at("recruit", "node", completed=["battle1"], route="recruit")
    state["gold"] = 20
    G.recruit_buy(state, "bean")
    assert state["gold"] == 10
    bean = next(c for c in state["cards"] if c["cardId"] == "bean")
    assert bean["level"] == 2
    assert bean["hpBonus"] == 0
    assert len(state["cards"]) == 8
    G.recruit_buy(state, "bean")
    assert state["gold"] == 10, "重复购买不能再次扣款"
    G.recruit_buy(state, "guard")
    assert state["gold"] == 10, "同一节点最多购买一次"
    assert len(state["cards"]) == 8


def test_recruit_insufficient_gold():
    state = state_at("recruit", "node", completed=["battle1"], route="recruit")
    state["gold"] = 5
    try:
        G.recruit_buy(state, "guard")
    except B.GameError:
        pass
    else:
        raise AssertionError("金币不足应被拒绝")
    assert state["gold"] == 5
    assert len(state["cards"]) == 8


def test_signal_and_adventure_leave_and_no_targets():
    state = state_at("signal", "node", completed=["battle1"], route="signal")
    view = G.public_state(state)["signal"]
    assert view["hasRepairTarget"] and view["hasUpgradeTarget"], view
    G.signal_leave(state)
    assert state["phase"] == "after_story" and "signal" in state["completed"]
    G.signal_leave(state)
    assert state["completed"].count("signal") == 1, "离开只能结算一次"

    empty = state_at("signal", "node", completed=["battle1"], route="signal")
    empty["cards"] = [{"cardId": "spark", "level": 1, "atkBonus": 0, "hpBonus": 0}]
    view = G.public_state(empty)["signal"]
    assert view["hasRepairTarget"] is False and view["hasUpgradeTarget"] is False, view

    adventure = state_at("adventure", "node", completed=["battle1", "signal"], route="signal")
    G.adventure_leave(adventure)
    assert adventure["phase"] == "after_story" and "adventure" in adventure["completed"]
    G.adventure_leave(adventure)
    assert adventure["completed"].count("adventure") == 1, "离开只能结算一次"


def test_adventure_attack_and_hp_once():
    state = state_at("adventure", "node", completed=["battle1", "recruit"], route="recruit")
    G.adventure_apply(state, "striker", "atk")
    striker = next(c for c in state["cards"] if c["cardId"] == "striker")
    assert striker["atkBonus"] == 1
    assert state["phase"] == "after_story"
    G.adventure_apply(state, "striker", "hp")
    assert striker["atkBonus"] == 1 and striker["hpBonus"] == 0, "节点完成后不能重复强化"

    state2 = state_at("adventure", "node", completed=["battle1", "signal"], route="signal")
    G.adventure_apply(state2, "bean", "hp")
    bean = next(c for c in state2["cards"] if c["cardId"] == "bean")
    assert bean["hpBonus"] == 2

    state3 = state_at("adventure", "node")
    try:
        G.adventure_apply(state3, "spark", "atk")
    except B.GameError:
        pass
    else:
        raise AssertionError("指令牌不能作为强化目标")


def test_signal_effects_and_stacking():
    state = state_at("signal", "node", completed=["battle1"], route="signal")
    striker = next(c for c in state["cards"] if c["cardId"] == "striker")
    striker["atkBonus"] = 1
    striker["hpBonus"] = 2
    G.signal_apply(state, "upgrade", "striker")
    assert striker["level"] == 2
    assert striker["atkBonus"] == 1 and striker["hpBonus"] == 2, "升级应保留改造"
    assert state["phase"] == "after_story"

    state2 = state_at("signal", "node", completed=["battle1"], route="signal")
    G.signal_apply(state2, "repair", "bean")
    bean = next(c for c in state2["cards"] if c["cardId"] == "bean")
    assert bean["hpBonus"] == 1
    G.signal_apply(state2, "upgrade", "bean")
    assert bean["hpBonus"] == 1, "节点完成后不能再次结算"

    state3 = state_at("signal", "node", completed=["battle1"], route="signal")
    heavy = next(c for c in state3["cards"] if c["cardId"] == "heavy")
    heavy["level"] = len(G.CARDS["heavy"]["levels"])
    try:
        G.signal_apply(state3, "upgrade", "heavy")
    except B.GameError:
        pass
    else:
        raise AssertionError("满级单位不能同步升级")

    state4 = state_at("signal", "node", completed=["battle1"], route="signal")
    try:
        G.signal_apply(state4, "repair", "spark")
    except B.GameError:
        pass
    else:
        raise AssertionError("指令牌不能获得信号改造")

    striker = next(c for c in state["cards"] if c["cardId"] == "striker")
    state["nodeId"] = "adventure"
    state["phase"] = "node"
    state["completed"] = ["battle1", "signal"]
    state["nodeData"] = {}
    G.adventure_apply(state, "striker", "hp")
    assert striker["hpBonus"] == 2 + G.ADVENTURE["hpBonus"]
    b = B.make_battle(
        [{"cardId": "bean", "level": 1, "atkBonus": 0, "hpBonus": striker["hpBonus"]} for _ in range(8)],
        {"playerHp": 15, "enemyHp": 15, "plan": []},
        G.CARDS,
        G.ENEMIES,
        rng=random.Random(1),
    )
    B.deploy(b, b["hand"][0]["uid"], 1)
    assert b["board"]["player"][0]["maxHp"] == G.CARDS["bean"]["levels"][0]["hp"] + striker["hpBonus"]


def test_forced_discard():
    deck = [{"cardId": "bean", "level": 1, "atkBonus": 0, "hpBonus": 0} for _ in range(12)]
    encounter = {"playerHp": 15, "enemyHp": 15, "plan": []}
    b = B.make_battle(deck, encounter, G.CARDS, G.ENEMIES, rng=random.Random(1))
    for _ in range(3):
        B.end_turn(b, random.Random(2))
    assert b["turn"] == 4
    assert b["phase"] == "discard", b["phase"]
    assert len(b["hand"]) == 12
    B.discard(b, [c["uid"] for c in b["hand"][:2]])
    assert b["phase"] == "player"
    assert len(b["hand"]) == 10
    assert len(b["discarded"]) == 2


def test_story_flow_and_new_game():
    state = G.new_state()
    assert state["phase"] == "before_story" and state["nodeId"] == "battle1"
    G.advance_story(state)
    assert state["phase"] == "node"
    assert G.current_node(state)["id"] == "battle1"
    state2 = G.new_state()
    assert state2["nodeId"] == "battle1" and state2["gold"] == 0
    assert len(state2["cards"]) == 8


def test_story_options_flags_and_skip():
    state = state_at("battle1", "after_story", completed=["battle1"])
    G.advance_story(state, skip_whole_slot=True)
    assert state["phase"] == "after_story" and state["storyLine"] == 1, "跳过整段应停在选项前"
    assert G.public_state(state)["story"]["options"]
    for skip in (True, False):
        try:
            G.advance_story(state, skip_whole_slot=skip)
        except B.GameError:
            pass
        else:
            raise AssertionError("未完成选项不能跳过")
    G.choose_story_option(state, "battle1_supply")
    assert state["flags"]["battle1_choice"] == "supply"
    try:
        G.choose_story_option(state, "battle1_supply")
    except B.GameError:
        pass
    else:
        raise AssertionError("重复选择应被拒绝")
    G.advance_story(state)
    assert state["phase"] == "map"

    G.select_node(state, "recruit")
    assert state["route"] == {"supply": "recruit"} and state["phase"] == "before_story"
    assert "补给站" in G.public_state(state)["story"]["text"]
    G.advance_story(state)
    G.advance_story(state)
    assert state["phase"] == "node"

    signal_state = map_after_battle1("battle1_signal")
    G.select_node(signal_state, "signal")
    assert "追着这个信号" in G.public_state(signal_state)["story"]["text"]


def test_map_branch_exclusivity_and_illegal_jumps():
    state = map_after_battle1()
    for bad in ("adventure", "battle2", "battle1", "signal"):
        if bad == "signal":
            continue
        try:
            G.select_node(state, bad)
        except B.GameError:
            pass
        else:
            raise AssertionError(f"非法节点 {bad} 不应可进入")
    G.select_node(state, "recruit")
    try:
        G.select_node(state, "signal")
    except B.GameError:
        pass
    else:
        raise AssertionError("进入节点后不能再次选关")
    G.advance_story(state)
    G.advance_story(state)
    G.recruit_leave(state)
    G.advance_story(state)
    assert state["phase"] == "map"
    status = {node["id"]: node["status"] for node in G.public_state(state)["map"]["nodes"]}
    assert status["battle1"] == "completed"
    assert status["recruit"] == "completed"
    assert status["signal"] == "closed"
    assert status["adventure"] == "available"
    assert status["battle2"] == "locked"
    try:
        G.select_node(state, "battle1")
    except B.GameError:
        pass
    else:
        raise AssertionError("已完成节点不能重玩")

    signal_state = map_after_battle1("battle1_signal")
    G.select_node(signal_state, "signal")
    G.advance_story(signal_state)
    G.advance_story(signal_state)
    G.signal_leave(signal_state)
    G.advance_story(signal_state)
    status = {node["id"]: node["status"] for node in G.public_state(signal_state)["map"]["nodes"]}
    assert status["signal"] == "completed"
    assert status["recruit"] == "closed"
    assert status["adventure"] == "available"


def test_empty_story_slots():
    node = G.NODE_BY_ID["signal"]
    saved = (node["before"], node["after"])
    try:
        node["before"] = []
        node["after"] = []
        state = state_at("signal", "before_story", completed=["battle1"], route="signal")
        G._normalize(state)
        assert state["phase"] == "node", "空前置剧情应直接进入节点"
        G.signal_leave(state)
        assert state["phase"] == "map", "空后置剧情结束后仍应进入选关"
    finally:
        node["before"], node["after"] = saved


def test_migration_old_saves():
    base = {
        "schemaVersion": 1,
        "phase": "before_story",
        "storyLine": 0,
        "gold": 20,
        "cards": [{"cardId": "bean", "level": 1}],
        "completed": ["battle1"],
        "nodeData": {"purchased": False},
    }
    old = dict(base, nodeIndex=1)
    migrated, changed = G.migrate_state(copy.deepcopy(old))
    assert changed and migrated["nodeId"] == "recruit" and migrated["route"] == {"supply": "recruit"}
    assert migrated["cards"][0]["hpBonus"] == 0
    assert migrated["pendingChallenges"] == []

    old = dict(base, nodeIndex=0, phase="after_story")
    migrated, _ = G.migrate_state(copy.deepcopy(old))
    assert migrated["nodeId"] == "battle1" and migrated["route"] == {}
    assert migrated["phase"] == "after_story"

    old = dict(base, nodeIndex=2, phase="node", completed=["battle1", "recruit"])
    migrated, _ = G.migrate_state(copy.deepcopy(old))
    assert migrated["nodeId"] == "adventure" and migrated["route"] == {"supply": "recruit"}

    old = dict(base, nodeIndex=4, phase="complete",
               completed=["battle1", "recruit", "adventure", "battle2"])
    migrated, _ = G.migrate_state(copy.deepcopy(old))
    assert migrated["phase"] == "complete" and migrated["nodeId"] == "battle2"

    old = dict(base, nodeIndex=1, phase="before_story", storyLine=0)
    migrated, _ = G.migrate_state(copy.deepcopy(old))
    story = G.public_state(migrated)["story"]
    assert story["text"] == "挑一件合适的装备吧。", "无标记旧档应显示默认对话"

    future = dict(base, schemaVersion=999, nodeId="battle1")
    try:
        G.migrate_state(future)
    except ValueError:
        pass
    else:
        raise AssertionError("未来版本存档不应被当作当前版本迁移")
    assert future["schemaVersion"] == 999, "被拒绝的存档不能被改写版本号"

    bad_saves = [
        dict(base, nodeId="missing", nodeIndex=0),
        dict(base, nodeId="battle1", route="other"),
        dict(base, nodeId="battle1", route={"supply": "adventure"}),
        dict(base, nodeId="battle1", storyLine=-1),
        dict(base, nodeId="battle1", completed=["battle1", "battle1"]),
        dict(base, nodeId="battle1", cards=[{"cardId": "bean", "level": 1, "hpBonus": -1}]),
        dict(base, nodeId="battle1", pendingChallenges="overload"),
        dict(base, nodeId="battle1", pendingChallenges=[{"id": "missing"}]),
    ]
    for bad in bad_saves:
        try:
            G.migrate_state(copy.deepcopy(bad))
        except ValueError:
            pass
        else:
            raise AssertionError(f"无法读取的存档应报错：{bad}")


def test_battle_hp_bonus_and_forecast():
    deck = [{"cardId": "bean", "level": 1, "atkBonus": 0, "hpBonus": 2} for _ in range(8)]
    b = B.make_battle(
        deck, {"playerHp": 15, "enemyHp": 15, "plan": []}, G.CARDS, G.ENEMIES, rng=random.Random(1)
    )
    B.deploy(b, b["hand"][0]["uid"], 1)
    assert b["board"]["player"][0]["maxHp"] == G.CARDS["bean"]["levels"][0]["hp"] + 2

    b = make(1, "battle2")
    forecast = B.view(b)["forecast"]
    keys = {(item["turn"], item["column"]) for item in forecast}
    assert (1, 2) in keys and (1, 4) in keys and (2, 3) in keys
    assert all(item["turn"] in (1, 2) for item in forecast)
    assert all(item["atk"] >= 0 and item["hp"] > 0 for item in forecast)
    B.end_turn(b, random.Random(2))
    keys = {(item["turn"], item["column"]) for item in B.view(b)["forecast"]}
    assert (2, 3) in keys and (3, 1) in keys
    assert all(item["turn"] in (2, 3) for item in B.view(b)["forecast"])

    encounter = {
        "playerHp": 15,
        "enemyHp": 15,
        "plan": [
            {"turn": 1, "column": 2, "enemy": "small_sentry"},
            {"turn": 1, "column": 2, "enemy": "defender"},
        ],
    }
    b = B.make_battle(initial_cards(), encounter, G.CARDS, G.ENEMIES, rng=random.Random(1))
    same_column = [item for item in B.view(b)["forecast"] if item["column"] == 2]
    assert len(same_column) == 2
    B.end_turn(b, random.Random(2))
    assert B.view(b)["forecast"] == [], "计划结束后不应继续预告"
    assert any("跳过" in line for line in b["log"]), "占列时应跳过且不换列"
    assert len([unit for unit in b["board"]["enemy"] if unit]) == 1


def test_calibration_effects():
    state = state_at("calibration", "node", completed=["battle1", "recruit"], route="recruit")
    G.calibration_apply(state, "striker", "atk")
    striker = next(c for c in state["cards"] if c["cardId"] == "striker")
    assert striker["atkBonus"] == G.CALIBRATION["atkBonus"]
    assert state["phase"] == "after_story"
    G.calibration_apply(state, "striker", "level")
    assert striker["level"] == 1, "节点完成后不能再次校准"

    state2 = state_at("calibration", "node", completed=["battle1", "recruit"], route="recruit")
    G.calibration_apply(state2, "bean", "level")
    bean = next(c for c in state2["cards"] if c["cardId"] == "bean")
    assert bean["level"] == 1 + G.CALIBRATION["levelBonus"]

    state3 = state_at("calibration", "node", completed=["battle1", "recruit"], route="recruit")
    heavy = next(c for c in state3["cards"] if c["cardId"] == "heavy")
    heavy["level"] = len(G.CARDS["heavy"]["levels"])
    try:
        G.calibration_apply(state3, "heavy", "level")
    except B.GameError:
        pass
    else:
        raise AssertionError("满级单位不能继续提升等级")

    state4 = state_at("calibration", "node", completed=["battle1", "recruit"], route="recruit")
    try:
        G.calibration_apply(state4, "spark", "atk")
    except B.GameError:
        pass
    else:
        raise AssertionError("指令牌不能作为校准目标")

    view = G.public_state(state3)["calibration"]
    heavy_view = next(c for c in view["targets"] if c["cardId"] == "heavy")
    assert heavy_view["canLevel"] is False


def test_recycle_station():
    state = state_at(
        "recycle_station", "node", completed=["battle1", "recruit", "adventure"], route="recruit"
    )
    assert state["gold"] == 0
    bean = next(c for c in state["cards"] if c["cardId"] == "bean")
    expected = G.recycle_price(bean)
    assert expected == 5 * bean["level"] + 0, "价格由费用和等级共同决定"
    G.recycle_apply(state, "bean")
    assert state["gold"] == expected
    assert len(state["cards"]) == 7
    assert not any(c["cardId"] == "bean" for c in state["cards"])
    assert state["phase"] == "after_story"
    G.recycle_apply(state, "shell")
    assert state["gold"] == expected, "节点完成后不能再次回收"

    one_unit = state_at(
        "recycle_station", "node", completed=["battle1", "recruit", "adventure"], route="recruit"
    )
    one_unit["cards"] = [{"cardId": "bean", "level": 1, "atkBonus": 0, "hpBonus": 0}]
    try:
        G.recycle_apply(one_unit, "bean")
    except B.GameError:
        pass
    else:
        raise AssertionError("不能移除最后一张单位牌")
    assert one_unit["gold"] == 0 and len(one_unit["cards"]) == 1

    view = G.public_state(one_unit)["recycle"]
    assert view["targets"][0]["removable"] is False

    empty = state_at(
        "recycle_station", "node", completed=["battle1", "recruit", "adventure"], route="recruit"
    )
    empty["cards"] = [{"cardId": "spark", "level": 1, "atkBonus": 0, "hpBonus": 0}]
    try:
        G.recycle_apply(empty, "spark")
    except B.GameError:
        pass
    else:
        raise AssertionError("不能把牌组清空")
    assert empty["phase"] == "node" and len(empty["cards"]) == 1


def test_drift_capsule():
    state = state_at(
        "drift_capsule", "node", completed=["battle1", "recruit", "adventure"], route="recruit"
    )
    state["nodeData"] = {"seed": 12345, "rerolls": 0}
    candidates = [c["cardId"] for c in G.public_state(state)["drift"]["candidates"]]
    assert len(candidates) == G.DRIFT["candidateCount"]
    assert candidates == G._drift_candidates(state), "同一存档的候选必须稳定"

    state["gold"] = G.DRIFT["rerollPrice"]
    G.drift_reroll(state)
    assert state["gold"] == 0 and state["nodeData"]["rerolls"] == 1
    rerolled = [c["cardId"] for c in G.public_state(state)["drift"]["candidates"]]
    assert rerolled == G._drift_candidates(state, 1)
    assert G.public_state(state)["drift"]["canReroll"] is False
    try:
        G.drift_reroll(state)
    except B.GameError:
        pass
    else:
        raise AssertionError("每个卡匣只能重抽一次")

    pick = rerolled[0]
    owned = next((c for c in state["cards"] if c["cardId"] == pick), None)
    G.drift_choose(state, pick)
    if owned is not None:
        assert owned["level"] == 2
        assert len(state["cards"]) == 8
    else:
        assert len(state["cards"]) == 9
        assert state["cards"][-1] == {
            "cardId": pick,
            "level": 1,
            "atkBonus": 0,
            "hpBonus": 0,
        }
    assert state["phase"] == "after_story"

    broke = state_at(
        "drift_capsule", "node", completed=["battle1", "recruit", "adventure"], route="recruit"
    )
    broke["nodeData"] = {"seed": 1, "rerolls": 0}
    broke["gold"] = G.DRIFT["rerollPrice"] - 1
    try:
        G.drift_reroll(broke)
    except B.GameError:
        pass
    else:
        raise AssertionError("金币不足不能重抽")
    assert broke["nodeData"]["rerolls"] == 0

    fresh = state_at(
        "drift_capsule", "node", completed=["battle1", "recruit", "adventure"], route="recruit"
    )
    fresh["nodeData"] = {"seed": 12345, "rerolls": 0}
    try:
        G.drift_choose(fresh, "missing")
    except B.GameError:
        pass
    else:
        raise AssertionError("候选外的卡不能选择")


def test_drones():
    state = state_at(
        "drones", "node", completed=["battle1", "signal"], route="signal"
    )
    view = G.public_state(state)["drones"]
    assert view["atkBonus"] == 1 and view["hpBonus"] == 1
    assert all(card["cardId"] != "spark" for card in view["targets"])

    striker = next(card for card in state["cards"] if card["cardId"] == "striker")
    before = G.card_stats(G.CARDS, "striker", 1, striker["atkBonus"], striker["hpBonus"])
    G.drones_apply(state, "striker", "atk")
    after = G.card_stats(G.CARDS, "striker", 1, striker["atkBonus"], striker["hpBonus"])
    assert after["atk"] == before["atk"] + 1
    assert state["phase"] == "after_story"
    G.drones_apply(state, "striker", "atk")
    assert striker["atkBonus"] == 1, "重复提交不能重复强化"

    hp_state = state_at("drones", "node", completed=["battle1", "signal"], route="signal")
    worker = next(card for card in hp_state["cards"] if card["cardId"] == "worker")
    G.drones_apply(hp_state, "worker", "hp")
    assert worker["hpBonus"] == 1

    for card_id, effect in (("spark", "atk"), ("striker", "level")):
        bad = state_at("drones", "node", completed=["battle1", "signal"], route="signal")
        try:
            G.drones_apply(bad, card_id, effect)
        except B.GameError:
            pass
        else:
            raise AssertionError("无人机只接受已有单位的攻击/生命强化")
        assert bad["phase"] == "node"

    leave = state_at("drones", "node", completed=["battle1", "signal"], route="signal")
    G.drones_leave(leave)
    assert leave["phase"] == "after_story"


def test_training_and_challenge_settlement():
    state = state_at(
        "training", "node",
        completed=["battle1", "relay", "adventure", "drift_capsule"], route="relay",
    )
    view = G.public_state(state)["training"]
    assert [item["id"] for item in view["challenges"]] == ["overload", "low_power"]
    try:
        G.training_choose(state, "missing")
    except B.GameError:
        pass
    else:
        raise AssertionError("未知训练挑战不能选择")

    G.training_choose(state, "overload")
    assert state["pendingChallenges"] == [{"id": "overload"}]
    assert state["phase"] == "after_story"
    assert G.public_state(state)["pendingChallenge"]["name"] == "过载演算"
    G.training_choose(state, "low_power")
    assert state["pendingChallenges"] == [{"id": "overload"}], "重复提交不能改挂挑战"

    settle = state_at(
        "battle2", "node",
        completed=["battle1", "relay", "adventure", "drift_capsule", "training"],
        route="relay",
    )
    settle["pendingChallenges"] = [{"id": "overload"}]
    gold = settle["gold"]
    G.confirm_battle_result(settle)
    assert settle["gold"] == gold + G.CHALLENGE_BY_ID["overload"]["reward"]
    assert settle["pendingChallenges"] == []
    G.confirm_battle_result(settle)
    assert settle["gold"] == gold + G.CHALLENGE_BY_ID["overload"]["reward"], "奖励只发一次"
    assert settle["phase"] == "after_story"

    leave = state_at("training", "node", completed=["battle1", "relay"], route="relay")
    G.training_leave(leave)
    assert leave["pendingChallenges"] == [] and leave["phase"] == "after_story"


def test_challenge_battle_modifiers():
    extra = [{"turn": 1, "column": 1, "enemy": "assault_sentry"}]
    b = B.make_battle(
        initial_cards(), G.ENCOUNTERS["battle2"], G.CARDS, G.ENEMIES,
        rng=random.Random(0), first_turn_energy=3, extra_plan=extra,
    )
    assert b["energy"] == 3
    assert any(item["column"] == 1 and item["enemy"] == "assault_sentry" for item in b["plan"])
    forecast = B.view(b)["forecast"]
    assert any(item["column"] == 1 and item["turn"] == 1 for item in forecast)

    normal = B.make_battle(
        initial_cards(), G.ENCOUNTERS["battle2"], G.CARDS, G.ENEMIES, rng=random.Random(0)
    )
    assert normal["energy"] == B.FIRST_TURN_ENERGY


def test_relay():
    keep = state_at("relay", "node", completed=["battle1"], route=None)
    assert G.public_state(keep)["relay"]["kept"] is False
    G.relay_keep(keep)
    assert keep["flags"]["relay_kept"] is True
    assert keep["phase"] == "after_story"
    G.relay_keep(keep)
    assert keep["phase"] == "after_story"

    cut = state_at("relay", "node", completed=["battle1"], route=None)
    striker = next(card for card in cut["cards"] if card["cardId"] == "striker")
    G.relay_cut(cut, "striker")
    assert striker["atkBonus"] == G.RELAY["atkBonus"]
    assert "relay_kept" not in cut["flags"]
    G.relay_cut(cut, "striker")
    assert striker["atkBonus"] == G.RELAY["atkBonus"], "重复提交不能重复强化"

    bad = state_at("relay", "node", completed=["battle1"], route=None)
    try:
        G.relay_cut(bad, "spark")
    except B.GameError:
        pass
    else:
        raise AssertionError("指令卡不能作为中继站强化目标")
    assert bad["phase"] == "node"

    leave = state_at("relay", "node", completed=["battle1"], route=None)
    G.relay_leave(leave)
    assert leave["phase"] == "after_story"

    flagged = state_at("battle2", "after_story", completed=["battle1", "relay"], flags={"relay_kept": True})
    G.advance_story(flagged)
    assert "中继站" in G.public_state(flagged)["story"]["text"]

    plain = state_at("battle2", "after_story", completed=["battle1", "relay"])
    G.advance_story(plain)
    assert plain["phase"] == "complete", "未保留信号时不应出现条件台词"


def test_four_layer_map_route():
    state = map_after_battle1()
    G.select_node(state, "recruit")
    G.advance_story(state)
    G.advance_story(state)
    G.recruit_leave(state)
    G.advance_story(state)
    status = {node["id"]: node["status"] for node in G.public_state(state)["map"]["nodes"]}
    assert status["adventure"] == "available" and status["calibration"] == "available"
    assert status["drones"] == "available" and status["relay"] == "closed"
    assert status["drift_capsule"] == "locked" and status["recycle_station"] == "locked"
    assert status["training"] == "locked"

    G.select_node(state, "calibration")
    assert state["route"] == {"supply": "recruit", "repair": "calibration"}
    G.advance_story(state)
    G.calibration_leave(state)
    G.advance_story(state)
    status = {node["id"]: node["status"] for node in G.public_state(state)["map"]["nodes"]}
    assert status["adventure"] == "closed" and status["calibration"] == "completed"
    assert status["drones"] == "closed"
    assert status["drift_capsule"] == "available" and status["battle2"] == "locked"
    try:
        G.select_node(state, "adventure")
    except B.GameError:
        pass
    else:
        raise AssertionError("已关闭的分支不能进入")

    G.select_node(state, "recycle_station")
    assert state["route"] == {
        "supply": "recruit",
        "repair": "calibration",
        "salvage": "recycle",
    }
    G.advance_story(state)
    G.recycle_leave(state)
    G.advance_story(state)
    status = {node["id"]: node["status"] for node in G.public_state(state)["map"]["nodes"]}
    assert status["drift_capsule"] == "closed"
    assert status["shop"] == "available" and status["trial"] == "available"
    assert status["training"] == "available"
    assert status["battle2"] == "locked"

    G.select_node(state, "shop")
    assert state["route"]["economy"] == "shop"
    G.advance_story(state)
    G.advance_story(state)
    G.shop_leave(state)
    G.advance_story(state)
    status = {node["id"]: node["status"] for node in G.public_state(state)["map"]["nodes"]}
    assert status["trial"] == "closed" and status["shop"] == "completed"
    assert status["training"] == "closed"
    assert status["battle2"] == "available"

    G.select_node(state, "battle2")
    assert state["phase"] == "before_story"
    G.advance_story(state)
    assert state["phase"] == "node"
    try:
        G.select_node(state, "battle2")
    except B.GameError:
        pass
    else:
        raise AssertionError("战斗中不能再次选关")


def shop_state(gold=30, cards=None):
    state = state_at(
        "shop", "node", completed=["battle1", "recruit", "adventure", "drift_capsule"],
        route="recruit",
    )
    state["gold"] = gold
    if cards is not None:
        state["cards"] = copy.deepcopy(cards)
    state["nodeData"] = {"purchased": False}
    return state


def test_shop():
    state = shop_state(gold=30)
    view = G.public_state(state)["shop"]
    assert [offer["kind"] for offer in view["offers"]] == ["new", "upgrade", "boost"]
    assert all(offer["buyable"] for offer in view["offers"])

    striker = next(card for card in state["cards"] if card["cardId"] == "striker")
    before = G.card_stats(G.CARDS, "striker", 1, striker["atkBonus"], striker["hpBonus"])["atk"]
    G.shop_buy(state, "ship_boost")
    after = G.card_stats(G.CARDS, "striker", 1, striker["atkBonus"], striker["hpBonus"])["atk"]
    assert after == before + 1 and state["gold"] == 24
    assert state["phase"] == "after_story"
    G.shop_buy(state, "ship_guard")
    assert state["gold"] == 24, "本节点只能购买一次"

    upgrade = shop_state(gold=30)
    worker = next(card for card in upgrade["cards"] if card["cardId"] == "worker")
    worker["level"] = 2
    view = G.public_state(upgrade)["shop"]
    offer = next(item for item in view["offers"] if item["id"] == "ship_upgrade")
    assert offer["buyable"] is False and offer["reason"] == "已满级"
    try:
        G.shop_buy(upgrade, "ship_upgrade")
    except B.GameError:
        pass
    else:
        raise AssertionError("满级卡不能购买升级")

    fresh = shop_state(gold=30)
    G.shop_buy(fresh, "ship_guard")
    assert fresh["cards"][-1]["cardId"] == "guard" and fresh["gold"] == 14
    view = shop_state(gold=30)
    view["cards"].append({"cardId": "guard", "level": 1, "atkBonus": 0, "hpBonus": 0})
    offer = next(item for item in G.public_state(view)["shop"]["offers"] if item["id"] == "ship_guard")
    assert offer["reason"] == "已拥有同名卡"

    broke = shop_state(gold=G.SHOP["offers"][0]["price"] - 1)
    offer = next(item for item in G.public_state(broke)["shop"]["offers"] if item["id"] == "ship_guard")
    assert offer["reason"] == "金币不足"
    try:
        G.shop_buy(broke, "ship_guard")
    except B.GameError:
        pass
    else:
        raise AssertionError("金币不足不能购买")

    full = shop_state(gold=30, cards=[{"cardId": "bean", "level": 1, "atkBonus": 0, "hpBonus": 0}] * 20)
    offer = next(item for item in G.public_state(full)["shop"]["offers"] if item["id"] == "ship_guard")
    assert offer["reason"] == "牌组已满"

    leave = shop_state()
    G.shop_leave(leave)
    assert leave["phase"] == "after_story" and leave["completed"][-1] == "shop"
    G.shop_leave(leave)
    assert leave["completed"].count("shop") == 1

    try:
        G.shop_buy(shop_state(), "missing")
    except B.GameError:
        pass
    else:
        raise AssertionError("未知商品不能购买")


def trial_state(seed, gold=0, cards=None):
    state = state_at(
        "trial", "node", completed=["battle1", "recruit", "adventure", "drift_capsule"],
        route="recruit",
    )
    state["gold"] = gold
    if cards is not None:
        state["cards"] = copy.deepcopy(cards)
    state["nodeData"] = {"seed": seed, "status": "choose", "trialId": None, "candidates": []}
    return state


def find_seed(predicate):
    for seed in range(1, 500):
        state = trial_state(seed)
        if predicate(G.public_state(state)["trial"]["trials"]):
            return seed
    raise AssertionError("没有找到满足条件的随机种子")


def test_trial():
    seed = find_seed(lambda trials: len(trials) == 2)
    state = trial_state(seed, gold=0)
    offered = [item["id"] for item in G.public_state(state)["trial"]["trials"]]
    assert len(offered) == 2
    assert offered == [item["id"] for item in G._trial_offered(trial_state(seed))]
    try:
        G.trial_choose(state, "missing")
    except B.GameError:
        pass
    else:
        raise AssertionError("候选外的试炼不能选择")

    passing = find_seed(
        lambda trials: any(item["id"] in ("light", "power") and item["passed"] for item in trials)
    )
    state = trial_state(passing)
    pick = next(
        item["id"]
        for item in G.public_state(state)["trial"]["trials"]
        if item["id"] in ("light", "power") and item["passed"]
    )
    G.trial_choose(state, pick)
    view = G.public_state(state)["trial"]
    assert view["status"] == "success" and view["trialId"] == pick
    assert len(view["candidates"]) == min(G.TRIAL["candidateCount"], len(G._drift_pool(state)))
    assert [card["cardId"] for card in view["candidates"]] == state["nodeData"]["candidates"]
    try:
        G.trial_claim(state)
    except B.GameError:
        pass
    else:
        raise AssertionError("成功的试炼不能领取补偿")
    try:
        G.trial_choose_card(state, "missing")
    except B.GameError:
        pass
    else:
        raise AssertionError("候选外的奖励不能选择")
    G.trial_choose_card(state, view["candidates"][0]["cardId"])
    assert state["phase"] == "after_story"

    heavy_deck = [
        {"cardId": card_id, "level": 1, "atkBonus": 0, "hpBonus": 0}
        for card_id in ("striker", "heavy", "guard", "flyer")
    ]

    def light_fails(trials):
        return any(item["id"] == "light" and not item["passed"] for item in trials)

    failing = None
    for seed in range(1, 500):
        candidate = trial_state(seed, cards=heavy_deck)
        if light_fails(G.public_state(candidate)["trial"]["trials"]):
            failing = candidate
            break
    assert failing is not None, "没有找到轻量编队失败的种子"
    state = failing
    G.trial_choose(state, "light")
    assert state["nodeData"]["status"] == "failed"
    try:
        G.trial_choose_card(state, "bean")
    except B.GameError:
        pass
    else:
        raise AssertionError("失败的试炼不能选奖励")
    gold = state["gold"]
    G.trial_claim(state)
    assert state["gold"] == gold + G.TRIAL["failureGold"]
    assert state["phase"] == "after_story"
    G.trial_claim(state)
    assert state["gold"] == gold + G.TRIAL["failureGold"]

    leave = trial_state(seed)
    G.trial_leave(leave)
    assert leave["phase"] == "after_story"

    maxed = [
        {"cardId": card_id, "level": 2, "atkBonus": 0, "hpBonus": 0}
        for card_id in G.CARDS
    ]
    state = trial_state(seed, cards=maxed)
    pick = G.public_state(state)["trial"]["trials"][0]["id"]
    G.trial_choose(state, pick)
    view = G.public_state(state)["trial"]
    assert view["status"] == "success" and view["hasCandidates"] is False
    try:
        G.trial_choose_card(state, "bean")
    except B.GameError:
        pass
    else:
        raise AssertionError("没有奖励候选时不能选卡")
    G.trial_leave(state)
    assert state["phase"] == "after_story"


if __name__ == "__main__":
    tests = [value for name, value in sorted(globals().items()) if name.startswith("test_")]
    for test in tests:
        test()
        print(f"ok {test.__name__}")
    print(f"{len(tests)} 项自检通过")
