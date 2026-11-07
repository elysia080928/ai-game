"""战斗规则。状态是普通 dict，不依赖 HTTP 或数据库，便于直接测试。"""

import random

MAX_HAND = 10
HIGH_COST = 6
HIGH_COST_UNLOCK_TURN = 3
COLUMNS = 4
LOG_LIMIT = 60


class GameError(Exception):
    pass


def card_stats(cards, card_id, level, atk_bonus=0):
    definition = cards[card_id]
    level_data = definition["levels"][level - 1]
    result = {
        "cardId": card_id,
        "name": definition["name"],
        "type": definition["type"],
        "level": level,
        "cost": level_data["cost"],
    }
    if definition["type"] == "unit":
        result["atk"] = level_data["atk"] + atk_bonus
        result["hp"] = level_data["hp"]
        result["maxHp"] = level_data["hp"]
    else:
        result["heal"] = level_data.get("heal")
        result["damage"] = level_data.get("damage")
    return result


def recycle_refund(paid):
    return max(1, paid // 2)


def _log(b, text):
    b["log"].append(text)
    if len(b["log"]) > LOG_LIMIT:
        del b["log"][: len(b["log"]) - LOG_LIMIT]


def _card_cost(b, card):
    return card_stats(b["cards"], card["cardId"], card["level"], card.get("atkBonus", 0))["cost"]


def make_battle(deck_cards, encounter, cards, enemies, rng=None):
    rng = rng or random.Random()
    b = {
        "cards": cards,
        "enemies": enemies,
        "turn": 0,
        "energy": 0,
        "hp": {"player": encounter["playerHp"], "enemy": encounter["enemyHp"]},
        "board": {"player": [None] * COLUMNS, "enemy": [None] * COLUMNS},
        "hand": [],
        "deck": [],
        "used": [],
        "discarded": [],
        "plan": encounter["plan"],
        "phase": "player",
        "result": None,
        "next_uid": 1,
        "log": [],
    }
    for card in deck_cards:
        b["deck"].append(
            {
                "uid": b["next_uid"],
                "cardId": card["cardId"],
                "level": card["level"],
                "atkBonus": card.get("atkBonus", 0),
            }
        )
        b["next_uid"] += 1
    rng.shuffle(b["deck"])
    _start_turn(b, rng)
    return b


def _start_turn(b, rng):
    b["turn"] += 1
    if b["turn"] == 1:
        b["energy"] = 4
        _log(b, "第 1 回合：获得 4 点能量，抽取起手 6 张")
        _draw_opening(b, rng)
    else:
        b["energy"] += 2
        _log(b, f"第 {b['turn']} 回合：获得 2 点能量，抽 2 张")
        _draw_regular(b, rng, 2)
    if b["phase"] != "over" and len(b["hand"]) > MAX_HAND:
        b["phase"] = "discard"
        _log(b, f"手牌超过 {MAX_HAND} 张，请选择弃牌")
    _check_stalemate(b)


def _draw_opening(b, rng):
    eligible = [c for c in b["deck"] if _card_cost(b, c) < HIGH_COST]
    if len(eligible) < 6:
        raise GameError("牌组中可抽的牌不足 6 张，无法开始战斗")
    picks = None
    for _ in range(2000):
        candidate = rng.sample(eligible, 6)
        low = [c for c in candidate if _card_cost(b, c) <= 2]
        low_units = [
            c
            for c in low
            if card_stats(b["cards"], c["cardId"], c["level"], c.get("atkBonus", 0))["type"] == "unit"
        ]
        if len(low) >= 4 and low_units:
            picks = candidate
            break
    if picks is None:
        raise GameError("牌组无法满足起手条件（至少 4 张费用≤2、至少 1 张低费单位）")
    uids = {c["uid"] for c in picks}
    b["deck"] = [c for c in b["deck"] if c["uid"] not in uids]
    b["hand"].extend(picks)


def _drawable(b, card):
    return b["turn"] >= HIGH_COST_UNLOCK_TURN or _card_cost(b, card) < HIGH_COST


def _draw_regular(b, rng, count):
    for _ in range(count):
        for index, card in enumerate(b["deck"]):
            if _drawable(b, card):
                b["hand"].append(b["deck"].pop(index))
                break
        else:
            _log(b, "牌堆中已无符合条件可抽的牌，本次少抽")
            return


def _require_playable(b):
    if b["phase"] == "over":
        raise GameError("战斗已经结束")
    if b["phase"] == "discard":
        raise GameError("请先完成弃牌")


def _hand_index(b, uid):
    for index, card in enumerate(b["hand"]):
        if card["uid"] == uid:
            return index
    raise GameError("手牌中没有这张卡")


def _find_unit(b, uid):
    for side in ("player", "enemy"):
        for unit in b["board"][side]:
            if unit and unit["uid"] == uid:
                return unit
    return None


def _remove_unit(b, unit):
    column = unit["column"] - 1
    if b["board"][unit["side"]][column] is unit:
        b["board"][unit["side"]][column] = None


def _damage_unit(b, unit, amount):
    unit["hp"] -= amount
    if unit["hp"] <= 0:
        unit["hp"] = 0
        _remove_unit(b, unit)
        _log(b, f"{unit['name']} 被击败")
        return True
    return False


def _make_unit(b, side, card_id, stats, paid, column, level):
    unit = {
        "uid": b["next_uid"],
        "cardId": card_id,
        "level": level,
        "name": stats["name"],
        "atk": stats["atk"],
        "hp": stats["hp"],
        "maxHp": stats["maxHp"],
        "paid": paid,
        "side": side,
        "column": column,
    }
    b["next_uid"] += 1
    return unit


def deploy(b, uid, column):
    _require_playable(b)
    index = _hand_index(b, uid)
    card = b["hand"][index]
    stats = card_stats(b["cards"], card["cardId"], card["level"], card.get("atkBonus", 0))
    if stats["type"] != "unit":
        raise GameError("这不是单位牌")
    if not (1 <= column <= COLUMNS):
        raise GameError("列号无效")
    col = column - 1
    if b["board"]["player"][col] is not None:
        raise GameError("该列已有己方单位")
    if b["energy"] < stats["cost"]:
        raise GameError("能量不足")
    b["hand"].pop(index)
    b["energy"] -= stats["cost"]
    b["used"].append(card["uid"])
    unit = _make_unit(b, "player", card["cardId"], stats, stats["cost"], column, card["level"])
    b["board"]["player"][col] = unit
    _log(b, f"部署 {unit['name']} 到 {column} 列（花费 {stats['cost']} 能量）")
    _check_stalemate(b)


def play_command(b, uid, target_uid):
    _require_playable(b)
    index = _hand_index(b, uid)
    card = b["hand"][index]
    stats = card_stats(b["cards"], card["cardId"], card["level"], card.get("atkBonus", 0))
    if stats["type"] != "command":
        raise GameError("这不是指令牌")
    target = _find_unit(b, target_uid)
    if target is None:
        raise GameError("目标无效")
    if stats.get("heal") is not None:
        if target["side"] != "player":
            raise GameError("紧急维修只能选择己方单位")
        if target["hp"] >= target["maxHp"]:
            raise GameError("该单位没有受伤")
    elif stats.get("damage") is not None:
        if target["side"] != "enemy":
            raise GameError("闪电脉冲只能选择敌方单位")
    else:
        raise GameError("未知的指令效果")
    if b["energy"] < stats["cost"]:
        raise GameError("能量不足")

    b["hand"].pop(index)
    b["energy"] -= stats["cost"]
    b["used"].append(card["uid"])
    if stats.get("heal") is not None:
        healed = min(stats["heal"], target["maxHp"] - target["hp"])
        target["hp"] += healed
        _log(b, f"紧急维修为 {target['name']} 恢复 {healed} 点生命")
    else:
        _log(b, f"闪电脉冲对 {target['name']} 造成 {stats['damage']} 点伤害")
        _damage_unit(b, target, stats["damage"])
    _check_stalemate(b)


def recycle(b, column):
    _require_playable(b)
    if not (1 <= column <= COLUMNS):
        raise GameError("列号无效")
    unit = b["board"]["player"][column - 1]
    if unit is None:
        raise GameError("该列没有己方单位")
    refund = recycle_refund(unit["paid"])
    b["energy"] += refund
    _remove_unit(b, unit)
    _log(b, f"回收 {unit['name']}，返还 {refund} 点能量")


def discard(b, uids):
    if b["phase"] != "discard":
        raise GameError("当前不需要弃牌")
    required = len(b["hand"]) - MAX_HAND
    if len(uids) != required:
        raise GameError(f"需要弃掉 {required} 张牌")
    if len(set(uids)) != len(uids):
        raise GameError("弃牌选择重复")
    hand_uids = {c["uid"] for c in b["hand"]}
    if not set(uids) <= hand_uids:
        raise GameError("只能弃掉手牌")
    chosen = set(uids)
    b["hand"] = [c for c in b["hand"] if c["uid"] not in chosen]
    b["discarded"].extend(uids)
    b["phase"] = "player"
    _log(b, f"弃掉 {len(uids)} 张牌")
    _check_stalemate(b)


def end_turn(b, rng=None):
    rng = rng or random.Random()
    _require_playable(b)
    _player_attack(b)
    if b["phase"] == "over":
        return
    _enemy_phase(b)
    if b["phase"] == "over":
        return
    _start_turn(b, rng)


def _player_attack(b):
    for column in range(COLUMNS):
        unit = b["board"]["player"][column]
        if unit is None:
            continue
        target = b["board"]["enemy"][column]
        if target is not None:
            name = target["name"]
            _log(b, f"{unit['name']} 攻击 {name}，造成 {unit['atk']} 点伤害")
            _damage_unit(b, target, unit["atk"])
        else:
            b["hp"]["enemy"] -= unit["atk"]
            _log(b, f"{unit['name']} 攻击敌方领袖，造成 {unit['atk']} 点伤害")
            if b["hp"]["enemy"] <= 0:
                b["hp"]["enemy"] = 0
                _win(b)
                return


def _enemy_phase(b):
    for item in b["plan"]:
        if item["turn"] != b["turn"]:
            continue
        col = item["column"] - 1
        if b["board"]["enemy"][col] is not None:
            _log(b, f"敌方计划在 {item['column']} 列部署，但该列已被占用，跳过")
            continue
        enemy = b["enemies"][item["enemy"]]
        stats = {
            "name": enemy["name"],
            "atk": enemy["atk"],
            "hp": enemy["hp"],
            "maxHp": enemy["hp"],
        }
        unit = _make_unit(b, "enemy", item["enemy"], stats, 0, item["column"], 1)
        b["board"]["enemy"][col] = unit
        _log(b, f"敌方在 {item['column']} 列部署 {unit['name']}")

    for column in range(COLUMNS):
        unit = b["board"]["enemy"][column]
        if unit is None:
            continue
        target = b["board"]["player"][column]
        if target is not None:
            name = target["name"]
            _log(b, f"{unit['name']} 攻击 {name}，造成 {unit['atk']} 点伤害")
            _damage_unit(b, target, unit["atk"])
        else:
            b["hp"]["player"] -= unit["atk"]
            _log(b, f"{unit['name']} 攻击己方领袖，造成 {unit['atk']} 点伤害")
            if b["hp"]["player"] <= 0:
                b["hp"]["player"] = 0
                _lose(b)
                return


def _win(b):
    b["phase"] = "over"
    b["result"] = "win"
    _log(b, "战斗胜利")


def _lose(b):
    b["phase"] = "over"
    b["result"] = "lose"
    _log(b, "战斗失败")


def _check_stalemate(b):
    if b["phase"] == "over":
        return
    if any(b["board"]["player"]) or any(b["board"]["enemy"]):
        return
    if b["hand"] or b["deck"]:
        return
    if any(item["turn"] > b["turn"] for item in b["plan"]):
        return
    _lose(b)
    _log(b, "双方都无力继续，判定失败")


def _hand_view(b, card):
    stats = card_stats(b["cards"], card["cardId"], card["level"], card.get("atkBonus", 0))
    stats["uid"] = card["uid"]
    return stats


def _unit_view(unit):
    if unit is None:
        return None
    return {
        "uid": unit["uid"],
        "cardId": unit["cardId"],
        "name": unit["name"],
        "atk": unit["atk"],
        "hp": unit["hp"],
        "maxHp": unit["maxHp"],
        "column": unit["column"],
        "side": unit["side"],
        "refund": recycle_refund(unit["paid"]),
    }


def view(b):
    return {
        "turn": b["turn"],
        "energy": b["energy"],
        "hp": dict(b["hp"]),
        "phase": b["phase"],
        "result": b["result"],
        "hand": [_hand_view(b, c) for c in b["hand"]],
        "board": {
            "player": [_unit_view(u) for u in b["board"]["player"]],
            "enemy": [_unit_view(u) for u in b["board"]["enemy"]],
        },
        "deckCount": len(b["deck"]),
        "discardRequired": max(0, len(b["hand"]) - MAX_HAND) if b["phase"] == "discard" else 0,
        "forecast": [
            {
                "turn": item["turn"],
                "column": item["column"],
                "name": b["enemies"][item["enemy"]]["name"],
            }
            for item in b["plan"]
            if item["turn"] in (b["turn"], b["turn"] + 1)
        ],
        "log": list(b["log"][-12:]),
    }
