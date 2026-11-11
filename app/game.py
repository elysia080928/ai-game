"""冒险流程与存档状态。状态是普通 dict，由调用方负责持久化。"""

import copy
import json
import random
import uuid
from pathlib import Path

from .battle import (
    ATTACK_PATTERNS,
    KNOWN_ABILITIES,
    ON_DEPLOY_TRIGGERS,
    ON_DESTROY_TRIGGERS,
    GameError,
    card_stats,
)

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
CALIBRATION = CONTENT["calibration"]
RECYCLE = CONTENT["recycle"]
DRIFT = CONTENT["drift"]
SHOP = CONTENT["shop"]
TRIAL = CONTENT["trial"]
DRONES = CONTENT["drones"]
TRAINING = CONTENT["training"]
RELAY = CONTENT["relay"]
CHALLENGE_BY_ID = {item["id"]: item for item in TRAINING["challenges"]}
SIGNAL = CONTENT["signal"]
FIRST_NODE = CONTENT["firstNode"]
RUN_LENGTH = CONTENT["runLength"]
NODE_BY_ID = {node["id"]: node for node in NODES}
TEMPLATE_BY_TYPE = {node["type"]: node for node in NODES if node["type"] != "battle"}
BRANCH_PAIRS = {
    (node["branchGroup"], node["branch"]) for node in NODES if node.get("branchGroup")
}
MAP_CONFIG = CONTENT.get("mapGeneration") or {}
MAP_EVENT_TYPES = tuple(MAP_CONFIG.get("eventTypes") or ())
BATTLE_POOLS = MAP_CONFIG.get("battlePools") or {}
MAP_TEMPLATES = MAP_CONFIG.get("templates") or {}
MAP_RUN_LENGTHS = tuple(MAP_CONFIG.get("runLengths") or ())
MAP_MAX_BRANCHES = MAP_CONFIG.get("maxBranches", 3)
SECOND_MAP_CONFIG = CONTENT.get("secondMap") or {}
SECOND_MAP_RUN_LENGTHS = tuple(SECOND_MAP_CONFIG.get("runLengths") or ())
SECOND_MAP_MAX_BRANCHES = SECOND_MAP_CONFIG.get("maxBranches", MAP_MAX_BRANCHES)
SECOND_MAP_TEMPLATES = {**MAP_TEMPLATES, **(SECOND_MAP_CONFIG.get("templates") or {})}
THIRD_MAP_CONFIG = CONTENT.get("thirdMap") or {}
THIRD_MAP_RUN_LENGTHS = tuple(THIRD_MAP_CONFIG.get("runLengths") or ())
THIRD_MAP_MAX_BRANCHES = THIRD_MAP_CONFIG.get("maxBranches", MAP_MAX_BRANCHES)
THIRD_MAP_TEMPLATES = {**MAP_TEMPLATES, **(THIRD_MAP_CONFIG.get("templates") or {})}
MAP_META = {
    "chapter": MAP_CONFIG.get("chapter", "第一章"),
    "title": MAP_CONFIG.get("title", "回路边境"),
    "subtitle": MAP_CONFIG.get("subtitle", "THE BORDERLANDS"),
    "caption": MAP_CONFIG.get("caption", "一张尚未写完的地图"),
    "destination": MAP_CONFIG.get("destination", "镜像核心"),
}
SECOND_MAP_META = {
    "chapter": SECOND_MAP_CONFIG.get("chapter", "第二章"),
    "title": SECOND_MAP_CONFIG.get("title", "深层回路"),
    "subtitle": SECOND_MAP_CONFIG.get("subtitle", "THE DEEP CIRCUIT"),
    "caption": SECOND_MAP_CONFIG.get("caption", "第二条路线"),
    "destination": SECOND_MAP_CONFIG.get("destination", "深层核心"),
}
THIRD_MAP_META = {
    "chapter": THIRD_MAP_CONFIG.get("chapter", "第三章"),
    "title": THIRD_MAP_CONFIG.get("title", "静海档案"),
    "subtitle": THIRD_MAP_CONFIG.get("subtitle", "THE ABYSSAL ARCHIVE"),
    "caption": THIRD_MAP_CONFIG.get("caption", "沉在海底的记忆库"),
    "destination": THIRD_MAP_CONFIG.get("destination", "海渊中枢"),
}
MAPS = {
    "map1": {
        "runLengths": MAP_RUN_LENGTHS,
        "maxBranches": MAP_MAX_BRANCHES,
        "middleBattles": MAP_CONFIG.get("middleBattles", 0),
        "extraBattleNodes": MAP_CONFIG.get("extraBattleNodes", 0),
        "extraEventNodes": MAP_CONFIG.get("extraEventNodes", 0),
        "eventTypes": MAP_EVENT_TYPES,
        "battlePools": BATTLE_POOLS,
        "templates": MAP_TEMPLATES,
        "bossEncounter": "boss",
        "bossTemplate": "boss",
        "startEncounter": "tutorial",
        "startTemplate": "tutorial_start",
        "meta": MAP_META,
    },
    "map2": {
        "runLengths": SECOND_MAP_RUN_LENGTHS,
        "maxBranches": SECOND_MAP_MAX_BRANCHES,
        "middleBattles": SECOND_MAP_CONFIG.get("middleBattles", 0),
        "extraBattleNodes": SECOND_MAP_CONFIG.get("extraBattleNodes", 0),
        "extraEventNodes": SECOND_MAP_CONFIG.get("extraEventNodes", 0),
        "eventTypes": MAP_EVENT_TYPES,
        "battlePools": BATTLE_POOLS,
        "templates": SECOND_MAP_TEMPLATES,
        "bossEncounter": SECOND_MAP_CONFIG.get("bossEncounter", "boss2"),
        "bossTemplate": SECOND_MAP_CONFIG.get("bossTemplate", "boss2"),
        "meta": SECOND_MAP_META,
    },
    "map3": {
        "runLengths": THIRD_MAP_RUN_LENGTHS,
        "maxBranches": THIRD_MAP_MAX_BRANCHES,
        "middleBattles": THIRD_MAP_CONFIG.get("middleBattles", 0),
        "extraBattleNodes": THIRD_MAP_CONFIG.get("extraBattleNodes", 0),
        "extraEventNodes": THIRD_MAP_CONFIG.get("extraEventNodes", 0),
        "eventTypes": MAP_EVENT_TYPES,
        "battlePools": BATTLE_POOLS,
        "templates": THIRD_MAP_TEMPLATES,
        "bossEncounter": THIRD_MAP_CONFIG.get("bossEncounter", "boss2"),
        "bossTemplate": THIRD_MAP_CONFIG.get("bossTemplate", "boss3"),
        "meta": THIRD_MAP_META,
    },
}
DEFAULT_MAP_TYPE = "map1"
ELITE_REWARD_COUNT = 3

MAX_DECK = 20
NODE_TYPES = (
    "battle",
    "recruit",
    "signal",
    "adventure",
    "calibration",
    "drift",
    "recycle",
    "shop",
    "trial",
    "drones",
    "training",
    "relay",
)
SCHEMA_VERSION = 7
OLD_NODE_ORDER = ["battle1", "recruit", "adventure", "battle2"]
VALID_PHASES = ("before_story", "node", "after_story", "map", "elite_reward", "complete")


def validate_content():
    def check_triggers(label, definition):
        for field, allowed in (
            ("onDeploy", ON_DEPLOY_TRIGGERS),
            ("onDestroy", ON_DESTROY_TRIGGERS),
        ):
            trigger = definition.get(field)
            if trigger is not None and trigger not in allowed:
                raise RuntimeError(f"{label} {field} 非法")
        for field in ("shield", "guard", "shift", "anchor"):
            value = definition.get(field, 0)
            if not isinstance(value, int) or isinstance(value, bool) or value < 0:
                raise RuntimeError(f"{label} {field} 非法")

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
        width = card.get("width", 1)
        pattern = card.get("attackPattern", "forward")
        abilities = card.get("abilities", [])
        if not isinstance(width, int) or isinstance(width, bool) or width not in (1, 2):
            raise RuntimeError(f"卡牌 {card_id} 宽度非法")
        if pattern not in ATTACK_PATTERNS:
            raise RuntimeError(f"卡牌 {card_id} 攻击模式非法")
        if (
            not isinstance(abilities, list)
            or any(not isinstance(item, str) or item not in KNOWN_ABILITIES for item in abilities)
            or len(abilities) != len(set(abilities))
        ):
            raise RuntimeError(f"卡牌 {card_id} 能力非法")
        if (width == 2) != ("wide_2" in abilities):
            raise RuntimeError(f"卡牌 {card_id} 宽度与 wide_2 不一致")
        check_triggers(f"卡牌 {card_id}", card)
        if card["type"] != "unit" and (
            width != 1
            or pattern != "forward"
            or abilities
            or card.get("shield", 0)
            or card.get("guard", 0)
            or card.get("shift", 0)
            or card.get("anchor", 0)
            or card.get("onDeploy")
            or card.get("onDestroy")
        ):
            raise RuntimeError(f"指令卡 {card_id} 不能拥有站位或攻击能力")

    for enemy_id, enemy in ENEMIES.items():
        width = enemy.get("width", 1)
        pattern = enemy.get("attackPattern", "forward")
        abilities = enemy.get("abilities", [])
        if not enemy.get("name"):
            raise RuntimeError(f"敌人 {enemy_id} 缺少名称")
        if enemy.get("atk", -1) < 0 or enemy.get("hp", 0) < 1:
            raise RuntimeError(f"敌人 {enemy_id} 数值非法")
        if not isinstance(width, int) or isinstance(width, bool) or width not in (1, 2):
            raise RuntimeError(f"敌人 {enemy_id} 宽度非法")
        if pattern not in ATTACK_PATTERNS:
            raise RuntimeError(f"敌人 {enemy_id} 攻击模式非法")
        if (
            not isinstance(abilities, list)
            or any(not isinstance(item, str) or item not in KNOWN_ABILITIES for item in abilities)
            or len(abilities) != len(set(abilities))
        ):
            raise RuntimeError(f"敌人 {enemy_id} 能力非法")
        if (width == 2) != ("wide_2" in abilities):
            raise RuntimeError(f"敌人 {enemy_id} 宽度与 wide_2 不一致")
        check_triggers(f"敌人 {enemy_id}", enemy)

    ids = set()
    for node in NODES:
        if node["id"] in ids:
            raise RuntimeError(f"节点 ID 重复：{node['id']}")
        ids.add(node["id"])
    if FIRST_NODE not in NODE_BY_ID:
        raise RuntimeError("首个节点不存在")
    if RUN_LENGTH <= 0:
        raise RuntimeError("runLength 非法")
    branch_pairs = set()
    for node in NODES:
        if node["type"] not in NODE_TYPES:
            raise RuntimeError(f"节点 {node['id']} 类型非法")
        if node["type"] == "battle" and node["encounter"] not in ENCOUNTERS:
            raise RuntimeError(f"节点 {node['id']} 引用了未知遭遇")
        if not isinstance(node.get("next"), list):
            raise RuntimeError(f"节点 {node['id']} 缺少后续节点")
        for next_id in node["next"]:
            if next_id not in NODE_BY_ID:
                raise RuntimeError(f"节点 {node['id']} 引用了未知后续节点 {next_id}")
        group = node.get("branchGroup")
        branch = node.get("branch")
        if (group is None) != (branch is None):
            raise RuntimeError(f"节点 {node['id']} 分支标记不完整")
        if group is not None:
            if not isinstance(group, str) or not group or not isinstance(branch, str) or not branch:
                raise RuntimeError(f"节点 {node['id']} 分支标记非法")
            if (group, branch) in branch_pairs:
                raise RuntimeError(f"节点 {node['id']} 分支重复")
            branch_pairs.add((group, branch))
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
            if item["enemy"] not in ENEMIES:
                raise RuntimeError(f"遭遇 {encounter_id} 引用了未知敌人")
            width = ENEMIES[item["enemy"]].get("width", 1)
            if not (1 <= item["column"] <= 4 - width + 1):
                raise RuntimeError(f"遭遇 {encounter_id} 计划列号非法")
    for offer in RECRUIT["offers"]:
        if offer["id"] not in CARDS or offer["price"] <= 0:
            raise RuntimeError("招募配置非法")
    for name, value in (("signal", SIGNAL["hpBonus"]),):
        if value < 0:
            raise RuntimeError(f"{name} 强化数值非法")
    if ADVENTURE["atkBonus"] < 0 or ADVENTURE["hpBonus"] < 0:
        raise RuntimeError("维修站强化数值非法")
    if CALIBRATION["atkBonus"] < 0 or CALIBRATION["hpBonus"] < 0 or CALIBRATION["levelBonus"] < 1:
        raise RuntimeError("校准平台强化数值非法")
    if RECYCLE["goldPerCost"] < 0 or RECYCLE["goldPerLevel"] < 0:
        raise RuntimeError("回收站金币配置非法")
    if DRIFT["candidateCount"] < 1 or DRIFT["rerollPrice"] < 0 or DRIFT["rerollLimit"] < 0:
        raise RuntimeError("漂流卡匣配置非法")
    offer_ids = set()
    for offer in SHOP["offers"]:
        if offer.get("id") in offer_ids:
            raise RuntimeError("商店商品 ID 重复")
        offer_ids.add(offer.get("id"))
        if offer.get("kind") not in ("new", "upgrade", "boost"):
            raise RuntimeError("商店商品类型非法")
        if offer.get("cardId") not in CARDS:
            raise RuntimeError("商店引用了未知卡牌")
        if offer["price"] <= 0:
            raise RuntimeError("商店价格非法")
        if offer["kind"] == "boost" and (
            CARDS[offer["cardId"]]["type"] != "unit"
            or offer.get("effect") not in ("atk", "hp")
            or offer.get("amount", 0) < 1
        ):
            raise RuntimeError("商店强化商品非法")
    trial_ids = set()
    for item in TRIAL["trials"]:
        if item.get("id") in trial_ids:
            raise RuntimeError("试炼 ID 重复")
        trial_ids.add(item.get("id"))
        if item.get("target", 0) < 1 or not item.get("name") or not item.get("description"):
            raise RuntimeError("试炼配置非法")
    if not TRIAL["trials"] or TRIAL["failureGold"] < 0 or TRIAL["candidateCount"] < 1:
        raise RuntimeError("观测塔配置非法")
    if DRONES["atkBonus"] < 0 or DRONES["hpBonus"] < 0 or DRONES["drawBonus"] < 0:
        raise RuntimeError("维修无人机群强化数值非法")
    if RELAY["atkBonus"] < 0 or not isinstance(RELAY["flag"], str) or not RELAY["flag"]:
        raise RuntimeError("中继站配置非法")
    if not TRAINING["challenges"]:
        raise RuntimeError("失控训练场没有挑战")
    challenge_ids = set()
    for item in TRAINING["challenges"]:
        if item.get("id") in challenge_ids:
            raise RuntimeError("训练挑战 ID 重复")
        challenge_ids.add(item.get("id"))
        if not item.get("name") or not item.get("description") or item.get("reward", -1) < 0:
            raise RuntimeError("训练挑战配置非法")
        penalty = item.get("energyPenalty", 0)
        if not isinstance(penalty, int) or isinstance(penalty, bool) or penalty < 0:
            raise RuntimeError("训练挑战能量代价非法")
        extra = item.get("extraEnemy")
        if extra is not None:
            if extra not in ENEMIES:
                raise RuntimeError("训练挑战引用了未知敌人")
            column = item.get("column")
            width = ENEMIES[extra].get("width", 1)
            if (
                not isinstance(column, int)
                or isinstance(column, bool)
                or not (1 <= column <= 4 - width + 1)
            ):
                raise RuntimeError("训练挑战列号非法")
        flag = item.get("requiresFlag")
        if flag is not None and (not isinstance(flag, str) or not flag):
            raise RuntimeError("训练挑战标记条件非法")

    if not MAP_CONFIG:
        raise RuntimeError("缺少地图生成配置")
    if (
        not MAP_RUN_LENGTHS
        or any(
            not isinstance(value, int) or isinstance(value, bool) or value not in (6, 7, 8)
            for value in MAP_RUN_LENGTHS
        )
    ):
        raise RuntimeError("地图路线长度非法")
    if not isinstance(MAP_MAX_BRANCHES, int) or MAP_MAX_BRANCHES < 2:
        raise RuntimeError("地图分支数量非法")
    if len(MAP_EVENT_TYPES) < 5 or len(MAP_EVENT_TYPES) != len(set(MAP_EVENT_TYPES)):
        raise RuntimeError("地图奇遇类型配置非法")
    for node_type in MAP_EVENT_TYPES:
        if (
            node_type not in NODE_TYPES
            or node_type == "battle"
            or not any(node["type"] == node_type for node in NODES)
        ):
            raise RuntimeError(f"地图奇遇类型 {node_type} 非法")
    for pool_name in ("early", "late"):
        pool = BATTLE_POOLS.get(pool_name)
        if not isinstance(pool, list) or len(pool) < 3 or len(pool) != len(set(pool)):
            raise RuntimeError(f"{pool_name} 战斗池配置非法")
        for encounter_id in pool:
            if encounter_id not in ENCOUNTERS:
                raise RuntimeError(f"{pool_name} 战斗池引用了未知遭遇")
            if ENCOUNTERS[encounter_id].get("reward", {}).get("gold", -1) < 0:
                raise RuntimeError(f"{pool_name} 战斗池奖励非法")
    for template_id in ("battle_early", "battle_late"):
        template = MAP_TEMPLATES.get(template_id)
        if (
            not isinstance(template, dict)
            or template.get("type") != "battle"
            or not template.get("name")
            or not isinstance(template.get("before"), list)
            or not isinstance(template.get("after"), list)
        ):
            raise RuntimeError(f"地图战斗模板 {template_id} 非法")
    if (
        not SECOND_MAP_RUN_LENGTHS
        or any(
            not isinstance(value, int) or isinstance(value, bool) or value < 6
            for value in SECOND_MAP_RUN_LENGTHS
        )
    ):
        raise RuntimeError("第二张地图路线长度非法")
    if not isinstance(SECOND_MAP_MAX_BRANCHES, int) or SECOND_MAP_MAX_BRANCHES < 2:
        raise RuntimeError("第二张地图分支数量非法")
    boss_encounter = SECOND_MAP_CONFIG.get("bossEncounter", "boss2")
    if boss_encounter not in ENCOUNTERS:
        raise RuntimeError("第二张地图终点遭遇非法")
    boss_template_id = SECOND_MAP_CONFIG.get("bossTemplate", "boss2")
    boss_template = SECOND_MAP_TEMPLATES.get(boss_template_id) or NODE_BY_ID.get(boss_template_id)
    if (
        not isinstance(boss_template, dict)
        or boss_template.get("type") != "battle"
        or not boss_template.get("name")
        or not isinstance(boss_template.get("before"), list)
        or not isinstance(boss_template.get("after"), list)
    ):
        raise RuntimeError("第二张地图终点模板非法")
    if (
        not THIRD_MAP_RUN_LENGTHS
        or any(
            not isinstance(value, int) or isinstance(value, bool) or value < 6
            for value in THIRD_MAP_RUN_LENGTHS
        )
    ):
        raise RuntimeError("第三张地图路线长度非法")
    if not isinstance(THIRD_MAP_MAX_BRANCHES, int) or THIRD_MAP_MAX_BRANCHES < 2:
        raise RuntimeError("第三张地图分支数量非法")
    boss_encounter = THIRD_MAP_CONFIG.get("bossEncounter", "boss2")
    if boss_encounter not in ENCOUNTERS:
        raise RuntimeError("第三张地图终点遭遇非法")
    boss_template_id = THIRD_MAP_CONFIG.get("bossTemplate", "boss3")
    boss_template = THIRD_MAP_TEMPLATES.get(boss_template_id) or NODE_BY_ID.get(boss_template_id)
    if (
        not isinstance(boss_template, dict)
        or boss_template.get("type") != "battle"
        or not boss_template.get("name")
        or not isinstance(boss_template.get("before"), list)
        or not isinstance(boss_template.get("after"), list)
    ):
        raise RuntimeError("第三张地图终点模板非法")

    for map_type, definition in MAPS.items():
        battles = definition.get("middleBattles", 0)
        extra = definition.get("extraBattleNodes", 0)
        for pool_name, layers in (
            ("early", (battles + 1) // 2),
            ("late", battles // 2),
        ):
            pool = definition["battlePools"].get(pool_name) or []
            if 1 + layers + extra > len(pool):
                raise RuntimeError(f"{map_type} {pool_name} 战斗池容量不足")


validate_content()


def _new_card(card_id, level=1):
    return {
        "uid": uuid.uuid4().hex[:12],
        "cardId": card_id,
        "level": level,
        "atkBonus": 0,
        "hpBonus": 0,
    }


def _map_template(template_id, templates):
    if template_id in templates:
        return templates[template_id]
    if template_id in NODE_BY_ID:
        return NODE_BY_ID[template_id]
    return TEMPLATE_BY_TYPE[template_id]


def _make_map_node(template_id, column, row, role, templates, encounter=None, elite_reward=False):
    template = _map_template(template_id, templates)
    node = {
        "id": f"{template_id}_{column}_{row}",
        "type": template["type"],
        "name": template["name"],
        "column": column,
        "row": row,
        "role": role,
        "before": copy.deepcopy(template.get("before", [])),
        "after": copy.deepcopy(template.get("after", [])),
        "next": [],
    }
    if encounter is not None:
        node["encounter"] = encounter
    if elite_reward:
        node["eliteReward"] = True
    return node


def _connect_map_layers(layers, rng):
    edges = []
    for index in range(len(layers) - 1):
        parents = [node["id"] for node in layers[index]]
        children = [node["id"] for node in layers[index + 1]]
        for child in children:
            edges.append([rng.choice(parents), child])
        for parent in parents:
            if not any(edge[0] == parent for edge in edges):
                edges.append([parent, rng.choice(children)])
        for parent in parents:
            for child in children:
                if [parent, child] not in edges and rng.random() < 0.35:
                    edges.append([parent, child])
    nexts = {node["id"]: [] for layer in layers for node in layer}
    for parent, child in edges:
        nexts[parent].append(child)
    for layer in layers:
        for node in layer:
            node["next"] = nexts[node["id"]]
    return edges


def _reachable(start, nexts):
    seen = set()
    stack = [start]
    while stack:
        node_id = stack.pop()
        if node_id in seen:
            continue
        seen.add(node_id)
        stack.extend(nexts.get(node_id, ()))
    return seen


def _validate_generated_map(data, legacy=False):
    map_type = data.get("mapType", DEFAULT_MAP_TYPE)
    if map_type not in MAPS:
        raise RuntimeError("地图类型非法")
    definition = MAPS[map_type]
    nodes = data.get("nodes")
    if not isinstance(nodes, list):
        raise RuntimeError("地图节点非法")
    run_length = data.get("runLength")
    allowed_lengths = set(definition["runLengths"])
    if legacy and map_type == "map1":
        allowed_lengths |= {6, 7}
    if run_length not in allowed_lengths:
        raise RuntimeError("地图路线长度非法")
    seed = data.get("seed")
    if not isinstance(seed, int) or isinstance(seed, bool) or seed < 0:
        raise RuntimeError("地图种子非法")
    by_id = {}
    cells = set()
    for node in nodes:
        if not isinstance(node, dict) or not isinstance(node.get("id"), str) or node["id"] in by_id:
            raise RuntimeError("地图节点重复或非法")
        if node.get("type") not in NODE_TYPES or not isinstance(node.get("name"), str):
            raise RuntimeError("地图节点类型非法")
        if node.get("role") not in ("start", "late", "boss", "event", "elite", "battle"):
            raise RuntimeError("地图节点角色非法")
        column, row = node.get("column"), node.get("row")
        if (
            not isinstance(column, int)
            or isinstance(column, bool)
            or column < 0
            or not isinstance(row, int)
            or isinstance(row, bool)
            or row < 0
            or (column, row) in cells
        ):
            raise RuntimeError("地图节点位置非法")
        cells.add((column, row))
        if not isinstance(node.get("before"), list) or not isinstance(node.get("after"), list):
            raise RuntimeError("地图剧情非法")
        if node["type"] == "battle":
            if node.get("encounter") not in ENCOUNTERS:
                raise RuntimeError("地图遭遇非法")
        elif node.get("role") != "event" or node["type"] not in definition["eventTypes"]:
            raise RuntimeError("地图奇遇类型非法")
        by_id[node["id"]] = node
    nexts = {node_id: node.get("next") for node_id, node in by_id.items()}
    if any(
        not isinstance(next_ids, list)
        or any(not isinstance(child, str) or child not in by_id for child in next_ids)
        or len(next_ids) != len(set(next_ids))
        for next_ids in nexts.values()
    ):
        raise RuntimeError("地图连线非法")
    start, boss = data.get("start"), data.get("boss")
    if start not in by_id or boss not in by_id:
        raise RuntimeError("地图起点或终点缺失")
    if by_id[start]["role"] != "start" or by_id[boss]["role"] != "boss":
        raise RuntimeError("地图起点或终点非法")
    edge_pairs = {(parent, child) for parent, children in nexts.items() for child in children}
    raw_edges = data.get("edges")
    if (
        not isinstance(raw_edges, list)
        or any(
            not isinstance(edge, list)
            or len(edge) != 2
            or not all(isinstance(item, str) for item in edge)
            or tuple(edge) not in edge_pairs
            for edge in raw_edges
        )
        or {(edge[0], edge[1]) for edge in raw_edges} != edge_pairs
    ):
        raise RuntimeError("地图连线记录非法")
    reachable = _reachable(start, nexts)
    if len(reachable) != len(by_id):
        raise RuntimeError("地图存在不可达节点")
    reverse = {node_id: [] for node_id in by_id}
    for parent, children in nexts.items():
        for child in children:
            reverse[child].append(parent)
    if _reachable(boss, reverse) != set(by_id):
        raise RuntimeError("地图存在无法抵达终点的节点")
    columns = {}
    for node in nodes:
        columns.setdefault(node["column"], []).append(node)
    if sorted(columns) != list(range(run_length)):
        raise RuntimeError("地图层数非法")
    widths = [len(columns[column]) for column in sorted(columns)]
    if 1 not in widths or max(widths) < 2 or max(widths) > definition["maxBranches"]:
        raise RuntimeError("地图缺少单路或多路分支")
    if not legacy:
        # 起点、后期战和终点固定为战斗，允许最多两场连续战斗，禁止三场以上扎堆。
        battle_run = 0
        for column in sorted(columns):
            layer_roles = {node.get("role") for node in columns[column]}
            battle_run = (
                battle_run + 1
                if layer_roles & {"start", "late", "boss", "battle", "elite"}
                else 0
            )
            if battle_run >= 3:
                raise RuntimeError("地图连续战斗过多")
        encounters = [node.get("encounter") for node in nodes if node.get("encounter")]
        if len(encounters) != len(set(encounters)):
            raise RuntimeError("地图遭遇重复")
    roles = [node.get("role") for node in nodes]
    if roles.count("start") != 1 or roles.count("late") != 1 or roles.count("boss") != 1:
        raise RuntimeError("地图战斗节点非法")
    if roles.count("elite") != 1 or data.get("elite") not in by_id:
        raise RuntimeError("地图精英节点非法")
    if not legacy and roles.count("battle") < definition.get("middleBattles", 0):
        raise RuntimeError("地图中段战斗数量不足")
    events = [node for node in nodes if node.get("role") == "event"]
    if not events or len({node["type"] for node in events}) != len(events):
        raise RuntimeError("地图奇遇类型重复")
    for node in nodes:
        if node["role"] == "elite" and (
            node["type"] != "battle"
            or node.get("encounter") != "elite"
            or not node.get("eliteReward")
        ):
            raise RuntimeError("地图精英节点非法")
        if node["role"] == "battle" and (
            node.get("encounter")
            not in definition["battlePools"]["early"] + definition["battlePools"]["late"]
        ):
            raise RuntimeError("地图中段战斗节点非法")
        allowed_start = list(definition["battlePools"]["early"])
        if definition.get("startEncounter"):
            allowed_start = [*allowed_start, definition["startEncounter"]] if legacy else [definition["startEncounter"]]
        if node["role"] == "start" and node.get("encounter") not in allowed_start:
            raise RuntimeError("地图战斗节点非法")
        if node["role"] == "late" and node.get("encounter") not in definition["battlePools"]["late"]:
            raise RuntimeError("地图战斗节点非法")
        if node["role"] == "boss" and node.get("encounter") != definition["bossEncounter"]:
            raise RuntimeError("地图战斗节点非法")
        if node["role"] in ("start", "late", "boss") and node["type"] != "battle":
            raise RuntimeError("地图战斗节点非法")
    # 每条实际路线都必须经过至少一个成长节点。
    def has_event(node_id, seen):
        if node_id in seen:
            return False
        seen.add(node_id)
        node = by_id[node_id]
        if node.get("role") == "event":
            return True
        return any(has_event(child, seen) for child in nexts[node_id])
    if not all(has_event(child, set()) for child in nexts[start]):
        raise RuntimeError("地图存在没有成长节点的路线")
    return True


def generate_map(seed=None, map_type=DEFAULT_MAP_TYPE):
    if map_type not in MAPS:
        raise GameError("地图类型非法")
    if seed is None:
        seed = random.randrange(1, 2**31)
    if not isinstance(seed, int) or isinstance(seed, bool) or seed < 0:
        raise GameError("地图种子非法")
    definition = MAPS[map_type]
    rng = random.Random(seed)
    run_length = rng.choice(definition["runLengths"])
    max_branches = definition["maxBranches"]
    event_types_all = definition["eventTypes"]
    battle_pools = definition["battlePools"]
    templates = definition["templates"]
    middle_count = run_length - 3
    middle_battles = definition.get("middleBattles", 0)
    event_layer_count = middle_count - middle_battles - 1
    if event_layer_count < 0:
        raise RuntimeError("地图中段无法容纳战斗与精英")
    plan = ["elite"] + ["battle"] * middle_battles + ["event"] * event_layer_count

    def balanced_plan(candidate):
        run = 0
        for kind in ["battle", *candidate, "battle", "battle"]:
            run = run + 1 if kind in ("battle", "elite") else 0
            if run >= 3:
                return False
        return True

    for _ in range(200):
        rng.shuffle(plan)
        if balanced_plan(plan):
            break
    else:
        raise RuntimeError("地图无法安排连续战斗")
    widths = [1] * middle_count

    def add_extra_nodes(count, indices):
        for _ in range(count):
            options = [index for index in indices if widths[index] < max_branches]
            if not options:
                break
            widths[rng.choice(options)] += 1

    event_layers = [index for index, kind in enumerate(plan) if kind == "event"]
    battle_layers = [index for index, kind in enumerate(plan) if kind == "battle"]
    if not event_layers:
        raise RuntimeError("地图缺少奇遇层")
    add_extra_nodes(definition.get("extraEventNodes", 0), event_layers)
    add_extra_nodes(definition.get("extraBattleNodes", 0), battle_layers)
    if max(widths) < 2:
        options = [index for index in event_layers if widths[index] < max_branches]
        widths[rng.choice(options)] += 1
    event_slots = sum(widths[index] for index in event_layers)
    if event_slots > len(event_types_all):
        raise RuntimeError("地图奇遇数量超过配置")

    used = set()

    def pick_encounters(pool_name, count):
        pool = list(battle_pools[pool_name])
        unused = [encounter_id for encounter_id in pool if encounter_id not in used]
        if count > len(unused):
            raise RuntimeError("地图战斗分支超过遭遇池")
        picks = rng.sample(unused, count)
        used.update(picks)
        return picks

    early_encounter = definition.get("startEncounter") or pick_encounters("early", 1)[0]
    late_encounter = pick_encounters("late", 1)[0]
    event_types = rng.sample(event_types_all, event_slots)
    layer_pools = {}
    for order, index in enumerate(battle_layers):
        layer_pools[index] = "early" if order % 2 == 0 else "late"
    layers = [
        [_make_map_node(definition.get("startTemplate", "battle_early"), 0, 0, "start", templates, encounter=early_encounter)]
    ]
    for index, kind in enumerate(plan):
        layer = []
        encounters = (
            pick_encounters(layer_pools[index], widths[index]) if kind == "battle" else None
        )
        for row in range(widths[index]):
            if kind == "elite":
                layer.append(
                    _make_map_node(
                        "elite",
                        index + 1,
                        row,
                        "elite",
                        templates,
                        encounter="elite",
                        elite_reward=True,
                    )
                )
            elif kind == "battle":
                pool_name = layer_pools[index]
                template_id = "battle_early" if pool_name == "early" else "battle_late"
                encounter_id = encounters[row]
                node = _make_map_node(
                    template_id,
                    index + 1,
                    row,
                    "battle",
                    templates,
                    encounter=encounter_id,
                )
                node["name"] = ENCOUNTERS[encounter_id].get("name") or node["name"]
                layer.append(node)
            else:
                node_type = event_types.pop()
                layer.append(_make_map_node(node_type, index + 1, row, "event", templates))
        layers.append(layer)
    late = _make_map_node(
        "battle_late", middle_count + 1, 0, "late", templates, encounter=late_encounter
    )
    boss = _make_map_node(
        definition["bossTemplate"],
        middle_count + 2,
        0,
        "boss",
        templates,
        encounter=definition["bossEncounter"],
    )
    layers.append([late])
    layers.append([boss])
    edges = _connect_map_layers(layers, rng)
    nodes = [node for layer in layers for node in layer]
    data = {
        "mapType": map_type,
        "seed": seed,
        "runLength": run_length,
        "start": nodes[0]["id"],
        "boss": boss["id"],
        "elite": next(node["id"] for node in nodes if node.get("role") == "elite"),
        "nodes": nodes,
        "edges": edges,
        "encounterIds": sorted(used),
    }
    _validate_generated_map(data)
    return data


def new_state(seed=None, map_type=DEFAULT_MAP_TYPE):
    map_data = generate_map(seed, map_type)
    state = {
        "schemaVersion": SCHEMA_VERSION,
        "nodeId": map_data["start"],
        "phase": "before_story",
        "storyLine": 0,
        "gold": 0,
        "cards": [_new_card(card_id) for card_id in INITIAL_DECK],
        "completed": [],
        "nodeData": {},
        "route": {},
        "flags": {},
        "pendingChallenges": [],
        "pendingDrawBonus": 0,
        "mapData": map_data,
    }
    _normalize(state)
    return state


def _map_nodes(state):
    data = state.get("mapData")
    if isinstance(data, dict):
        return {node["id"]: node for node in data.get("nodes", [])}
    return NODE_BY_ID


def current_map_type(state):
    data = state.get("mapData")
    if isinstance(data, dict):
        return data.get("mapType", DEFAULT_MAP_TYPE)
    return DEFAULT_MAP_TYPE


def map_meta(map_type):
    definition = MAPS.get(map_type) or MAPS[DEFAULT_MAP_TYPE]
    return dict(definition["meta"])


def can_start_map2(state):
    return state.get("phase") == "complete" and current_map_type(state) == "map1"


def can_start_map3(state):
    return state.get("phase") == "complete" and current_map_type(state) == "map2"


def current_node(state):
    return _map_nodes(state).get(state.get("nodeId"))


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
    if node["type"] == "recruit":
        state["nodeData"] = {"purchased": False}
    elif node["type"] == "drift":
        state["nodeData"] = {"seed": random.randrange(1, 2**31), "rerolls": 0}
    elif node["type"] == "shop":
        state["nodeData"] = {"purchased": False}
    elif node["type"] == "trial":
        state["nodeData"] = {
            "seed": random.randrange(1, 2**31),
            "status": "choose",
            "trialId": None,
            "candidates": [],
        }
    else:
        state["nodeData"] = {}


def _after_story_done(state):
    node = current_node(state)
    state["storyLine"] = 0
    state["nodeData"] = {}
    if node["next"]:
        state["phase"] = "map"
    elif current_map_type(state) == "map1":
        state.clear()
        state.update(new_state(map_type="map2"))
    elif current_map_type(state) == "map2":
        state.clear()
        state.update(new_state(map_type="map3"))
    else:
        state["phase"] = "complete"


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
        if state["phase"] in ("node", "elite_reward", "map"):
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
    settle_challenges(state)
    state["pendingDrawBonus"] = 0
    if node.get("eliteReward"):
        state["phase"] = "elite_reward"
        state["storyLine"] = 0
        state["nodeData"] = {"seed": random.randrange(1, 2**31), "claimed": False}
    else:
        finish_node(state, node["id"])


def _elite_candidates(state):
    data = state.get("nodeData") or {}
    seed = data.get("seed")
    if not isinstance(seed, int) or isinstance(seed, bool):
        raise GameError("精英奖励种子缺失")
    pool = list(CARDS)
    return random.Random(seed).sample(pool, min(ELITE_REWARD_COUNT, len(pool)))


def _elite_reward_view(state):
    node = current_node(state)
    if (
        state["phase"] != "elite_reward"
        or node is None
        or not node.get("eliteReward")
    ):
        return None
    candidates = []
    for card_id in _elite_candidates(state):
        stats = card_stats(CARDS, card_id, 1)
        stats["effectText"] = _effect_text(stats)
        stats["duplicate"] = _owned_card(state, card_id) is not None
        candidates.append(stats)
    return {
        "candidates": candidates,
        "deckFull": len(state["cards"]) >= MAX_DECK,
        "claimed": bool((state.get("nodeData") or {}).get("claimed")),
    }


def elite_reward_choose(state, card_id):
    node = current_node(state)
    if node is None or not node.get("eliteReward"):
        raise GameError("当前不是精英奖励")
    if node["id"] in state["completed"]:
        return
    if state["phase"] != "elite_reward":
        raise GameError("当前不在精英奖励")
    if card_id not in _elite_candidates(state):
        raise GameError("这张卡不在当前候选中")
    if len(state["cards"]) >= MAX_DECK:
        raise GameError("牌组已满，无法加入新卡")
    state["cards"].append(_new_card(card_id))
    state["nodeData"]["claimed"] = True
    state["phase"] = "node"
    finish_node(state, node["id"])


def elite_reward_leave(state):
    node = current_node(state)
    if node is None or not node.get("eliteReward"):
        raise GameError("当前不是精英奖励")
    if node["id"] in state["completed"]:
        return
    if state["phase"] != "elite_reward":
        raise GameError("当前不在精英奖励")
    state["phase"] = "node"
    finish_node(state, node["id"])


def available_nodes(state):
    node = current_node(state)
    if node is None:
        return []
    route = state.get("route") or {}
    result = []
    for node_id in node["next"]:
        if node_id in state["completed"]:
            continue
        child = _map_nodes(state).get(node_id)
        if child is None:
            continue
        group = child.get("branchGroup")
        if group and route.get(group) not in (None, child["branch"]):
            continue
        result.append(node_id)
    return result


def _edge_status(status_by_id, parent, child):
    if status_by_id[parent] == "completed" and status_by_id[child] == "completed":
        return "traveled"
    if status_by_id[child] == "available":
        return "open"
    if status_by_id[parent] == "closed" or status_by_id[child] == "closed":
        return "closed"
    return ""


def _legacy_layout():
    columns = {FIRST_NODE: 0}
    queue = [FIRST_NODE]
    while queue:
        node_id = queue.pop(0)
        for child in NODE_BY_ID[node_id]["next"]:
            column = columns[node_id] + 1
            if columns.get(child, -1) < column:
                columns[child] = column
                queue.append(child)
    by_column = {}
    for node in NODES:
        by_column.setdefault(columns[node["id"]], []).append(node)
    rows = {
        node["id"]: row
        for group in by_column.values()
        for row, node in enumerate(group)
    }
    return columns, rows, by_column


def map_view(state):
    if state["phase"] != "map":
        return None
    available = set(available_nodes(state))
    route = state.get("route") or {}
    map_data = state.get("mapData")
    if isinstance(map_data, dict):
        nodes_by_id = {node["id"]: node for node in map_data["nodes"]}
        nexts = {node_id: node["next"] for node_id, node in nodes_by_id.items()}
        reachable = _reachable(state["nodeId"], nexts)
        completed = set(state["completed"])
        status_by_id = {}
        nodes = []
        for node in map_data["nodes"]:
            if node["id"] in completed:
                status = "completed"
            elif node["id"] in available:
                status = "available"
            elif node["id"] in reachable:
                status = "locked"
            else:
                status = "closed"
            status_by_id[node["id"]] = status
            nodes.append(
                {
                    "id": node["id"],
                    "name": node["name"],
                    "type": node["type"],
                    "role": node.get("role"),
                    "encounter": node.get("encounter"),
                    "status": status,
                    "column": node["column"],
                    "row": node["row"],
                }
            )
        edges = [
            {
                "from": parent,
                "to": child,
                "status": _edge_status(status_by_id, parent, child),
            }
            for parent, child in map_data["edges"]
        ]
        return {
            "mapType": current_map_type(state),
            "nodes": nodes,
            "edges": edges,
            "route": {},
            "available": list(available),
            "seed": map_data["seed"],
            "runLength": map_data["runLength"],
        }

    columns, rows, _ = _legacy_layout()
    status_by_id = {}
    nodes = []
    for node in NODES:
        group = node.get("branchGroup")
        if node["id"] in state["completed"]:
            status = "completed"
        elif node["id"] in available:
            status = "available"
        elif group and route.get(group) not in (None, node["branch"]):
            status = "closed"
        else:
            status = "locked"
        status_by_id[node["id"]] = status
        nodes.append(
            {
                "id": node["id"],
                "name": node["name"],
                "type": node["type"],
                "branchGroup": group,
                "branch": node.get("branch"),
                "status": status,
                "column": columns[node["id"]],
                "row": rows[node["id"]],
            }
        )
    edges = [
        {
            "from": node["id"],
            "to": child,
            "status": _edge_status(status_by_id, node["id"], child),
        }
        for node in NODES
        for child in node["next"]
    ]
    return {
        "mapType": DEFAULT_MAP_TYPE,
        "nodes": nodes,
        "edges": edges,
        "route": dict(route),
        "available": list(available),
        "seed": None,
        "runLength": max(columns.values()) + 1,
    }


def select_node(state, node_id):
    if state["phase"] != "map":
        raise GameError("当前不在关卡选择阶段")
    if node_id not in available_nodes(state):
        raise GameError("该节点当前不可进入")
    node = _map_nodes(state)[node_id]
    if node.get("branchGroup"):
        if not isinstance(state.get("route"), dict):
            state["route"] = {}
        state["route"][node["branchGroup"]] = node["branch"]
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


def _card_by_uid(state, card_uid):
    for card in state["cards"]:
        if card.get("uid") == card_uid:
            return card
    return None


def _resolve_card(state, card_id, card_uid=None):
    if card_uid:
        card = _card_by_uid(state, card_uid)
        if card is None or (card_id and card["cardId"] != card_id):
            return None
        return card
    return _owned_card(state, card_id)


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
        state["cards"].append(_new_card(card_id))
    state["nodeData"]["purchased"] = True


def recruit_leave(state):
    node = current_node(state)
    if node is None or node["type"] != "recruit":
        raise GameError("当前不是招募节点")
    finish_node(state, node["id"])


def _require_unit_target(state, card_id, card_uid=None):
    card = _resolve_card(state, card_id, card_uid)
    if card is None:
        raise GameError("你没有这张卡")
    if CARDS[card["cardId"]]["type"] != "unit":
        raise GameError("只能选择单位")
    return card


def signal_apply(state, action, card_id, card_uid=None):
    node = current_node(state)
    if node is None or node["type"] != "signal":
        raise GameError("当前不是信号奇遇")
    if node["id"] in state["completed"]:
        return
    if state["phase"] != "node":
        raise GameError("当前不在信号奇遇")
    card = _require_unit_target(state, card_id, card_uid)
    if action == "repair":
        card["hpBonus"] = card.get("hpBonus", 0) + SIGNAL["hpBonus"]
    elif action == "upgrade":
        if card["level"] >= len(CARDS[card["cardId"]]["levels"]):
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


def adventure_apply(state, card_id, effect, card_uid=None):
    node = current_node(state)
    if node is None or node["type"] != "adventure":
        raise GameError("当前不是奇遇节点")
    if node["id"] in state["completed"]:
        return
    if state["phase"] != "node":
        raise GameError("当前不在奇遇节点")
    card = _require_unit_target(state, card_id, card_uid)
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


def calibration_apply(state, card_id, effect, card_uid=None):
    node = current_node(state)
    if node is None or node["type"] != "calibration":
        raise GameError("当前不是校准平台")
    if node["id"] in state["completed"]:
        return
    if state["phase"] != "node":
        raise GameError("当前不在校准平台")
    card = _require_unit_target(state, card_id, card_uid)
    if effect == "atk":
        card["atkBonus"] = card.get("atkBonus", 0) + CALIBRATION["atkBonus"]
    elif effect == "hp":
        card["hpBonus"] = card.get("hpBonus", 0) + CALIBRATION["hpBonus"]
    elif effect == "level":
        if card["level"] >= len(CARDS[card["cardId"]]["levels"]):
            raise GameError("该单位已经满级")
        card["level"] += CALIBRATION["levelBonus"]
    else:
        raise GameError("无效的校准选项")
    finish_node(state, node["id"])


def calibration_leave(state):
    node = current_node(state)
    if node is None or node["type"] != "calibration":
        raise GameError("当前不是校准平台")
    finish_node(state, node["id"])


def recycle_price(card):
    stats = card_stats(
        CARDS, card["cardId"], card["level"], card.get("atkBonus", 0), card.get("hpBonus", 0)
    )
    return RECYCLE["goldPerCost"] * stats["cost"] + RECYCLE["goldPerLevel"] * (card["level"] - 1)


def _recycle_removable(state, card):
    if len(state["cards"]) <= 1:
        return False
    if CARDS[card["cardId"]]["type"] != "unit":
        return True
    return sum(
        1 for item in state["cards"] if CARDS[item["cardId"]]["type"] == "unit"
    ) > 1


def recycle_apply(state, card_id, card_uid=None):
    node = current_node(state)
    if node is None or node["type"] != "recycle":
        raise GameError("当前不是记忆回收站")
    if node["id"] in state["completed"]:
        return
    if state["phase"] != "node":
        raise GameError("当前不在记忆回收站")
    card = _resolve_card(state, card_id, card_uid)
    if card is None:
        raise GameError("你没有这张卡")
    if not _recycle_removable(state, card):
        raise GameError("不能移除最后一张单位牌或让牌组为空")
    price = recycle_price(card)
    state["gold"] += price
    state["cards"].remove(card)
    finish_node(state, node["id"])


def recycle_leave(state):
    node = current_node(state)
    if node is None or node["type"] != "recycle":
        raise GameError("当前不是记忆回收站")
    finish_node(state, node["id"])


def _drift_pool(state):
    full = len(state["cards"]) >= MAX_DECK
    pool = []
    for card_id, definition in CARDS.items():
        owned = _owned_card(state, card_id)
        if owned is not None:
            if owned["level"] < len(definition["levels"]):
                pool.append(card_id)
        elif not full:
            pool.append(card_id)
    return pool


def _drift_candidates(state, rerolls=None):
    data = state.get("nodeData") or {}
    seed = data.get("seed")
    if not isinstance(seed, int) or isinstance(seed, bool):
        raise GameError("漂流卡匣候选种子缺失")
    count = data.get("rerolls", 0) if rerolls is None else rerolls
    pool = _drift_pool(state)
    if not pool:
        return []
    rng = random.Random(seed + count)
    return rng.sample(pool, min(DRIFT["candidateCount"], len(pool)))


def drift_choose(state, card_id):
    node = current_node(state)
    if node is None or node["type"] != "drift":
        raise GameError("当前不是漂流卡匣")
    if node["id"] in state["completed"]:
        return
    if state["phase"] != "node":
        raise GameError("当前不在漂流卡匣")
    if card_id not in _drift_candidates(state):
        raise GameError("这张卡不在当前候选中")
    owned = _owned_card(state, card_id)
    if owned is not None:
        if owned["level"] >= len(CARDS[card_id]["levels"]):
            raise GameError("该卡已经满级")
        owned["level"] += 1
    else:
        if len(state["cards"]) >= MAX_DECK:
            raise GameError("牌组已满")
        state["cards"].append(_new_card(card_id))
    finish_node(state, node["id"])


def drift_reroll(state):
    node = current_node(state)
    if node is None or node["type"] != "drift":
        raise GameError("当前不是漂流卡匣")
    if node["id"] in state["completed"]:
        return
    if state["phase"] != "node":
        raise GameError("当前不在漂流卡匣")
    data = state["nodeData"]
    rerolls = data.get("rerolls", 0)
    if rerolls >= DRIFT["rerollLimit"]:
        raise GameError("本节点已经重抽过")
    if not _drift_candidates(state, rerolls + 1):
        raise GameError("没有可以换出的候选")
    if state["gold"] < DRIFT["rerollPrice"]:
        raise GameError("金币不足")
    state["gold"] -= DRIFT["rerollPrice"]
    data["rerolls"] = rerolls + 1


def drift_leave(state):
    node = current_node(state)
    if node is None or node["type"] != "drift":
        raise GameError("当前不是漂流卡匣")
    finish_node(state, node["id"])


def _shop_offer(offer_id):
    for offer in SHOP["offers"]:
        if offer["id"] == offer_id:
            return offer
    raise GameError("没有这个商品")


def _shop_available(state, offer):
    card = _owned_card(state, offer["cardId"])
    if offer["kind"] == "new":
        if card is not None:
            return False, "已拥有同名卡"
        if len(state["cards"]) >= MAX_DECK:
            return False, "牌组已满"
        return True, ""
    if card is None:
        return False, "牌组里没有这张卡"
    if offer["kind"] == "upgrade":
        if card["level"] >= len(CARDS[offer["cardId"]]["levels"]):
            return False, "已满级"
        return True, ""
    return True, ""


def shop_buy(state, offer_id):
    node = current_node(state)
    if node is None or node["type"] != "shop":
        raise GameError("当前不是断线商船")
    if node["id"] in state["completed"] or state["nodeData"].get("purchased"):
        return
    if state["phase"] != "node":
        raise GameError("当前不在断线商船")
    offer = _shop_offer(offer_id)
    buyable, reason = _shop_available(state, offer)
    if not buyable:
        raise GameError(reason)
    if state["gold"] < offer["price"]:
        raise GameError("金币不足")
    state["gold"] -= offer["price"]
    card = _owned_card(state, offer["cardId"])
    if offer["kind"] == "new":
        state["cards"].append(_new_card(offer["cardId"]))
    elif offer["kind"] == "upgrade":
        card["level"] += 1
    else:
        key = "atkBonus" if offer["effect"] == "atk" else "hpBonus"
        card[key] = card.get(key, 0) + offer["amount"]
    state["nodeData"]["purchased"] = True
    finish_node(state, node["id"])


def shop_leave(state):
    node = current_node(state)
    if node is None or node["type"] != "shop":
        raise GameError("当前不是断线商船")
    finish_node(state, node["id"])


def _trial_def(trial_id):
    for item in TRIAL["trials"]:
        if item["id"] == trial_id:
            return item
    raise GameError("没有这个试炼")


def _trial_metric(state, trial_id):
    if trial_id == "light":
        return sum(
            1
            for card in state["cards"]
            if card_stats(
                CARDS,
                card["cardId"],
                card["level"],
                card.get("atkBonus", 0),
                card.get("hpBonus", 0),
            )["cost"]
            <= 2
        )
    if trial_id == "power":
        return sum(
            card_stats(
                CARDS,
                card["cardId"],
                card["level"],
                card.get("atkBonus", 0),
                card.get("hpBonus", 0),
            )["atk"]
            for card in state["cards"]
            if CARDS[card["cardId"]]["type"] == "unit"
        )
    return sum(1 for card in state["cards"] if card["level"] >= 2)


def _trial_offered(state):
    data = state.get("nodeData") or {}
    seed = data.get("seed")
    if not isinstance(seed, int) or isinstance(seed, bool):
        raise GameError("试炼种子缺失")
    rng = random.Random(seed)
    count = min(2, len(TRIAL["trials"]))
    return rng.sample(TRIAL["trials"], count)


def _trial_rewards(state):
    pool = _drift_pool(state)
    if not pool:
        return []
    seed = state["nodeData"]["seed"]
    rng = random.Random(seed + 7919)
    return rng.sample(pool, min(TRIAL["candidateCount"], len(pool)))


def trial_choose(state, trial_id):
    node = current_node(state)
    if node is None or node["type"] != "trial":
        raise GameError("当前不是观测塔")
    if node["id"] in state["completed"]:
        return
    if state["phase"] != "node":
        raise GameError("当前不在观测塔")
    data = state["nodeData"]
    if data.get("status") != "choose":
        raise GameError("已经选择过试炼")
    if trial_id not in [item["id"] for item in _trial_offered(state)]:
        raise GameError("这个试炼不在当前候选中")
    item = _trial_def(trial_id)
    passed = _trial_metric(state, trial_id) >= item["target"]
    data["trialId"] = trial_id
    if passed:
        data["status"] = "success"
        data["candidates"] = _trial_rewards(state)
    else:
        data["status"] = "failed"


def trial_choose_card(state, card_id):
    node = current_node(state)
    if node is None or node["type"] != "trial":
        raise GameError("当前不是观测塔")
    if node["id"] in state["completed"]:
        return
    if state["phase"] != "node":
        raise GameError("当前不在观测塔")
    data = state["nodeData"]
    if data.get("status") != "success":
        raise GameError("没有可领取的试炼奖励")
    if card_id not in data.get("candidates", []):
        raise GameError("这张卡不在奖励候选中")
    owned = _owned_card(state, card_id)
    if owned is not None:
        if owned["level"] >= len(CARDS[card_id]["levels"]):
            raise GameError("该卡已经满级")
        owned["level"] += 1
    else:
        if len(state["cards"]) >= MAX_DECK:
            raise GameError("牌组已满")
        state["cards"].append(_new_card(card_id))
    finish_node(state, node["id"])


def trial_claim(state):
    node = current_node(state)
    if node is None or node["type"] != "trial":
        raise GameError("当前不是观测塔")
    if node["id"] in state["completed"]:
        return
    if state["phase"] != "node":
        raise GameError("当前不在观测塔")
    if state["nodeData"].get("status") != "failed":
        raise GameError("试炼没有失败，不能领取补偿")
    state["gold"] += TRIAL["failureGold"]
    finish_node(state, node["id"])


def trial_leave(state):
    node = current_node(state)
    if node is None or node["type"] != "trial":
        raise GameError("当前不是观测塔")
    finish_node(state, node["id"])


def drones_apply(state, card_id, effect, card_uid=None):
    node = current_node(state)
    if node is None or node["type"] != "drones":
        raise GameError("当前不是维修无人机群")
    if node["id"] in state["completed"]:
        return
    if state["phase"] != "node":
        raise GameError("当前不在维修无人机群")
    if effect == "draw":
        state["pendingDrawBonus"] += DRONES["drawBonus"]
        finish_node(state, node["id"])
        return
    card = _require_unit_target(state, card_id, card_uid)
    if effect == "atk":
        card["atkBonus"] = card.get("atkBonus", 0) + DRONES["atkBonus"]
    elif effect == "hp":
        card["hpBonus"] = card.get("hpBonus", 0) + DRONES["hpBonus"]
    else:
        raise GameError("无效的无人机强化选项")
    finish_node(state, node["id"])


def drones_leave(state):
    node = current_node(state)
    if node is None or node["type"] != "drones":
        raise GameError("当前不是维修无人机群")
    finish_node(state, node["id"])


def _challenge_def(challenge_id):
    for item in TRAINING["challenges"]:
        if item["id"] == challenge_id:
            return item
    raise GameError("没有这个训练挑战")


def _challenge_available(state, item):
    flag = item.get("requiresFlag")
    return flag is None or bool((state.get("flags") or {}).get(flag))


def training_choose(state, challenge_id):
    node = current_node(state)
    if node is None or node["type"] != "training":
        raise GameError("当前不是失控训练场")
    if node["id"] in state["completed"]:
        return
    if state["phase"] != "node":
        raise GameError("当前不在失控训练场")
    item = _challenge_def(challenge_id)
    if not _challenge_available(state, item):
        raise GameError("该训练挑战尚未解锁")
    state["pendingChallenges"] = [{"id": item["id"]}]
    finish_node(state, node["id"])


def training_leave(state):
    node = current_node(state)
    if node is None or node["type"] != "training":
        raise GameError("当前不是失控训练场")
    finish_node(state, node["id"])


def battle_challenge(state):
    pending = state.get("pendingChallenges") or []
    if not pending:
        return None
    return _challenge_def(pending[0]["id"])


def settle_challenges(state):
    """战斗胜利后结算并清空挂载的挑战；失败重试时保留。"""
    pending = state.get("pendingChallenges") or []
    for item in pending:
        state["gold"] += _challenge_def(item["id"])["reward"]
    state["pendingChallenges"] = []


def relay_keep(state):
    node = current_node(state)
    if node is None or node["type"] != "relay":
        raise GameError("当前不是爱的中继站")
    if node["id"] in state["completed"]:
        return
    if state["phase"] != "node":
        raise GameError("当前不在爱的中继站")
    state["flags"][RELAY["flag"]] = True
    finish_node(state, node["id"])


def relay_cut(state, card_id, card_uid=None):
    node = current_node(state)
    if node is None or node["type"] != "relay":
        raise GameError("当前不是爱的中继站")
    if node["id"] in state["completed"]:
        return
    if state["phase"] != "node":
        raise GameError("当前不在爱的中继站")
    card = _require_unit_target(state, card_id, card_uid)
    card["atkBonus"] = card.get("atkBonus", 0) + RELAY["atkBonus"]
    finish_node(state, node["id"])


def relay_leave(state):
    node = current_node(state)
    if node is None or node["type"] != "relay":
        raise GameError("当前不是爱的中继站")
    finish_node(state, node["id"])


def _card_view(card):
    stats = card_stats(
        CARDS,
        card["cardId"],
        card["level"],
        card.get("atkBonus", 0),
        card.get("hpBonus", 0),
    )
    stats["uid"] = card.get("uid")
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


def _drones_view(state):
    node = current_node(state)
    if node is None or node["type"] != "drones" or state["phase"] != "node":
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
            card.get("atkBonus", 0) + DRONES["atkBonus"],
            card.get("hpBonus", 0),
        )
        view["hpPreview"] = card_stats(
            CARDS,
            card["cardId"],
            card["level"],
            card.get("atkBonus", 0),
            card.get("hpBonus", 0) + DRONES["hpBonus"],
        )
        targets.append(view)
    return {
        "targets": targets,
        "atkBonus": DRONES["atkBonus"],
        "hpBonus": DRONES["hpBonus"],
        "drawBonus": DRONES["drawBonus"],
    }


def _training_view(state):
    node = current_node(state)
    if node is None or node["type"] != "training" or state["phase"] != "node":
        return None
    challenges = [
        {
            "id": item["id"],
            "name": item["name"],
            "description": item["description"],
            "reward": item["reward"],
        }
        for item in TRAINING["challenges"]
        if _challenge_available(state, item)
    ]
    return {"challenges": challenges}


def _relay_view(state):
    node = current_node(state)
    if node is None or node["type"] != "relay" or state["phase"] != "node":
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
            card.get("atkBonus", 0) + RELAY["atkBonus"],
            card.get("hpBonus", 0),
        )
        targets.append(view)
    return {
        "targets": targets,
        "atkBonus": RELAY["atkBonus"],
        "kept": bool((state.get("flags") or {}).get(RELAY["flag"])),
    }


def _pending_challenge_view(state):
    item = battle_challenge(state)
    if item is None:
        return None
    return {
        "id": item["id"],
        "name": item["name"],
        "description": item["description"],
        "reward": item["reward"],
    }


def _calibration_view(state):
    node = current_node(state)
    if node is None or node["type"] != "calibration" or state["phase"] != "node":
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
            card.get("atkBonus", 0) + CALIBRATION["atkBonus"],
            card.get("hpBonus", 0),
        )
        view["hpPreview"] = card_stats(
            CARDS,
            card["cardId"],
            card["level"],
            card.get("atkBonus", 0),
            card.get("hpBonus", 0) + CALIBRATION["hpBonus"],
        )
        max_level = len(CARDS[card["cardId"]]["levels"])
        view["canLevel"] = card["level"] < max_level
        if view["canLevel"]:
            view["levelPreview"] = card_stats(
                CARDS,
                card["cardId"],
                card["level"] + CALIBRATION["levelBonus"],
                card.get("atkBonus", 0),
                card.get("hpBonus", 0),
            )
        targets.append(view)
    return {
        "targets": targets,
        "atkBonus": CALIBRATION["atkBonus"],
        "hpBonus": CALIBRATION["hpBonus"],
        "levelBonus": CALIBRATION["levelBonus"],
    }


def _recycle_view(state):
    node = current_node(state)
    if node is None or node["type"] != "recycle" or state["phase"] != "node":
        return None
    targets = []
    for card in state["cards"]:
        view = _card_view(card)
        view["price"] = recycle_price(card)
        view["removable"] = _recycle_removable(state, card)
        targets.append(view)
    return {"targets": targets, "hasTargets": any(item["removable"] for item in targets)}


def _drift_view(state):
    node = current_node(state)
    if node is None or node["type"] != "drift" or state["phase"] != "node":
        return None
    candidates = []
    for card_id in _drift_candidates(state):
        owned = _owned_card(state, card_id)
        current_level = owned["level"] if owned else 0
        target_level = current_level + 1 if owned else 1
        stats = card_stats(
            CARDS,
            card_id,
            target_level,
            owned.get("atkBonus", 0) if owned else 0,
            owned.get("hpBonus", 0) if owned else 0,
        )
        stats["currentLevel"] = current_level
        stats["targetLevel"] = target_level
        stats["isUpgrade"] = owned is not None
        stats["effectText"] = _effect_text(stats)
        candidates.append(stats)
    data = state["nodeData"]
    rerolls = data.get("rerolls", 0)
    return {
        "candidates": candidates,
        "hasTargets": bool(candidates),
        "rerolls": rerolls,
        "rerollLimit": DRIFT["rerollLimit"],
        "rerollPrice": DRIFT["rerollPrice"],
        "canReroll": (
            rerolls < DRIFT["rerollLimit"]
            and state["gold"] >= DRIFT["rerollPrice"]
            and bool(_drift_candidates(state, rerolls + 1))
        ),
    }


def _shop_view(state):
    node = current_node(state)
    if node is None or node["type"] != "shop" or state["phase"] != "node":
        return None
    purchased = bool(state["nodeData"].get("purchased"))
    offers = []
    for offer in SHOP["offers"]:
        view = {
            "id": offer["id"],
            "kind": offer["kind"],
            "cardId": offer["cardId"],
            "name": CARDS[offer["cardId"]]["name"],
            "price": offer["price"],
        }
        if offer["kind"] == "boost":
            label = "攻击" if offer["effect"] == "atk" else "最大生命"
            view["effectText"] = f"{label} +{offer['amount']}"
        buyable, reason = _shop_available(state, offer)
        if purchased:
            buyable, reason = False, "本节点已购买"
        elif state["gold"] < offer["price"]:
            buyable, reason = False, "金币不足"
        view["buyable"] = buyable
        view["reason"] = reason
        offers.append(view)
    return {"offers": offers, "purchased": purchased}


def _trial_view(state):
    node = current_node(state)
    if node is None or node["type"] != "trial" or state["phase"] != "node":
        return None
    data = state["nodeData"]
    trials = []
    for item in _trial_offered(state):
        progress = _trial_metric(state, item["id"])
        trials.append(
            {
                "id": item["id"],
                "name": item["name"],
                "description": item["description"],
                "target": item["target"],
                "progress": progress,
                "passed": progress >= item["target"],
            }
        )
    candidates = []
    if data.get("status") == "success":
        for card_id in data.get("candidates", []):
            owned = _owned_card(state, card_id)
            current_level = owned["level"] if owned else 0
            target_level = current_level + 1 if owned else 1
            stats = card_stats(
                CARDS,
                card_id,
                target_level,
                owned.get("atkBonus", 0) if owned else 0,
                owned.get("hpBonus", 0) if owned else 0,
            )
            stats["currentLevel"] = current_level
            stats["targetLevel"] = target_level
            stats["isUpgrade"] = owned is not None
            stats["effectText"] = _effect_text(stats)
            candidates.append(stats)
    return {
        "trials": trials,
        "status": data.get("status", "choose"),
        "trialId": data.get("trialId"),
        "candidates": candidates,
        "hasCandidates": bool(candidates),
        "failureGold": TRIAL["failureGold"],
    }


def public_state(state):
    node = current_node(state)
    map_data = state.get("mapData")
    map_type = current_map_type(state)
    return {
        "phase": state["phase"],
        "mapType": map_type,
        "mapMeta": map_meta(map_type),
        "canStartMap2": can_start_map2(state),
        "canStartMap3": can_start_map3(state),
        "gold": state["gold"],
        "node": {
            "id": node["id"],
            "type": node["type"],
            "name": node["name"],
            "role": node.get("role"),
            "encounter": node.get("encounter"),
        }
        if node
        else None,
        "story": _story_view(state),
        "deck": deck_view(state),
        "completed": list(state["completed"]),
        "route": state.get("route"),
        "progress": len(state["completed"]),
        "runLength": map_data["runLength"] if isinstance(map_data, dict) else RUN_LENGTH,
        "recruit": _recruit_view(state),
        "signal": _signal_view(state),
        "adventure": _adventure_view(state),
        "calibration": _calibration_view(state),
        "recycle": _recycle_view(state),
        "drift": _drift_view(state),
        "shop": _shop_view(state),
        "trial": _trial_view(state),
        "drones": _drones_view(state),
        "training": _training_view(state),
        "relay": _relay_view(state),
        "pendingChallenge": _pending_challenge_view(state),
        "eliteReward": _elite_reward_view(state),
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

    map_data = state.get("mapData")
    if map_data is not None:
        if not isinstance(map_data, dict):
            raise ValueError("存档地图非法")
        try:
            _validate_generated_map(map_data, legacy=True)
        except (RuntimeError, KeyError, TypeError) as exc:
            raise ValueError(f"存档地图非法：{exc}") from exc
        node_ids = {node["id"] for node in map_data["nodes"]}
    else:
        node_ids = set(NODE_BY_ID)

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
    if state["nodeId"] not in node_ids:
        raise ValueError("存档节点无效")
    if state.get("phase") not in VALID_PHASES:
        raise ValueError("存档阶段非法")

    completed = state.get("completed")
    if not isinstance(completed, list):
        raise ValueError("存档完成记录非法")
    if any(not isinstance(node_id, str) or node_id not in node_ids for node_id in completed):
        raise ValueError("存档完成记录非法")
    if len(completed) != len(set(completed)):
        raise ValueError("存档完成记录重复")
    route = state.get("route")
    if isinstance(route, str):
        if route not in ("recruit", "signal"):
            raise ValueError("存档路线非法")
        state["route"] = {"supply": route}
    elif route is None:
        inferred = None
        if map_data is not None:
            state["route"] = {}
        else:
            if version <= 2:
                if "signal" in completed or state["nodeId"] == "signal":
                    inferred = "signal"
                elif "recruit" in completed or state["nodeId"] in ("recruit", "adventure", "battle2"):
                    inferred = "recruit"
            else:
                node = NODE_BY_ID.get(state["nodeId"])
                if node and node.get("branchGroup"):
                    inferred = (node["branchGroup"], node["branch"])
            if isinstance(inferred, tuple):
                state["route"] = {inferred[0]: inferred[1]}
            else:
                state["route"] = {"supply": inferred} if inferred else {}
    elif not isinstance(route, dict):
        raise ValueError("存档路线非法")
    for group, branch in state["route"].items():
        if (group, branch) not in BRANCH_PAIRS:
            raise ValueError("存档路线非法")
    if state.get("phase") == "complete":
        state["nodeId"] = map_data["boss"] if map_data is not None else "battle2"

    flags = state.setdefault("flags", {})
    if not isinstance(flags, dict):
        raise ValueError("存档剧情标记非法")
    node_data = state.setdefault("nodeData", {})
    if not isinstance(node_data, dict):
        raise ValueError("存档节点数据非法")
    if state["phase"] == "elite_reward":
        active = _map_nodes(state).get(state["nodeId"])
        if active is None or not active.get("eliteReward"):
            raise ValueError("存档精英奖励节点非法")
        seed = node_data.get("seed")
        if not isinstance(seed, int) or isinstance(seed, bool):
            raise ValueError("存档精英奖励种子非法")
        if not isinstance(node_data.get("claimed"), bool):
            raise ValueError("存档精英奖励状态非法")
    pending = state.setdefault("pendingChallenges", [])
    if not isinstance(pending, list):
        raise ValueError("存档挑战非法")
    for item in pending:
        if not isinstance(item, dict) or item.get("id") not in CHALLENGE_BY_ID:
            raise ValueError("存档挑战非法")
        if not _challenge_available(state, CHALLENGE_BY_ID[item["id"]]):
            raise ValueError("存档挑战未解锁")
    draw_bonus = state.setdefault("pendingDrawBonus", 0)
    if not isinstance(draw_bonus, int) or isinstance(draw_bonus, bool) or draw_bonus < 0:
        raise ValueError("存档抽牌加成非法")
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
    seen_uids = set()
    for card in cards:
        card_uid = card.get("uid")
        if not isinstance(card_uid, str) or not card_uid or card_uid in seen_uids:
            card_uid = uuid.uuid4().hex[:12]
            card["uid"] = card_uid
        seen_uids.add(card_uid)

    state["schemaVersion"] = SCHEMA_VERSION
    _normalize(state)
    after = json.dumps(state, sort_keys=True, ensure_ascii=False)
    return state, before != after
