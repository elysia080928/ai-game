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
    state["route"] = route
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
    assert state["route"] == "recruit" and state["phase"] == "before_story"
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
    assert changed and migrated["nodeId"] == "recruit" and migrated["route"] == "recruit"
    assert migrated["cards"][0]["hpBonus"] == 0

    old = dict(base, nodeIndex=0, phase="after_story")
    migrated, _ = G.migrate_state(copy.deepcopy(old))
    assert migrated["nodeId"] == "battle1" and migrated["route"] is None
    assert migrated["phase"] == "after_story"

    old = dict(base, nodeIndex=2, phase="node", completed=["battle1", "recruit"])
    migrated, _ = G.migrate_state(copy.deepcopy(old))
    assert migrated["nodeId"] == "adventure" and migrated["route"] == "recruit"

    old = dict(base, nodeIndex=4, phase="complete",
               completed=["battle1", "recruit", "adventure", "battle2"])
    migrated, _ = G.migrate_state(copy.deepcopy(old))
    assert migrated["phase"] == "complete" and migrated["nodeId"] == "battle2"

    old = dict(base, nodeIndex=1, phase="before_story", storyLine=0)
    migrated, _ = G.migrate_state(copy.deepcopy(old))
    story = G.public_state(migrated)["story"]
    assert story["text"] == "挑一件合适的装备吧。", "无标记旧档应显示默认对话"

    bad_saves = [
        dict(base, nodeId="missing", nodeIndex=0),
        dict(base, nodeId="battle1", route="other"),
        dict(base, nodeId="battle1", storyLine=-1),
        dict(base, nodeId="battle1", completed=["battle1", "battle1"]),
        dict(base, nodeId="battle1", cards=[{"cardId": "bean", "level": 1, "hpBonus": -1}]),
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


if __name__ == "__main__":
    tests = [value for name, value in sorted(globals().items()) if name.startswith("test_")]
    for test in tests:
        test()
        print(f"ok {test.__name__}")
    print(f"{len(tests)} 项自检通过")
