"""离线平衡模拟入口。只调用实际战斗函数，不复制战斗规则。

用法：python tests/balance_sim.py [每类样本数]
默认每章、每类（普通/精英/Boss）各 200 局。输出为摘要表和 JSON 明细。
"""

import json
import random
import sys
from collections import Counter, defaultdict
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from app import battle, game  # noqa: E402

SAMPLE_COUNT = 200
TURN_LIMIT = 40
STRUCTURES = ("free", "growth", "delete", "focus")
STRATEGIES = ("basic", "defense", "recycle")

# 代表牌组：只拿免费补给、再走原有成长节点、主动删牌、集中强化单卡。
# 数值是章节/类别下的牌组张数，不用满级卡代替成长过程。
FREE_SIZE = {
    ("map1", "normal"): 10,
    ("map1", "elite"): 12,
    ("map1", "boss"): 12,
    ("map2", "normal"): 16,
    ("map2", "elite"): 20,
    ("map2", "boss"): 20,
    ("map3", "normal"): 22,
    ("map3", "elite"): 25,
    ("map3", "boss"): 25,
}
GROWTH_BONUS = {"map1": 2, "map2": 4, "map3": 4}

BASE_POOL = sorted(
    {
        "bean", "shell", "scout", "worker", "guard", "repair", "spark",
    }
)
CHAPTER_POOL = {
    "map1": BASE_POOL + ["shield_moth", "twin_rail"],
    "map2": BASE_POOL
    + ["shield_moth", "twin_rail", "striker", "rail_guard", "flyer", "burst_beetle", "phase_flyer"],
    "map3": sorted(game.CARDS),
}


def growth_pools():
    return {
        "map1": game.MAPS["map1"]["growthBattlePools"],
        "map2": game.MAPS["map2"]["growthBattlePools"],
        "map3": game.MAPS["map3"]["growthBattlePools"],
    }


def category_encounters(chapter, category):
    pools = growth_pools()[chapter]
    if category == "normal":
        ids = [encounter for pool in pools["positions"] for encounter in pool]
        ids += list(pools["eliteNormalPool"])
    elif category == "elite":
        ids = [pools["eliteEncounter"]]
    else:
        ids = [pools["bossEncounter"]]
    return list(dict.fromkeys(ids))


def representative_deck(chapter, category, structure):
    size = FREE_SIZE[(chapter, category)]
    if structure in ("growth", "delete", "focus"):
        size += GROWTH_BONUS[chapter]
    if structure == "delete":
        size -= 4
    pool = CHAPTER_POOL[chapter]
    deck = [{"cardId": card_id, "level": 1} for card_id in game.INITIAL_DECK]
    for index in range(max(0, size - len(deck))):
        deck.append({"cardId": pool[index % len(pool)], "level": 1})
    if structure == "focus":
        for card in deck:
            if card["cardId"] == "shell":
                card.update(level=2, atkBonus=2, hpBonus=2)
                break
    if structure == "delete":
        deck = _delete_extra_cards(deck, size)
    return deck


def _delete_extra_cards(deck, target):
    """优先删高费牌，并保持起手保底条件。"""
    def valid(cards):
        low = [
            card for card in cards
            if game.card_stats(game.CARDS, card["cardId"], card["level"])["cost"] <= 2
        ]
        low_units = [
            card for card in low
            if game.card_stats(game.CARDS, card["cardId"], card["level"])["type"] == "unit"
        ]
        return len(low) >= 4 and bool(low_units)

    remaining = list(deck)
    order = sorted(
        range(len(remaining)),
        key=lambda index: game.card_stats(
            game.CARDS, remaining[index]["cardId"], remaining[index]["level"]
        )["cost"],
        reverse=True,
    )
    for index in order:
        if len(remaining) <= target:
            break
        candidate = remaining[:index] + remaining[index + 1:]
        if valid(candidate):
            remaining = candidate
    return remaining


def card_stats(card):
    return game.card_stats(
        game.CARDS,
        card["cardId"],
        card["level"],
        card.get("atkBonus", 0),
        card.get("hpBonus", 0),
    )


def free_starts(b, width):
    return [
        start
        for start in range(1, battle.COLUMNS - width + 2)
        if all(b["board"]["player"][column - 1] is None for column in range(start, start + width))
    ]


def affordable_units(b, hand):
    return [
        card for card in hand
        if card_stats(card)["type"] == "unit" and card_stats(card)["cost"] <= b["energy"]
    ]


def use_commands(b, strategy):
    """用公开可见的双方场面选择指令目标；返回是否行动。"""
    hand = b["hand"]
    enemies = [unit for unit in b["board"]["enemy"] if unit is not None]
    players = [unit for unit in b["board"]["player"] if unit is not None]
    for card in list(hand):
        stats = card_stats(card)
        if stats.get("heal") is not None and stats["cost"] <= b["energy"]:
            damaged = [unit for unit in players if unit["hp"] < unit["maxHp"]]
            if damaged:
                target = max(damaged, key=lambda unit: unit["maxHp"] - unit["hp"])
                try:
                    battle.play_command(b, card["uid"], target["uid"])
                    return True
                except battle.GameError:
                    pass
        if stats.get("damage") is not None and stats["cost"] <= b["energy"] and enemies:
            if strategy == "defense":
                target = max(enemies, key=lambda unit: unit["atk"])
            else:
                target = min(enemies, key=lambda unit: (unit["hp"], -unit["atk"]))
            try:
                battle.play_command(b, card["uid"], target["uid"])
                return True
            except battle.GameError:
                pass
    return False


def deploy_one(b, strategy):
    units = affordable_units(b, b["hand"])
    if not units:
        return False

    def candidates(card):
        width = card_stats(card).get("width", 1)
        return free_starts(b, width)

    if strategy == "defense":
        threatened = {unit["column"] for unit in b["board"]["enemy"] if unit is not None}
        units.sort(key=lambda card: (card_stats(card)["cost"], -card_stats(card)["atk"]))
        for card in units:
            width = card_stats(card).get("width", 1)
            for start in candidates(card):
                if any(column in threatened for column in range(start, start + width)):
                    try:
                        battle.deploy(b, card["uid"], start)
                        return True
                    except battle.GameError:
                        pass
    else:
        units.sort(key=lambda card: (card_stats(card)["cost"], -card_stats(card)["atk"]))
    for card in units:
        starts = candidates(card)
        if starts:
            try:
                battle.deploy(b, card["uid"], starts[0])
                return True
            except battle.GameError:
                pass
    return False


def recycle_for_value(b, recycles):
    if recycles >= 2:
        return False
    units = [unit for unit in b["board"]["player"] if unit is not None]
    hand_units = [card for card in b["hand"] if card_stats(card)["type"] == "unit"]
    if not units or not hand_units:
        return False
    free = [start for start in range(1, battle.COLUMNS + 1) if b["board"]["player"][start - 1] is None]
    for card in sorted(hand_units, key=lambda item: (-card_stats(item)["atk"], card_stats(item)["cost"])):
        stats = card_stats(card)
        width = stats.get("width", 1)
        target_starts = [start for start in free if start + width - 1 <= battle.COLUMNS]
        if not target_starts:
            # 换掉一个较弱单位，腾出同宽或更窄的格子。
            weakest = min(units, key=lambda unit: (unit["atk"], unit["hp"]))
            if weakest["atk"] >= stats["atk"]:
                continue
            try:
                battle.recycle(b, weakest["column"])
            except battle.GameError:
                continue
            return True
        if stats["cost"] > b["energy"]:
            weakest = min(units, key=lambda unit: (unit["atk"], unit["hp"]))
            refund = battle.recycle_refund(weakest["paid"])
            if b["energy"] + refund >= stats["cost"] and stats["atk"] > weakest["atk"]:
                try:
                    battle.recycle(b, weakest["column"])
                    return True
                except battle.GameError:
                    pass
    return False


def discard_step(b):
    required = len(b["hand"]) - battle.MAX_HAND
    if required <= 0:
        return
    ordered = sorted(b["hand"], key=lambda card: card_stats(card)["cost"], reverse=True)
    battle.discard(b, [card["uid"] for card in ordered[:required]])


def play_battle(deck, encounter, rng_seed, strategy):
    enemies = game.ENEMIES
    cards = game.CARDS
    b = battle.make_battle(deck, encounter, cards, enemies, rng=random.Random(rng_seed))
    deployed = 0
    discards = 0
    max_columns = 0
    max_reserve = 0
    no_low_unit_turns = 0
    last_turn = 0
    recycles = 0
    actions = 0

    def unit_count():
        return len({unit["uid"] for unit in b["board"]["player"] if unit is not None})

    while b["phase"] != "over" and b["turn"] <= TURN_LIMIT:
        actions += 1
        if actions > 500:
            break
        if b["turn"] != last_turn:
            last_turn = b["turn"]
            low_units = [
                card for card in b["hand"]
                if card_stats(card)["type"] == "unit" and card_stats(card)["cost"] <= 2
            ]
            no_low_unit_turns += 0 if low_units else 1
            max_reserve = max(max_reserve, len(b["enemyReserve"]))
        if b["phase"] == "discard":
            try:
                discard_step(b)
            except battle.GameError:
                break
            discards += 1
            continue

        before = b["phase"], b["energy"], len(b["hand"])
        before_units = unit_count()
        acted = False
        if strategy == "defense":
            acted = use_commands(b, strategy) or deploy_one(b, strategy)
        else:
            acted = deploy_one(b, strategy)
            if not acted:
                acted = use_commands(b, strategy)
        if strategy == "recycle" and not acted:
            acted = recycle_for_value(b, recycles)
            if acted:
                recycles += 1
        if not acted:
            try:
                battle.end_turn(b, random.Random(rng_seed + b["turn"]))
            except battle.GameError:
                break
            max_reserve = max(max_reserve, len(b["enemyReserve"]))
            recycles = 0
            continue
        before_after = unit_count()
        if before_after > before_units:
            deployed += before_after - before_units
        occupied = set()
        for unit in b["board"]["player"]:
            if unit is not None:
                occupied.update(range(unit["column"], unit["column"] + unit.get("width", 1)))
        max_columns = max(max_columns, len(occupied))
        if (b["phase"], b["energy"], len(b["hand"])) == before:
            break

    occupied = set()
    for unit in b["board"]["player"]:
        if unit is not None:
            occupied.update(range(unit["column"], unit["column"] + unit.get("width", 1)))
    max_columns = max(max_columns, len(occupied))
    if b["phase"] != "over":
        result = "draw"
    else:
        result = b["result"]
    high_cost_left = sum(
        1 for card in b["hand"] + b["deck"] if card_stats(card)["cost"] >= 6
    )
    return {
        "result": result,
        "turns": b["turn"],
        "deployed": deployed,
        "max_columns": max_columns,
        "max_reserve": max_reserve,
        "leader_damage": encounter["playerHp"] - b["hp"]["player"],
        "discards": discards,
        "no_low_unit_turns": no_low_unit_turns,
        "high_cost_left": high_cost_left,
    }


def main(samples=SAMPLE_COUNT):
    rows = []
    pools = growth_pools()
    for chapter, chapter_index in (("map1", 0), ("map2", 1), ("map3", 2)):
        for category_index, category in enumerate(("normal", "elite", "boss")):
            encounters = category_encounters(chapter, category)
            for structure in STRUCTURES:
                deck = representative_deck(chapter, category, structure)
                for strategy in STRATEGIES:
                    results = []
                    for sample in range(samples):
                        seed = 1_000_000 + chapter_index * 100_000 + category_index * 10_000 + sample
                        encounter = game.ENCOUNTERS[encounters[seed % len(encounters)]]
                        results.append(play_battle(deck, encounter, seed, strategy))
                    wins = sum(1 for item in results if item["result"] == "win")
                    row = {
                        "chapter": chapter,
                        "category": category,
                        "structure": structure,
                        "strategy": strategy,
                        "samples": samples,
                        "deckSize": len(deck),
                        "winRate": round(wins / samples, 4),
                        "avgTurns": round(sum(item["turns"] for item in results) / samples, 2),
                        "avgDeployed": round(sum(item["deployed"] for item in results) / samples, 2),
                        "avgLeaderDamage": round(
                            sum(item["leader_damage"] for item in results) / samples, 2
                        ),
                        "avgDiscards": round(sum(item["discards"] for item in results) / samples, 2),
                        "avgReserve": round(sum(item["max_reserve"] for item in results) / samples, 2),
                        "noLowUnitTurns": round(
                            sum(item["no_low_unit_turns"] for item in results) / samples, 2
                        ),
                        "highCostLeft": round(
                            sum(item["high_cost_left"] for item in results) / samples, 2
                        ),
                        "draws": sum(1 for item in results if item["result"] == "draw"),
                    }
                    rows.append(row)

    print("balance samples:", samples, "per chapter/category/strategy/structure")
    print("note: simulations use the real battle engine; human difficulty is NOT verified.")
    print()
    print("| chapter | category | structure | strategy | deck | win | turns | deploy | damage | reserve |")
    print("|---|---|---|---|---:|---:|---:|---:|---:|---:|")
    for row in rows:
        print(
            f"| {row['chapter']} | {row['category']} | {row['structure']} | {row['strategy']} | "
            f"{row['deckSize']} | {row['winRate'] * 100:.1f}% | {row['avgTurns']:.1f} | "
            f"{row['avgDeployed']:.1f} | {row['avgLeaderDamage']:.1f} | {row['avgReserve']:.1f} |"
        )

    failures = defaultdict(lambda: Counter())
    for row in rows:
        if row["winRate"] < 0.35 and row["category"] == "normal":
            failures[(row["chapter"], row["strategy"])][row["structure"]] += 1
    print()
    print("normal battles under 35% win:", dict(failures) or "none")
    print()
    print(json.dumps(rows, ensure_ascii=False, default=dict))


if __name__ == "__main__":
    main(int(sys.argv[1]) if len(sys.argv) > 1 else SAMPLE_COUNT)
