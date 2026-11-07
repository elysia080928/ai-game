"""冒险流程与存档状态。状态是普通 dict，由调用方负责持久化。"""

import json
from pathlib import Path

from .battle import GameError, card_stats

_CONTENT_PATH = Path(__file__).resolve().parent.parent / "content" / "game.json"
with _CONTENT_PATH.open(encoding="utf-8") as _f:
    CONTENT = json.load(_f)

CARDS = CONTENT["cards"]
INITIAL_DECK = CONTENT["initialDeck"]
ENEMIES = CONTENT["enemies"]
ENCOUNTERS = CONTENT["encounters"]
NODES = CONTENT["nodes"]
RECRUIT = CONTENT["recruit"]
ADVENTURE = CONTENT["adventure"]

MAX_DECK = 20


def validate_content():
    if len(INITIAL_DECK) != len(set(INITIAL_DECK)):
        raise RuntimeError("初始牌组存在重复卡牌")
    for card_id in INITIAL_DECK:
        if card_id not in CARDS:
            raise RuntimeError(f"初始牌组引用了未知卡牌 {card_id}")
    for card_id, card in CARDS.items():
        if card["type"] not in ("unit", "command"):
            raise RuntimeError(f"卡牌 {card_id} 类型非法")
        if not card["levels"]:
            raise RuntimeError(f"卡牌 {card_id} 没有等级数据")
    for node in NODES:
        if node["type"] not in ("battle", "recruit", "adventure"):
            raise RuntimeError(f"节点 {node['id']} 类型非法")
        if node["type"] == "battle" and node["encounter"] not in ENCOUNTERS:
            raise RuntimeError(f"节点 {node['id']} 引用了未知遭遇")
        for slot in ("before", "after"):
            if slot not in node or not isinstance(node[slot], list):
                raise RuntimeError(f"节点 {node['id']} 缺少剧情插槽 {slot}")
    for encounter_id, encounter in ENCOUNTERS.items():
        if encounter["reward"]["gold"] < 0:
            raise RuntimeError(f"遭遇 {encounter_id} 奖励非法")
        for item in encounter["plan"]:
            if not (1 <= item["column"] <= 4):
                raise RuntimeError(f"遭遇 {encounter_id} 计划列号非法")
            if item["enemy"] not in ENEMIES:
                raise RuntimeError(f"遭遇 {encounter_id} 引用了未知敌人")
    for offer in RECRUIT["offers"]:
        if offer["id"] not in CARDS or offer["price"] <= 0:
            raise RuntimeError("招募配置非法")


validate_content()


def new_state():
    state = {
        "schemaVersion": 1,
        "nodeIndex": 0,
        "phase": "before_story",
        "storyLine": 0,
        "gold": 0,
        "cards": [{"cardId": card_id, "level": 1, "atkBonus": 0} for card_id in INITIAL_DECK],
        "completed": [],
        "nodeData": {},
    }
    _normalize(state)
    return state


def current_node(state):
    if 0 <= state["nodeIndex"] < len(NODES):
        return NODES[state["nodeIndex"]]
    return None


def story_lines(state):
    node = current_node(state)
    if node is None:
        return []
    if state["phase"] == "before_story":
        return node["before"]
    if state["phase"] == "after_story":
        return node["after"]
    return []


def _begin_node(state):
    node = current_node(state)
    state["phase"] = "node"
    state["storyLine"] = 0
    state["nodeData"] = {"purchased": False} if node["type"] == "recruit" else {}


def _advance_node(state):
    state["nodeIndex"] += 1
    state["storyLine"] = 0
    if state["nodeIndex"] >= len(NODES):
        state["phase"] = "complete"
        state["nodeData"] = {}
    else:
        state["phase"] = "before_story"


def _normalize(state):
    while True:
        node = current_node(state)
        if node is None:
            break
        if state["phase"] == "before_story" and not node["before"]:
            _begin_node(state)
            continue
        if state["phase"] == "after_story" and not node["after"]:
            _advance_node(state)
            continue
        break


def advance_story(state, skip_whole_slot=False):
    if state["phase"] not in ("before_story", "after_story"):
        raise GameError("当前不在剧情阶段")
    lines = story_lines(state)
    if skip_whole_slot:
        state["storyLine"] = len(lines)
    else:
        state["storyLine"] += 1
    if state["storyLine"] >= len(lines):
        if state["phase"] == "before_story":
            _begin_node(state)
        else:
            _advance_node(state)
    _normalize(state)


def finish_node(state, node_id):
    node = current_node(state)
    if node is None or node["id"] != node_id:
        raise GameError("当前节点不匹配")
    if state["phase"] != "node":
        if node_id in state["completed"]:
            return
        raise GameError("当前不在节点阶段")
    if node_id not in state["completed"]:
        state["completed"].append(node_id)
    state["phase"] = "after_story"
    state["storyLine"] = 0
    _normalize(state)


def confirm_battle_result(state):
    node = current_node(state)
    if node is None or node["type"] != "battle":
        raise GameError("当前不是战斗节点")
    if node["id"] in state["completed"]:
        return
    if state["phase"] != "node":
        raise GameError("当前不在战斗节点")
    reward = ENCOUNTERS[node["encounter"]]["reward"]["gold"]
    state["gold"] += reward
    finish_node(state, node["id"])


def _offer(offer_id):
    for offer in RECRUIT["offers"]:
        if offer["id"] == offer_id:
            return offer
    raise GameError("没有这个招募选项")


def _owned_card(state, card_id):
    for card in state["cards"]:
        if card["cardId"] == card_id:
            return card
    return None


def recruit_buy(state, offer_id):
    node = current_node(state)
    if node is None or node["type"] != "recruit":
        raise GameError("当前不是招募节点")
    offer = _offer(offer_id)
    if node["id"] in state["completed"] or state["nodeData"].get("purchased"):
        return
    if state["phase"] != "node":
        raise GameError("当前不在招募节点")
    card_id = offer["id"]
    max_level = len(CARDS[card_id]["levels"])
    owned = _owned_card(state, card_id)
    if owned is not None and owned["level"] >= max_level:
        raise GameError("该卡已经满级")
    if owned is None and len(state["cards"]) >= MAX_DECK:
        raise GameError("牌组已满，MVP 不支持替换")
    if state["gold"] < offer["price"]:
        raise GameError("金币不足")
    state["gold"] -= offer["price"]
    if owned is not None:
        owned["level"] += 1
    else:
        state["cards"].append({"cardId": card_id, "level": 1, "atkBonus": 0})
    state["nodeData"]["purchased"] = True


def recruit_leave(state):
    node = current_node(state)
    if node is None or node["type"] != "recruit":
        raise GameError("当前不是招募节点")
    finish_node(state, node["id"])


def adventure_choose(state, card_id):
    node = current_node(state)
    if node is None or node["type"] != "adventure":
        raise GameError("当前不是奇遇节点")
    if node["id"] in state["completed"]:
        return
    if state["phase"] != "node":
        raise GameError("当前不在奇遇节点")
    card = _owned_card(state, card_id)
    if card is None:
        raise GameError("你没有这张卡")
    if CARDS[card_id]["type"] != "unit":
        raise GameError("只能强化单位")
    card["atkBonus"] = card.get("atkBonus", 0) + ADVENTURE["attackBonus"]
    finish_node(state, node["id"])


def adventure_leave(state):
    node = current_node(state)
    if node is None or node["type"] != "adventure":
        raise GameError("当前不是奇遇节点")
    finish_node(state, node["id"])


def deck_view(state):
    result = []
    for card in state["cards"]:
        stats = card_stats(CARDS, card["cardId"], card["level"], card.get("atkBonus", 0))
        stats["atkBonus"] = card.get("atkBonus", 0)
        stats["effectText"] = _effect_text(stats)
        result.append(stats)
    return result


def _effect_text(stats):
    if stats["type"] != "command":
        return ""
    if stats.get("heal") is not None:
        return f"恢复 {stats['heal']} 点生命"
    if stats.get("damage") is not None:
        return f"造成 {stats['damage']} 点伤害"
    return ""


def _story_view(state):
    if state["phase"] not in ("before_story", "after_story"):
        return None
    lines = story_lines(state)
    if not lines:
        return None
    index = min(state["storyLine"], len(lines) - 1)
    line = lines[index]
    return {
        "speaker": line.get("speaker", ""),
        "text": line["text"],
        "line": index + 1,
        "total": len(lines),
    }


def _recruit_view(state):
    node = current_node(state)
    if node is None or node["type"] != "recruit" or state["phase"] != "node":
        return None
    offers = []
    for offer in RECRUIT["offers"]:
        card_id = offer["id"]
        max_level = len(CARDS[card_id]["levels"])
        owned = _owned_card(state, card_id)
        if owned is not None and owned["level"] >= max_level:
            continue
        offers.append(
            {
                "cardId": card_id,
                "name": CARDS[card_id]["name"],
                "price": offer["price"],
                "level": owned["level"] if owned else 0,
                "maxLevel": max_level,
            }
        )
    return {"offers": offers, "purchased": bool(state["nodeData"].get("purchased"))}


def _adventure_view(state):
    node = current_node(state)
    if node is None or node["type"] != "adventure" or state["phase"] != "node":
        return None
    targets = [card for card in deck_view(state) if card["type"] == "unit"]
    return {"targets": targets, "attackBonus": ADVENTURE["attackBonus"]}


def public_state(state):
    node = current_node(state)
    return {
        "phase": state["phase"],
        "gold": state["gold"],
        "nodeIndex": state["nodeIndex"],
        "totalNodes": len(NODES),
        "node": {"id": node["id"], "type": node["type"], "name": node["name"]} if node else None,
        "story": _story_view(state),
        "deck": deck_view(state),
        "completed": list(state["completed"]),
        "recruit": _recruit_view(state),
        "adventure": _adventure_view(state),
        "complete": state["phase"] == "complete",
    }
