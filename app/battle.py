"""战斗规则。状态是普通 dict，不依赖 HTTP 或数据库，便于直接测试。"""

import random

MAX_HAND = 10
HIGH_COST = 6
HIGH_COST_UNLOCK_TURN = 3
COLUMNS = 4
LOG_LIMIT = 60
FIRST_TURN_ENERGY = 4
OPENING_DRAW = 6
ATTACK_PATTERNS = ("forward", "split_attack", "double_strike", "sweep")
KNOWN_ABILITIES = ("wide_2", "flying", "reach")
ON_DEPLOY_TRIGGERS = ("energy_penalty", "copy_opposite")
ON_DESTROY_TRIGGERS = ("burst_adjacent", "hit_opposite")
TUTORIAL_STEPS = (
    {"action": "continue", "title": "先看目标和资源", "text": "把敌方领袖生命打空就能赢。自己的生命归零就会输。顶部显示回合和能量；每回合增加 2 点，没花完的会留下。点底部“手牌”展开卡牌。", "button": "开始", "uiTargets": ["enemy-hp", "player-hp", "energy", "hand-toggle"]},
    {"action": "deploy", "cardId": "shell", "side": "player", "column": 2, "title": "部署单位", "text": "把高亮的盾壳拖到己方第 2 列。部署要花能量，单位会挡住同列敌人。", "uiTargets": ["energy"]},
    {"action": "end", "title": "点这里结束回合", "text": "攻击都在你点击“结束回合”后结算：己方和场上的敌人都会攻击。候补区的敌人还没上场，不会攻击。"},
    {"action": "command", "cardId": "spark", "side": "enemy", "column": 2, "title": "用指令牌", "text": "把闪电脉冲拖到敌方第 2 列，花费能量并造成伤害。用过的牌会离开本场牌组。", "uiTargets": ["energy"]},
    {"action": "continue", "title": "接下来由你来打", "text": "看好双方领袖生命，留意顶部能量。点底部“结束回合”才会交锋；“手牌”和“回收模式”也在下方。上方候补是之后要来的敌人。", "button": "开始战斗", "uiTargets": ["end-turn", "recycle-btn", "forecast-row"]},
)


class GameError(Exception):
    pass


def card_stats(cards, card_id, level, atk_bonus=0, hp_bonus=0):
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
        result["hp"] = level_data["hp"] + hp_bonus
        result["maxHp"] = result["hp"]
        result["width"] = definition.get("width", 1)
        result["attackPattern"] = definition.get("attackPattern", "forward")
        result["abilities"] = list(definition.get("abilities", []))
        result["shield"] = definition.get("shield", 0)
        result["guard"] = definition.get("guard", 0)
        result["shift"] = definition.get("shift", 0)
        result["anchor"] = definition.get("anchor", 0)
        result["onDeploy"] = definition.get("onDeploy")
        result["onDestroy"] = definition.get("onDestroy")
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
    return card_stats(
        b["cards"], card["cardId"], card["level"], card.get("atkBonus", 0), card.get("hpBonus", 0)
    )["cost"]


def _fit_extra_plan(encounter_plan, extra_plan, enemies):
    """Move challenge reinforcements to a free column of the same turn."""
    plan = list(encounter_plan)
    for raw in extra_plan or []:
        item = dict(raw)
        width = enemies[item["enemy"]].get("width", 1)
        occupied = set()
        for planned in plan:
            if planned["turn"] == item["turn"]:
                planned_width = enemies[planned["enemy"]].get("width", 1)
                occupied.update(
                    range(planned["column"], planned["column"] + planned_width)
                )

        def fits(start):
            return 1 <= start and start + width - 1 <= COLUMNS and not any(
                column in occupied for column in range(start, start + width)
            )

        if not fits(item["column"]):
            item["column"] = next(
                (start for start in range(1, COLUMNS + 1) if fits(start)),
                item["column"],
            )
        plan.append(item)
    return plan


def make_battle(
    deck_cards,
    encounter,
    cards,
    enemies,
    rng=None,
    first_turn_energy=None,
    extra_plan=None,
    opening_draw=None,
):
    rng = rng or random.Random()
    b = {
        "cards": cards,
        "enemies": enemies,
        "turn": 0,
        "energy": 0,
        "firstTurnEnergy": (
            FIRST_TURN_ENERGY if first_turn_energy is None else max(0, first_turn_energy)
        ),
        "openingDraw": OPENING_DRAW if opening_draw is None else max(1, opening_draw),
        "hp": {"player": encounter["playerHp"], "enemy": encounter["enemyHp"]},
        "board": {"player": [None] * COLUMNS, "enemy": [None] * COLUMNS},
        "hand": [],
        "deck": [],
        "used": [],
        "discarded": [],
        "plan": _fit_extra_plan(encounter["plan"], extra_plan, enemies),
        "deployedPlanTurns": [],
        "deployedPlanIndexes": [],
        "enemyReserve": [],
        "enemyQueue": [],
        "phase": "player",
        "result": None,
        "next_uid": 1,
        "nextTurnEnergyPenalty": 0,
        "jammerUsed": False,
        "log": [],
    }
    for card in deck_cards:
        b["deck"].append(
            {
                "uid": b["next_uid"],
                "cardId": card["cardId"],
                "level": card["level"],
                "atkBonus": card.get("atkBonus", 0),
                "hpBonus": card.get("hpBonus", 0),
            }
        )
        b["next_uid"] += 1
    if encounter.get("tutorial"):
        b["tutorialStep"] = 0
        opening = encounter["openingHand"]
        ordered = []
        for card_id in opening:
            card = next((c for c in b["deck"] if c["cardId"] == card_id), None)
            if card is None:
                raise GameError("教学牌组缺少必需卡牌，请重新开始冒险")
            ordered.append(card)
            b["deck"].remove(card)
        b["deck"] = ordered + b["deck"]
    else:
        rng.shuffle(b["deck"])
    b["_drawnUids"] = _start_turn(b, rng)
    _deploy_plan_turn(b, b["turn"])
    _fill_enemy_reserve(b, rng, include_next_turn=True)
    return b


def _start_turn(b, rng):
    b["turn"] += 1
    if b["turn"] == 1:
        b["energy"] = b["firstTurnEnergy"]
        drawn_uids = _draw_opening(b, rng)
        _log(b, f"第 1 回合：获得 {b['energy']} 点能量，抽取起手 {b['openingDraw']} 张")
    else:
        penalty = b["nextTurnEnergyPenalty"]
        b["nextTurnEnergyPenalty"] = 0
        b["energy"] += 2
        if penalty:
            b["energy"] = max(0, b["energy"] - penalty)
            _log(b, f"第 {b['turn']} 回合：获得 2 点能量（信号干扰 -{penalty}）")
        else:
            _log(b, f"第 {b['turn']} 回合：获得 2 点能量")
        draw_count = _available_draw_count(b, 2)
        required = max(0, len(b["hand"]) + draw_count - MAX_HAND)
        if required:
            b["pendingDraw"] = draw_count
            b["phase"] = "discard"
            drawn_uids = []
            _log(b, f"抽牌前请先弃掉 {required} 张手牌")
        else:
            drawn_uids = _draw_regular(b, rng, draw_count)
            _log(b, f"抽取 {len(drawn_uids)} 张")
    _check_stalemate(b)
    return drawn_uids


def _draw_opening(b, rng):
    if "tutorialStep" in b:
        b["hand"] = b["deck"][:OPENING_DRAW]
        del b["deck"][:OPENING_DRAW]
        return [card["uid"] for card in b["hand"]]
    eligible = [c for c in b["deck"] if _card_cost(b, c) < HIGH_COST]
    count = min(b["openingDraw"], len(eligible))
    if count < 1:
        raise GameError("牌组中没有可抽的牌，无法开始战斗")
    low = [c for c in eligible if _card_cost(b, c) <= 2]
    low_units = [
        c
        for c in low
        if card_stats(
            b["cards"], c["cardId"], c["level"], c.get("atkBonus", 0), c.get("hpBonus", 0)
        )["type"]
        == "unit"
    ]
    if count < 4 or len(low) < 4 or not low_units:
        raise GameError("牌组无法满足起手条件（至少 4 张费用≤2、至少 1 张低费单位）")
    b["openingDraw"] = count
    unit = rng.choice(low_units)
    picks = [unit, *rng.sample([c for c in low if c is not unit], 3)]
    rest = [c for c in eligible if all(c["uid"] != pick["uid"] for pick in picks)]
    picks += rng.sample(rest, count - 4)
    rng.shuffle(picks)
    uids = {c["uid"] for c in picks}
    b["deck"] = [c for c in b["deck"] if c["uid"] not in uids]
    b["hand"].extend(picks)
    return [card["uid"] for card in picks]


def _drawable(b, card):
    return b["turn"] >= HIGH_COST_UNLOCK_TURN or _card_cost(b, card) < HIGH_COST


def _available_draw_count(b, count):
    return min(count, sum(1 for card in b["deck"] if _drawable(b, card)))


def _draw_regular(b, rng, count):
    drawn_uids = []
    for _ in range(count):
        for index, card in enumerate(b["deck"]):
            if _drawable(b, card):
                drawn = b["deck"].pop(index)
                b["hand"].append(drawn)
                drawn_uids.append(drawn["uid"])
                break
        else:
            _log(b, "牌堆中已无符合条件可抽的牌，本次少抽")
            return drawn_uids
    return drawn_uids


def _require_playable(b):
    if b["phase"] == "over":
        raise GameError("战斗已经结束")
    if b["phase"] == "discard":
        raise GameError("请先完成弃牌")


def tutorial_step(b):
    index = b.get("tutorialStep", len(TUTORIAL_STEPS))
    if index >= len(TUTORIAL_STEPS) or b["phase"] == "over":
        return None
    return {**TUTORIAL_STEPS[index], "index": index, "total": len(TUTORIAL_STEPS)}


def _require_tutorial(b, action, card_id=None, side=None, column=None):
    step = tutorial_step(b)
    if step and any((step["action"] != action,
                     step.get("cardId") != card_id,
                     step.get("side") != side,
                     step.get("column") != column)):
        raise GameError("请先完成当前引导：" + step["title"] + "；也可以跳过教程")


def _advance_tutorial(b):
    if tutorial_step(b):
        b["tutorialStep"] += 1


def tutorial_continue(b, skip=False):
    _require_playable(b)
    if not tutorial_step(b):
        raise GameError("当前没有待完成的教学步骤")
    if skip:
        b["tutorialStep"] = len(TUTORIAL_STEPS)
    else:
        step = tutorial_step(b)
        if step["action"] != "continue":
            raise GameError("请完成当前教学操作，或跳过教程")
        _advance_tutorial(b)


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


def _unit_columns(unit):
    return range(unit["column"], unit["column"] + unit.get("width", 1))


def _has_ability(unit, ability):
    return ability in unit.get("abilities", [])


def _side_units(b, side):
    seen = set()
    for unit in b["board"][side]:
        if unit is not None and unit["uid"] not in seen:
            seen.add(unit["uid"])
            yield unit


def repair_board(b):
    changed = False
    for side in ("player", "enemy"):
        slots = b["board"][side]
        positions = {}
        for column, unit in enumerate(slots):
            if unit is not None:
                positions.setdefault(unit["uid"], []).append(column)
        for columns in positions.values():
            unit = slots[columns[0]]
            expected = list(range(unit["column"] - 1, unit["column"] - 1 + unit.get("width", 1)))
            if columns != expected:
                for column in columns:
                    slots[column] = None
                changed = True
    return changed


def _remove_unit(b, unit):
    slots = b["board"][unit["side"]]
    for index, slot in enumerate(slots):
        if slot is not None and slot["uid"] == unit["uid"]:
            slots[index] = None


def _on_board(b, unit):
    return any(slot is not None and slot["uid"] == unit["uid"] for slot in b["board"][unit["side"]])


def _resolve_on_deploy(b, unit):
    trigger = unit.get("onDeploy")
    if trigger == "energy_penalty":
        if b["jammerUsed"]:
            return
        b["jammerUsed"] = True
        b["nextTurnEnergyPenalty"] = 1
        _log(b, f"{unit['name']} 干扰能量回路：下回合能量 -1")
    elif trigger == "copy_opposite":
        target = b["board"]["player"][unit["column"] - 1]
        if target is None:
            _log(b, f"{unit['name']} 没有可镜像的对位单位")
            return
        unit["attackPattern"] = target.get("attackPattern", "forward")
        _log(b, f"{unit['name']} 镜像 {target['name']} 的攻击模式")


def _resolve_on_destroy(b, unit):
    if unit.get("destroyResolved"):
        return
    unit["destroyResolved"] = True
    trigger = unit.get("onDestroy")
    if trigger not in ON_DESTROY_TRIGGERS:
        return
    side = "enemy" if unit["side"] == "player" else "player"
    if trigger == "burst_adjacent":
        seen = set()
        for column in (unit["column"] - 1, unit["column"] + 1):
            if not (1 <= column <= COLUMNS):
                continue
            target = b["board"][side][column - 1]
            if target is None or target["uid"] in seen:
                continue
            seen.add(target["uid"])
            _log(b, f"{unit['name']} 爆炸，对 {target['name']} 造成 1 点伤害")
            _damage_unit(b, target, 1, effect="burst_beetle")
    elif trigger == "hit_opposite":
        target = b["board"][side][unit["column"] - 1]
        if target is not None:
            _log(b, f"{unit['name']} 爆炸，对 {target['name']} 造成 2 点伤害")
            _damage_unit(b, target, 2, effect="mine_beetle")


def _guard_for(b, target):
    target_columns = set(_unit_columns(target))
    for unit in _side_units(b, "player"):
        if unit["uid"] == target["uid"] or unit.get("guard", 0) <= 0:
            continue
        if any(
            abs(guard_column - column) == 1
            for guard_column in _unit_columns(unit)
            for column in target_columns
        ):
            return unit
    return None


def _anchor_blocks(b, target):
    target_columns = set(_unit_columns(target))
    for unit in _side_units(b, "enemy"):
        if unit.get("anchor", 0) <= 0:
            continue
        if any(
            abs(anchor_column - column) == 1
            for anchor_column in _unit_columns(unit)
            for column in target_columns
        ):
            return True
    return False


def _combat_event(b, kind, **fields):
    if "combatEvents" in b:
        b["combatEvents"].append({"kind": kind, **fields})


def _damage_unit(b, unit, amount, effect=None):
    blocked = amount > 0 and unit.get("shield", 0) > 0
    if blocked:
        unit["shield"] -= 1
        amount = max(0, amount - 1)
        _log(b, f"{unit['name']} 的护盾抵消 1 点伤害")
    applied = min(unit["hp"], amount)
    unit["hp"] -= amount
    _combat_event(b, "damage", target=unit["uid"], side=unit["side"], hp=max(0, unit["hp"]),
                  amount=applied, blocked=blocked, effect=effect)
    if unit["hp"] <= 0:
        unit["hp"] = 0
        _remove_unit(b, unit)
        _log(b, f"{unit['name']} 被击败")
        _resolve_on_destroy(b, unit)
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
        "width": stats.get("width", 1),
        "attackPattern": stats.get("attackPattern", "forward"),
        "abilities": list(stats.get("abilities", [])),
        "shield": stats.get("shield", 0),
        "guard": stats.get("guard", 0),
        "shift": stats.get("shift", 0),
        "anchor": stats.get("anchor", 0),
        "onDeploy": stats.get("onDeploy"),
        "onDestroy": stats.get("onDestroy"),
    }
    b["next_uid"] += 1
    return unit


def deploy(b, uid, column):
    _require_playable(b)
    index = _hand_index(b, uid)
    card = b["hand"][index]
    _require_tutorial(b, "deploy", card["cardId"], "player", column)
    stats = card_stats(
        b["cards"], card["cardId"], card["level"], card.get("atkBonus", 0), card.get("hpBonus", 0)
    )
    if stats["type"] != "unit":
        raise GameError("这不是单位牌")
    width = stats.get("width", 1)
    if not (1 <= column <= COLUMNS - width + 1):
        raise GameError("列号无效")
    if any(b["board"]["player"][c - 1] is not None for c in range(column, column + width)):
        raise GameError("该列已有己方单位")
    if b["energy"] < stats["cost"]:
        raise GameError("能量不足")
    b["hand"].pop(index)
    b["energy"] -= stats["cost"]
    b["used"].append(card["uid"])
    unit = _make_unit(b, "player", card["cardId"], stats, stats["cost"], column, card["level"])
    for target in _unit_columns(unit):
        b["board"]["player"][target - 1] = unit
    span = f"{column}-{column + width - 1} 列" if width > 1 else f"{column} 列"
    _log(b, f"部署 {unit['name']} 到 {span}（花费 {stats['cost']} 能量）")
    _resolve_on_deploy(b, unit)
    _advance_tutorial(b)
    _check_stalemate(b)


def play_command(b, uid, target_uid):
    _require_playable(b)
    index = _hand_index(b, uid)
    card = b["hand"][index]
    stats = card_stats(
        b["cards"], card["cardId"], card["level"], card.get("atkBonus", 0), card.get("hpBonus", 0)
    )
    if stats["type"] != "command":
        raise GameError("这不是指令牌")
    target = _find_unit(b, target_uid)
    if target is None:
        raise GameError("目标无效")
    _require_tutorial(b, "command", card["cardId"], target["side"], target["column"])
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
        _damage_unit(b, target, stats["damage"], effect="energy")
    _advance_tutorial(b)
    _check_stalemate(b)


def recycle(b, column):
    _require_playable(b)
    if not (1 <= column <= COLUMNS):
        raise GameError("列号无效")
    unit = b["board"]["player"][column - 1]
    if unit is None:
        raise GameError("该列没有己方单位")
    _require_tutorial(b, "recycle", side="player", column=column)
    refund = recycle_refund(unit["paid"])
    b["energy"] += refund
    _remove_unit(b, unit)
    _log(b, f"回收 {unit['name']}，返还 {refund} 点能量")
    _advance_tutorial(b)


def discard(b, uids):
    if b["phase"] != "discard":
        raise GameError("当前不需要弃牌")
    pending_draw = b.get("pendingDraw")
    required = (
        max(0, len(b["hand"]) + pending_draw - MAX_HAND)
        if pending_draw is not None
        else len(b["hand"]) - MAX_HAND
    )
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
    drawn_uids = []
    if pending_draw is not None:
        drawn_uids = _draw_regular(b, random.Random(), pending_draw)
        b.pop("pendingDraw", None)
    b["phase"] = "player"
    _log(b, f"弃掉 {len(uids)} 张牌")
    _check_stalemate(b)
    return drawn_uids


def end_turn(b, rng=None):
    rng = rng or random.Random()
    _require_playable(b)
    _require_tutorial(b, "end")
    _player_attack(b)
    if b["phase"] == "over":
        return
    _enemy_phase(b, rng)
    if b["phase"] == "over":
        return
    b["_drawnUids"] = _start_turn(b, rng)
    _fill_enemy_reserve(b, rng, include_next_turn=True)
    _advance_tutorial(b)


def _target_columns(unit):
    start = unit["column"]
    width = unit.get("width", 1)
    pattern = unit.get("attackPattern", "forward")
    if pattern == "split_attack":
        columns = list(range(start, start + width)) if width > 1 else [start, start + 1]
    elif pattern == "double_strike":
        columns = [start, start]
    elif pattern == "sweep":
        columns = list(range(1, COLUMNS + 1))
    else:
        columns = [start]
    return [column for column in columns if column <= COLUMNS]


def _resolve_attack(b, attacker, column):
    defender_side = "enemy" if attacker["side"] == "player" else "player"
    target = b["board"][defender_side][column - 1]
    if (
        target is not None
        and _has_ability(attacker, "flying")
        and not _has_ability(target, "flying")
        and not _has_ability(target, "reach")
    ):
        _log(b, f"{attacker['name']} 飞越 {column} 列")
        target = None
    if (
        target is not None
        and _has_ability(target, "flying")
        and not _has_ability(attacker, "reach")
        and not _has_ability(attacker, "flying")
    ):
        _log(b, f"{attacker['name']} 无法攻击飞行单位 {target['name']}")
        _combat_event(b, "attack", source=attacker["uid"], target=target["uid"],
                      side=defender_side, column=column, pattern=attacker.get("attackPattern", "forward"), miss=True)
        return
    if target is None and attacker.get("attackPattern") == "sweep":
        return
    intercepted = False
    if target is not None and attacker["side"] == "enemy":
        guard = _guard_for(b, target)
        if guard is not None and _anchor_blocks(b, target):
            _log(b, f"{target['name']} 被空间锚锁定，{guard['name']} 无法拦截")
        elif guard is not None:
            guard["guard"] -= 1
            _log(b, f"{guard['name']} 替 {target['name']} 拦截攻击")
            target = guard
            intercepted = True
    _combat_event(b, "attack", source=attacker["uid"], target=target["uid"] if target else None,
                  side=defender_side, column=column, pattern=attacker.get("attackPattern", "forward"),
                  leader=target is None, miss=False, intercepted=intercepted)
    if target is not None:
        _log(b, f"{attacker['name']} 攻击 {target['name']}，造成 {attacker['atk']} 点伤害")
        _damage_unit(b, target, attacker["atk"])
        return
    applied = min(b["hp"][defender_side], attacker["atk"])
    b["hp"][defender_side] -= attacker["atk"]
    who = "敌方领袖" if attacker["side"] == "player" else "己方领袖"
    _log(b, f"{attacker['name']} 攻击{who}，造成 {attacker['atk']} 点伤害")
    if b["hp"][defender_side] <= 0:
        b["hp"][defender_side] = 0
        (_win if attacker["side"] == "player" else _lose)(b)
    _combat_event(b, "damage", target=None, side=defender_side, leader=True,
                  hp=b["hp"][defender_side], amount=applied)


def _attack_columns(b, unit):
    """一次多列攻击；横扫对同一宽体单位只结算一次。"""
    defender = "enemy" if unit["side"] == "player" else "player"
    if unit.get("attackPattern") == "sweep" and not any(b["board"][defender]):
        if b["phase"] != "over" and _on_board(b, unit):
            _combat_event(b, "attack", source=unit["uid"], target=None,
                          side=defender, column=unit["column"], miss=True)
        return
    swept = set()
    for column in _target_columns(unit):
        if b["phase"] == "over":
            return
        if not _on_board(b, unit):
            return
        if unit.get("attackPattern") == "sweep":
            target = b["board"][defender][column - 1]
            if target is not None:
                if target["uid"] in swept:
                    continue
                swept.add(target["uid"])
        _resolve_attack(b, unit, column)


def _player_attack(b):
    for unit in _side_units(b, "player"):
        _attack_columns(b, unit)


def _shift_enemies(b):
    for unit in sorted(_side_units(b, "enemy"), key=lambda item: item["column"], reverse=True):
        if unit.get("shift", 0) <= 0:
            continue
        target = unit["column"] + 1
        width = unit.get("width", 1)
        if target + width - 1 > COLUMNS:
            continue
        columns = range(target, target + width)
        if any(
            b["board"]["enemy"][column - 1] not in (None, unit) for column in columns
        ):
            _log(b, f"{unit['name']} 无法移动：{target} 列已有单位")
            continue
        _remove_unit(b, unit)
        unit["column"] = target
        for column in columns:
            b["board"]["enemy"][column - 1] = unit
        _log(b, f"{unit['name']} 向右移动到 {target} 列")


def _enemy_phase(b, rng=None):
    rng = rng or random.Random()
    for unit in _side_units(b, "enemy"):
        _attack_columns(b, unit)
        if b["phase"] == "over":
            return
    _shift_enemies(b)
    _deploy_reserved_turn(b, b["turn"] + 1, rng)


def _candidate_starts(b, width):
    occupied = set()
    for entry in b.setdefault("enemyReserve", []):
        occupied.update(entry.get("slots", range(entry["column"], entry["column"] + entry.get("width", 1))))
    return [
        start for start in range(1, COLUMNS - width + 2)
        if not any(column in occupied for column in range(start, start + width))
    ]


def _fill_enemy_reserve(b, rng=None, include_next_turn=False):
    rng = rng or random.Random()
    reserve = b.setdefault("enemyReserve", [])
    for entry in reserve:
        item = b["plan"][entry["planIndex"]]
        entry.setdefault("column", item["column"])
        width = b["enemies"][item["enemy"]].get("width", 1)
        entry.setdefault("width", width)
        entry.setdefault("slots", list(range(entry["column"], entry["column"] + width)))
    queue = b.setdefault("enemyQueue", [])
    next_turn = b["turn"] + 1
    known = {entry["planIndex"] for entry in reserve} | set(queue) | set(b.setdefault("deployedPlanIndexes", []))
    if include_next_turn:
        queue.extend(
            index for index, item in enumerate(b["plan"])
            if item["turn"] == next_turn and index not in known
        )
    queue.sort(key=lambda index: (b["plan"][index]["turn"], index))
    while queue:
        index = queue[0]
        item = b["plan"][index]
        width = b["enemies"][item["enemy"]].get("width", 1)
        starts = _candidate_starts(b, width)
        if not starts:
            break
        column = item["column"] if item["column"] in starts else rng.choice(starts)
        reserve.append({"planIndex": index, "column": column, "width": width,
                        "slots": list(range(column, column + width))})
        queue.pop(0)


def _deploy_reserved_turn(b, turn, rng=None):
    rng = rng or random.Random()
    remaining = []
    for entry in b.setdefault("enemyReserve", []):
        if entry["planIndex"] >= len(b["plan"]):
            continue
        item = b["plan"][entry["planIndex"]]
        if item["turn"] > turn or not _deploy_plan_item(b, {**item, "column": entry["column"]}):
            remaining.append(entry)
        else:
            b.setdefault("deployedPlanIndexes", []).append(entry["planIndex"])
    b["enemyReserve"] = remaining
    _fill_enemy_reserve(b, rng, include_next_turn=True)


def _deploy_plan_turn(b, turn):
    deployed_turns = b.setdefault("deployedPlanTurns", [])
    if turn in deployed_turns:
        return
    deployed_turns.append(turn)
    for index, item in enumerate(b["plan"]):
        if item["turn"] != turn or index in b.setdefault("deployedPlanIndexes", []):
            continue
        _deploy_plan_item(b, item)
        b["deployedPlanIndexes"].append(index)


def _deploy_plan_item(b, item):
    enemy = b["enemies"][item["enemy"]]
    width = enemy.get("width", 1)
    start = item["column"]
    columns = range(start, start + width)
    if any(b["board"]["enemy"][column - 1] is not None for column in columns):
        span = f"{start}-{start + width - 1}" if width > 1 else f"{start}"
        _log(b, f"敌方计划在 {span} 列部署，但范围已被占用，跳过")
        return False
    stats = {
        "name": enemy["name"],
        "atk": enemy["atk"],
        "hp": enemy["hp"],
        "maxHp": enemy["hp"],
        "width": width,
        "attackPattern": enemy.get("attackPattern", "forward"),
        "abilities": list(enemy.get("abilities", [])),
        "shield": enemy.get("shield", 0),
        "guard": enemy.get("guard", 0),
        "shift": enemy.get("shift", 0),
        "anchor": enemy.get("anchor", 0),
        "onDeploy": enemy.get("onDeploy"),
        "onDestroy": enemy.get("onDestroy"),
    }
    unit = _make_unit(b, "enemy", item["enemy"], stats, 0, start, 1)
    for column in columns:
        b["board"]["enemy"][column - 1] = unit
    span = f"{start}-{start + width - 1} 列" if width > 1 else f"{start} 列"
    _log(b, f"敌方在 {span}部署 {unit['name']}")
    _resolve_on_deploy(b, unit)
    return True


def repair_forecast_timing(b):
    """旧战斗档案把当前回合计划留到回合末；将其补入场上一次。"""
    changed = False
    if "deployedPlanTurns" not in b:
        b["deployedPlanTurns"] = []
        _deploy_plan_turn(b, b["turn"])
        changed = True
    if "deployedPlanIndexes" not in b:
        b["deployedPlanIndexes"] = [
            index for index, item in enumerate(b["plan"])
            if item["turn"] <= b["turn"]
        ]
        changed = True
    if "enemyReserve" not in b:
        b["enemyReserve"] = []
        changed = True
    normalized = []
    for entry in b["enemyReserve"]:
        if entry.get("status") == "deployed":
            b.setdefault("deployedPlanIndexes", []).append(entry["planIndex"])
            changed = True
            continue
        if entry.get("planIndex", -1) >= len(b["plan"]):
            changed = True
            continue
        normalized.append(entry)
    if normalized != b["enemyReserve"]:
        b["enemyReserve"] = normalized
        changed = True
    if "enemyQueue" not in b:
        b["enemyQueue"] = []
        changed = True
    before = len(b["enemyReserve"])
    before_queue = len(b["enemyQueue"])
    _fill_enemy_reserve(b, include_next_turn=True)
    return changed or before != len(b["enemyReserve"]) or before_queue != len(b["enemyQueue"])


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
    if any(b["board"]["player"]):
        return
    if b["deck"] or any(item["turn"] > b["turn"] for item in b["plan"]):
        return
    enemy_units = list(_side_units(b, "enemy"))
    if any(unit.get("atk", 0) > 0 and unit.get("attackPattern") != "sweep" for unit in enemy_units):
        return
    for card in b["hand"]:
        stats = card_stats(
            b["cards"], card["cardId"], card["level"], card.get("atkBonus", 0), card.get("hpBonus", 0)
        )
        if stats["type"] == "unit":
            return
        if stats.get("damage") is not None and enemy_units:
            return
    _lose(b)
    _log(b, "双方都无力继续，判定失败")


def _hand_view(b, card):
    stats = card_stats(
        b["cards"], card["cardId"], card["level"], card.get("atkBonus", 0), card.get("hpBonus", 0)
    )
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
        "width": unit.get("width", 1),
        "attackPattern": unit.get("attackPattern", "forward"),
        "abilities": list(unit.get("abilities", [])),
        "shield": unit.get("shield", 0),
        "guard": unit.get("guard", 0),
        "shift": unit.get("shift", 0),
        "anchor": unit.get("anchor", 0),
        "onDeploy": unit.get("onDeploy"),
        "onDestroy": unit.get("onDestroy"),
        "side": unit["side"],
        "refund": recycle_refund(unit["paid"]),
    }


def view(b):
    return {
        "tutorial": tutorial_step(b),
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
        "discardRequired": (
            max(0, len(b["hand"]) + b["pendingDraw"] - MAX_HAND)
            if "pendingDraw" in b
            else max(0, len(b["hand"]) - MAX_HAND)
        ) if b["phase"] == "discard" else 0,
        "nextTurnEnergyPenalty": b["nextTurnEnergyPenalty"],
        "forecast": [
            {
                "slot": entry["slots"][0] - 1,
                "slots": list(entry["slots"]),
                "turn": item["turn"],
                "column": entry["column"],
                "width": b["enemies"][item["enemy"]].get("width", 1),
                "attackPattern": b["enemies"][item["enemy"]].get("attackPattern", "forward"),
                "abilities": list(b["enemies"][item["enemy"]].get("abilities", [])),
                "shield": b["enemies"][item["enemy"]].get("shield", 0),
                "guard": b["enemies"][item["enemy"]].get("guard", 0),
                "shift": b["enemies"][item["enemy"]].get("shift", 0),
                "anchor": b["enemies"][item["enemy"]].get("anchor", 0),
                "onDeploy": b["enemies"][item["enemy"]].get("onDeploy"),
                "onDestroy": b["enemies"][item["enemy"]].get("onDestroy"),
                "name": b["enemies"][item["enemy"]]["name"],
                "atk": b["enemies"][item["enemy"]]["atk"],
                "hp": b["enemies"][item["enemy"]]["hp"],
            }
            for entry in b.get("enemyReserve", [])
            if entry["planIndex"] < len(b["plan"])
            for item in (b["plan"][entry["planIndex"]],)
        ],
        "log": list(b["log"][-12:]),
    }
