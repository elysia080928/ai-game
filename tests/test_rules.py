"""规则自检脚本：python tests/test_rules.py（无需 pytest）。"""

import random
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from app import battle as B  # noqa: E402
from app import game as G  # noqa: E402


def initial_cards():
    return [{"cardId": card_id, "level": 1, "atkBonus": 0} for card_id in G.INITIAL_DECK]


def make(seed=0, encounter_id="battle1"):
    return B.make_battle(
        initial_cards(), G.ENCOUNTERS[encounter_id], G.CARDS, G.ENEMIES, rng=random.Random(seed)
    )


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
    state = G.new_state()
    state["nodeIndex"] = 1
    state["phase"] = "node"
    state["nodeData"] = {"purchased": False}
    state["gold"] = 20
    G.recruit_buy(state, "bean")
    assert state["gold"] == 10
    bean = next(c for c in state["cards"] if c["cardId"] == "bean")
    assert bean["level"] == 2
    assert len(state["cards"]) == 8
    G.recruit_buy(state, "bean")
    assert state["gold"] == 10, "重复购买不能再次扣款"
    G.recruit_buy(state, "guard")
    assert state["gold"] == 10, "同一节点最多购买一次"
    assert len(state["cards"]) == 8


def test_recruit_insufficient_gold():
    state = G.new_state()
    state["nodeIndex"] = 1
    state["phase"] = "node"
    state["nodeData"] = {"purchased": False}
    state["gold"] = 5
    try:
        G.recruit_buy(state, "guard")
    except B.GameError:
        pass
    else:
        raise AssertionError("金币不足应被拒绝")
    assert state["gold"] == 5
    assert len(state["cards"]) == 8


def test_adventure_once():
    state = G.new_state()
    state["nodeIndex"] = 2
    state["phase"] = "node"
    state["nodeData"] = {}
    G.adventure_choose(state, "striker")
    striker = next(c for c in state["cards"] if c["cardId"] == "striker")
    assert striker["atkBonus"] == 1
    G.adventure_choose(state, "striker")
    assert striker["atkBonus"] == 1, "节点完成后不能重复强化"


def test_forced_discard():
    deck = [{"cardId": "bean", "level": 1, "atkBonus": 0} for _ in range(12)]
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
    assert state["phase"] == "before_story" and state["nodeIndex"] == 0
    G.advance_story(state)
    assert state["phase"] == "node"
    assert G.current_node(state)["id"] == "battle1"
    state2 = G.new_state()
    assert state2["nodeIndex"] == 0 and state2["gold"] == 0
    assert len(state2["cards"]) == 8


if __name__ == "__main__":
    tests = [value for name, value in sorted(globals().items()) if name.startswith("test_")]
    for test in tests:
        test()
        print(f"ok {test.__name__}")
    print(f"{len(tests)} 项自检通过")
