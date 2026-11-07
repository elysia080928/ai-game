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
SIGNAL = CONTENT["signal"]
FIRST_NODE = CONTENT["firstNode"]
RUN_LENGTH = CONTENT["runLength"]
NODE_BY_ID = {node["id"]: node for node in NODES}

MAX_DECK = 20
SCHEMA_VERSION = 2
OLD_NODE_ORDER = ["battle1", "recruit", "adventure", "battle2"]
VALID_PHASES = ("before_story", "node", "after_story", "map", "complete")


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

    ids = set()
    for node in NODES:
        if node["id"] in ids:
            raise RuntimeError(f"节点 ID 重复：{node['id']}")
        ids.add(node["id"])
    if FIRST_NODE not in NODE_BY_ID:
        raise RuntimeError("首个节点不存在")
    if RUN_LENGTH <= 0:
        raise RuntimeError("runLength 非法")
    for node in NODES:
        if node["type"] not in ("battle", "recruit", "signal", "adventure"):
            raise RuntimeError(f"节点 {node['id']} 类型非法")
        if node["type"] == "battle" and node["encounter"] not in ENCOUNTERS:
            raise RuntimeError(f"节点 {node['id']} 引用了未知遭遇")
        if not isinstance(node.get("next"), list):
            raise RuntimeError(f"节点 {node['id']} 缺少后续节点")
        for next_id in node["next"]:
            if next_id not in NODE_BY_ID:
                raise RuntimeError(f"节点 {node['id']} 引用了未知后续节点 {next_id}")
        if "branch" in node and node["branch"] not in ("recruit", "signal"):
            raise RuntimeError(f"节点 {node['id']} 分支标记非法")
        for slot in ("before", "after"):
            lines = node.get(slot)
            if not isinstance(lines, list):
                raise RuntimeError(f"节点 {node['id']} 缺少剧情插槽 {slot}")
            for index, line in enumerate(lines):
                if not isinstance(line, dict) or not isinstance(line.get("text"), str):
                    raise RuntimeError(f"节点 {node['id']} 剧情第 {index + 1} 句非法")
                if "if" in line and not isinstance(line["if"], dict):
                    raise RuntimeError(f"节点 {node['id']} 剧情条件非法")
                options = line.get("options")
                if options is None:
                    continue
                if not isinstance(options, list) or not options:
                    raise RuntimeError(f"节点 {node['id']} 剧情选项非法")
                option_ids = set()
                for option in options:
                    if option.get("id") in option_ids:
                        raise RuntimeError(f"节点 {node['id']} 剧情选项 ID 重复")
                    option_ids.add(option.get("id"))
                    if not isinstance(option.get("text"), str):
                        raise RuntimeError(f"节点 {node['id']} 剧情选项缺少文本")
                    if "set" in option and not isinstance(option["set"], dict):
                        raise RuntimeError(f"节点 {node['id']} 剧情标记非法")
                    if "next" in option:
                        target = option["next"]
                        if (
                            not isinstance(target, int)
                            or isinstance(target, bool)
                            or not (index < target <= len(lines))
                        ):
                            raise RuntimeError(f"节点 {node['id']} 剧情选项跳转非法")

    for encounter_id, encounter in ENCOUNTERS.items():
        if encounter["reward"]["gold"] < 0:
            raise RuntimeError(f"遭遇 {encounter_id} 奖励非法")
        for item in encounter["plan"]:
            if item["turn"] < 1:
                raise RuntimeError(f"遭遇 {encounter_id} 计划回合非法")
            if not (1 <= item["column"] <= 4):
                raise RuntimeError(f"遭遇 {encounter_id} 计划列号非法")
            if item["enemy"] not in ENEMIES:
                raise RuntimeError(f"遭遇 {encounter_id} 引用了未知敌人")
    for offer in RECRUIT["offers"]:
        if offer["id"] not in CARDS or offer["price"] <= 0:
            raise RuntimeError("招募配置非法")
    for name, value in (("signal", SIGNAL["hpBonus"]),):
        if value < 0:
            raise RuntimeError(f"{name} 强化数值非法")
    if ADVENTURE["atkBonus"] < 0 or ADVENTURE["hpBonus"] < 0:
        raise RuntimeError("维修站强化数值非法")


validate_content()


def new_state():
    state = {
        "schemaVersion": SCHEMA_VERSION,
        "nodeId": FIRST_NODE,
        "phase": "before_story",
        "storyLine": 0,
        "gold": 0,
        "cards": [
            {"cardId": card_id, "level": 1, "atkBonus": 0, "hpBonus": 0}
            for card_id in INITIAL_DECK
        ],
        "completed": [],
        "nodeData": {},
        "route": None,
        "flags": {},
    }
    _normalize(state)
    return state


def current_node(state):
    return NODE_BY_ID.get(state.get("nodeId"))


def story_lines(state):
    node = current_node(state)
    if node is None:
        return []
    if state["phase"] == "before_story":
        return node["before"]
    if state["phase"] == "after_story":
        return node["after"]
    return []


def _line_visible(line, flags):
    condition = line.get("if")
    if not condition:
        return True
    return all(flags.get(key) == value for key, value in condition.items())


def _skip_invisible(state, lines):
    index = max(0, state["storyLine"])
    while index < len(lines) and not _line_visible(lines[index], state["flags"]):
        index += 1
    state["storyLine"] = index


def _begin_node(state):
    node = current_node(state)
    state["phase"] = "node"
    state["storyLine"] = 0
    state["nodeData"] = {"purchased": False} if node["type"] == "recruit" else {}


def _after_story_done(state):
    node = current_node(state)
    state["storyLine"] = 0
    state["nodeData"] = {}
    state["phase"] = "map" if node["next"] else "complete"


def _normalize(state):
    for _ in range(100):
        if state["phase"] == "complete":
            return
        node = current_node(state)
        if node is None:
            raise GameError("存档节点无效")
        if state["phase"] in ("before_story", "after_story"):
            lines = node["before"] if state["phase"] == "before_story" else node["after"]
            _skip_invisible(state, lines)
            if state["storyLine"] >= len(lines):
                if state["phase"] == "before_story":
                    _begin_node(state)
                else:
                    _after_story_done(state)
                continue
            return
        if state["phase"] in ("node", "map"):
            return
        raise GameError("存档阶段非法")
    raise GameError("剧情状态异常")


def _require_story(state):
    if state["phase"] not in ("before_story", "after_story"):
        raise GameError("当前不在剧情阶段")
    lines = story_lines(state)
    if state["storyLine"] >= len(lines):
        raise GameError("当前剧情已经结束")
    return lines


def advance_story(state, skip_whole_slot=False):
    """下一句只推进一句；跳过整段会在未完成的选项前停下。"""
    lines = _require_story(state)
    index = state["storyLine"]
    if lines[index].get("options"):
        raise GameError("请先做出剧情选择")
    if skip_whole_slot:
        index += 1
        while index < len(lines):
            if _line_visible(lines[index], state["flags"]) and lines[index].get("options"):
                state["storyLine"] = index
                return
            index += 1
        state["storyLine"] = len(lines)
    else:
        state["storyLine"] = index + 1
    _normalize(state)


def choose_story_option(state, option_id):
    lines = _require_story(state)
    index = state["storyLine"]
    option = next(
        (item for item in (lines[index].get("options") or []) if item.get("id") == option_id),
        None,
    )
    if option is None:
        raise GameError("无效的剧情选项")
    for key, value in (option.get("set") or {}).items():
        state["flags"][key] = value
    target = option.get("next", index + 1)
    if not isinstance(target, int) or isinstance(target, bool) or not (index < target <= len(lines)):
        raise GameError("剧情选项跳转非法")
    state["storyLine"] = target
    _normalize(state)


def finish_node(state, node_id):
    node = current_node(state)
    if node is None or node["id"] != node_id:
        raise GameError("当前节点不匹配")
    if node_id in state["completed"]:
        return
    if state["phase"] != "node":
        raise GameError("当前不在节点阶段")
    state["completed"].append(node_id)
    state["phase"] = "after_story"
    state["storyLine"] = 0
    state["nodeData"] = {}
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


def available_nodes(state):
    node = current_node(state)
    if node is None:
        return []
    result = []
    for node_id in node["next"]:
        if node_id in state["completed"]:
            continue
        branch = NODE_BY_ID[node_id].get("branch")
        if branch and state.get("route") and state["route"] != branch:
            continue
        result.append(node_id)
    return result


def map_view(state):
    if state["phase"] != "map":
        return None
    available = set(available_nodes(state))
    nodes = []
    for node in NODES:
        if node["id"] in state["completed"]:
            status = "completed"
        elif node["id"] in available:
            status = "available"
        elif node.get("branch") and state.get("route") and node["branch"] != state["route"]:
            status = "closed"
        else:
            status = "locked"
        nodes.append(
            {
                "id": node["id"],
                "name": node["name"],
                "type": node["type"],
                "branch": node.get("branch"),
                "status": status,
            }
        )
    return {"nodes": nodes, "route": state.get("route"), "available": list(available)}


def select_node(state, node_id):
    if state["phase"] != "map":
        raise GameError("当前不在关卡选择阶段")
    if node_id not in available_nodes(state):
        raise GameError("该节点当前不可进入")
    node = NODE_BY_ID[node_id]
    if node.get("branch") and state.get("route") is None:
        state["route"] = node["branch"]
    state["nodeId"] = node_id
    state["phase"] = "before_story"
    state["storyLine"] = 0
    state["nodeData"] = {}
    _normalize(state)


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
        state["cards"].append(
            {"cardId": card_id, "level": 1, "atkBonus": 0, "hpBonus": 0}
        )
    state["nodeData"]["purchased"] = True


def recruit_leave(state):
    node = current_node(state)
    if node is None or node["type"] != "recruit":
        raise GameError("当前不是招募节点")
    finish_node(state, node["id"])


def _require_unit_target(state, card_id):
    card = _owned_card(state, card_id)
    if card is None:
        raise GameError("你没有这张卡")
    if CARDS[card_id]["type"] != "unit":
        raise GameError("只能选择单位")
    return card


def signal_apply(state, action, card_id):
    node = current_node(state)
    if node is None or node["type"] != "signal":
        raise GameError("当前不是信号奇遇")
    if node["id"] in state["completed"]:
        return
    if state["phase"] != "node":
        raise GameError("当前不在信号奇遇")
    card = _require_unit_target(state, card_id)
    if action == "repair":
        card["hpBonus"] = card.get("hpBonus", 0) + SIGNAL["hpBonus"]
    elif action == "upgrade":
        if card["level"] >= len(CARDS[card_id]["levels"]):
            raise GameError("该单位已经满级")
        card["level"] += 1
    else:
        raise GameError("无效的信号奇遇选项")
    finish_node(state, node["id"])


def signal_leave(state):
    node = current_node(state)
    if node is None or node["type"] != "signal":
        raise GameError("当前不是信号奇遇")
    finish_node(state, node["id"])


def adventure_apply(state, card_id, effect):
    node = current_node(state)
    if node is None or node["type"] != "adventure":
        raise GameError("当前不是奇遇节点")
    if node["id"] in state["completed"]:
        return
    if state["phase"] != "node":
        raise GameError("当前不在奇遇节点")
    card = _require_unit_target(state, card_id)
    if effect == "atk":
        card["atkBonus"] = card.get("atkBonus", 0) + ADVENTURE["atkBonus"]
    elif effect == "hp":
        card["hpBonus"] = card.get("hpBonus", 0) + ADVENTURE["hpBonus"]
    else:
        raise GameError("无效的奇遇选项")
    finish_node(state, node["id"])


def adventure_leave(state):
    node = current_node(state)
    if node is None or node["type"] != "adventure":
        raise GameError("当前不是奇遇节点")
    finish_node(state, node["id"])


def _card_view(card):
    stats = card_stats(
        CARDS,
        card["cardId"],
        card["level"],
        card.get("atkBonus", 0),
        card.get("hpBonus", 0),
    )
    stats["atkBonus"] = card.get("atkBonus", 0)
    stats["hpBonus"] = card.get("hpBonus", 0)
    stats["effectText"] = _effect_text(stats)
    return stats


def deck_view(state):
    return [_card_view(card) for card in state["cards"]]


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
    if not lines or state["storyLine"] >= len(lines):
        return None
    line = lines[state["storyLine"]]
    view = {
        "speaker": line.get("speaker", ""),
        "text": line["text"],
        "line": state["storyLine"] + 1,
        "total": len(lines),
        "background": line.get("background"),
        "portrait": line.get("portrait"),
    }
    if line.get("options"):
        view["options"] = [
            {"id": option["id"], "text": option["text"]} for option in line["options"]
        ]
    return view


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


def _signal_view(state):
    node = current_node(state)
    if node is None or node["type"] != "signal" or state["phase"] != "node":
        return None
    targets = []
    for card in state["cards"]:
        if CARDS[card["cardId"]]["type"] != "unit":
            continue
        view = _card_view(card)
        max_level = len(CARDS[card["cardId"]]["levels"])
        view["canUpgrade"] = card["level"] < max_level
        view["repairPreview"] = card_stats(
            CARDS,
            card["cardId"],
            card["level"],
            card.get("atkBonus", 0),
            card.get("hpBonus", 0) + SIGNAL["hpBonus"],
        )
        if view["canUpgrade"]:
            view["upgradePreview"] = card_stats(
                CARDS,
                card["cardId"],
                card["level"] + 1,
                card.get("atkBonus", 0),
                card.get("hpBonus", 0),
            )
        targets.append(view)
    return {
        "hpBonus": SIGNAL["hpBonus"],
        "targets": targets,
        "hasRepairTarget": bool(targets),
        "hasUpgradeTarget": any(target["canUpgrade"] for target in targets),
    }


def _adventure_view(state):
    node = current_node(state)
    if node is None or node["type"] != "adventure" or state["phase"] != "node":
        return None
    targets = []
    for card in state["cards"]:
        if CARDS[card["cardId"]]["type"] != "unit":
            continue
        view = _card_view(card)
        view["atkPreview"] = card_stats(
            CARDS,
            card["cardId"],
            card["level"],
            card.get("atkBonus", 0) + ADVENTURE["atkBonus"],
            card.get("hpBonus", 0),
        )
        view["hpPreview"] = card_stats(
            CARDS,
            card["cardId"],
            card["level"],
            card.get("atkBonus", 0),
            card.get("hpBonus", 0) + ADVENTURE["hpBonus"],
        )
        targets.append(view)
    return {
        "targets": targets,
        "atkBonus": ADVENTURE["atkBonus"],
        "hpBonus": ADVENTURE["hpBonus"],
    }


def public_state(state):
    node = current_node(state)
    return {
        "phase": state["phase"],
        "gold": state["gold"],
        "node": {"id": node["id"], "type": node["type"], "name": node["name"]} if node else None,
        "story": _story_view(state),
        "deck": deck_view(state),
        "completed": list(state["completed"]),
        "route": state.get("route"),
        "progress": len(state["completed"]),
        "runLength": RUN_LENGTH,
        "recruit": _recruit_view(state),
        "signal": _signal_view(state),
        "adventure": _adventure_view(state),
        "map": map_view(state),
        "complete": state["phase"] == "complete",
    }


def migrate_state(state):
    """把旧档补成当前结构；无法安全读取时抛 ValueError。返回 (state, changed)。"""
    if not isinstance(state, dict):
        raise ValueError("存档结构非法")
    version = state.get("schemaVersion", 1)
    if not isinstance(version, int) or isinstance(version, bool) or version < 1:
        raise ValueError("存档版本非法")
    if version > SCHEMA_VERSION:
        raise ValueError("存档版本高于当前程序版本")
    before = json.dumps(state, sort_keys=True, ensure_ascii=False)

    if "nodeId" not in state:
        index = state.get("nodeIndex")
        if not isinstance(index, int) or isinstance(index, bool) or index < 0:
            raise ValueError("存档节点位置非法")
        if index >= len(OLD_NODE_ORDER):
            state["nodeId"] = OLD_NODE_ORDER[-1]
            state["phase"] = "complete"
        else:
            state["nodeId"] = OLD_NODE_ORDER[index]
        state.pop("nodeIndex", None)
    if state["nodeId"] not in NODE_BY_ID:
        raise ValueError("存档节点无效")
    if state.get("phase") not in VALID_PHASES:
        raise ValueError("存档阶段非法")

    completed = state.get("completed")
    if not isinstance(completed, list):
        raise ValueError("存档完成记录非法")
    if any(not isinstance(node_id, str) or node_id not in NODE_BY_ID for node_id in completed):
        raise ValueError("存档完成记录非法")
    if len(completed) != len(set(completed)):
        raise ValueError("存档完成记录重复")
    if state.get("route") not in (None, "recruit", "signal"):
        raise ValueError("存档路线非法")
    if "route" not in state:
        if "signal" in completed or state["nodeId"] == "signal":
            state["route"] = "signal"
        elif "recruit" in completed or state["nodeId"] in ("recruit", "adventure", "battle2"):
            state["route"] = "recruit"
        else:
            state["route"] = None
    if state["nodeId"] == "signal" and state["route"] is None:
        state["route"] = "signal"
    if state.get("phase") == "complete":
        state["nodeId"] = "battle2"

    flags = state.setdefault("flags", {})
    if not isinstance(flags, dict):
        raise ValueError("存档剧情标记非法")
    node_data = state.setdefault("nodeData", {})
    if not isinstance(node_data, dict):
        raise ValueError("存档节点数据非法")
    story_line = state.get("storyLine", 0)
    if not isinstance(story_line, int) or isinstance(story_line, bool) or story_line < 0:
        raise ValueError("存档剧情位置非法")
    state.setdefault("storyLine", 0)
    gold = state.get("gold")
    if not isinstance(gold, int) or isinstance(gold, bool) or gold < 0:
        raise ValueError("存档金币非法")
    cards = state.get("cards")
    if not isinstance(cards, list):
        raise ValueError("存档牌组非法")
    for card in cards:
        if not isinstance(card, dict) or card.get("cardId") not in CARDS:
            raise ValueError("存档卡牌非法")
        level = card.get("level")
        if not isinstance(level, int) or isinstance(level, bool) or not (
            1 <= level <= len(CARDS[card["cardId"]]["levels"])
        ):
            raise ValueError("存档卡牌等级非法")
        card.setdefault("atkBonus", 0)
        card.setdefault("hpBonus", 0)
        for bonus in (card["atkBonus"], card["hpBonus"]):
            if not isinstance(bonus, int) or isinstance(bonus, bool) or bonus < 0:
                raise ValueError("存档卡牌改造非法")

    state["schemaVersion"] = SCHEMA_VERSION
    _normalize(state)
    after = json.dumps(state, sort_keys=True, ensure_ascii=False)
    return state, before != after
