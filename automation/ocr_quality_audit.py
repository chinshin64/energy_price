#!/usr/bin/env python3
"""Audit mobile OCR station rows for obvious false positives."""

from __future__ import annotations

import argparse
import sqlite3
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
DB_PATH = ROOT / "data" / "stations.db"
DEFAULT_CITIES = ["上海", "武汉", "北京", "青岛", "深圳", "西安"]
NOISE_TOKENS = [
    "可用券",
    "余额",
    "余額",
    "筛选",
    "地图",
    "首页",
    "我的",
    "停车减免",
    "超时占用",
    "优惠",
    "分钟",
    "公里",
    "即插即充",
    "即播即充",
    "可用充电",
    "余领",
    "余颌",
    "免费领租车",
    "去收下",
    "聊天记录",
    "网络结果",
    "场站已暂停服务",
    "到底了",
    "￥",
    "¥",
]
CITY_MISMATCH_TOKENS = {
    "杭州": [
        "杭州",
        "抗州",
        "余杭",
        "拱墅",
        "萧山",
        "钱塘",
        "临平",
        "浙江",
        "西湖电子商务",
        "西湖印象",
        "西湖福地",
        "西湖贝尔",
        "西湖丰汇",
    ],
    # 只保留高置信跨城污染词。不要放“朝阳/嘉定/南山/龙华”等泛地名，
    # 这些在其他城市也可能是合法道路、商圈或项目名。
    "北京": ["北京市", "北京朝阳", "北京海淀", "北京丰台", "北京通州", "北京昌平", "北京大兴"],
    "上海": ["上海市", "上海浦东", "上海徐汇", "上海静安", "上海虹口", "上海杨浦", "上海闵行"],
    "武汉": ["武汉市", "武汉武昌", "武汉汉口", "武汉汉阳", "武汉江岸", "武汉洪山"],
    "青岛": ["青岛市", "責岛市", "青岛市北", "青岛市南", "青岛李沧", "青岛崂山"],
    "深圳": ["深圳市", "深圳福田", "深圳南山", "深圳宝安", "深圳龙岗", "深圳罗湖", "深圳龙华"],
    "西安": ["西安市", "西安未央", "西安雁塔", "西安莲湖", "西安碑林", "西安曲江"],
}


def placeholders(values: list[str]) -> str:
    return ",".join("?" for _ in values)


def find_city_mismatches(rows: list[sqlite3.Row]) -> list[dict[str, object]]:
    mismatches: list[dict[str, object]] = []
    for row in rows:
        city = row["city"] or ""
        haystack = f"{row['station_name'] or ''} {row['address'] or ''}"
        matched: list[str] = []
        for token_city, tokens in CITY_MISMATCH_TOKENS.items():
            if token_city == city:
                continue
            for token in tokens:
                if token and token in haystack:
                    matched.append(f"{token_city}:{token}")
        if matched:
            mismatches.append(
                {
                    "id": row["id"],
                    "city": city,
                    "station_name": row["station_name"],
                    "address": row["address"],
                    "matched_tokens": ",".join(matched[:8]),
                    "collected_at": row["collected_at"],
                }
            )
    return mismatches


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--db", default=str(DB_PATH))
    parser.add_argument("--cities", nargs="+", default=DEFAULT_CITIES)
    parser.add_argument("--sample-limit", type=int, default=30)
    args = parser.parse_args()

    db_path = Path(args.db)
    if not db_path.exists():
        raise SystemExit(f"database not found: {db_path}")

    city_sql = placeholders(args.cities)
    noise_sql = " OR ".join("station_name LIKE ?" for _ in NOISE_TOKENS)
    params = args.cities
    noise_params = [f"%{token}%" for token in NOISE_TOKENS]

    with sqlite3.connect(db_path) as conn:
        conn.row_factory = sqlite3.Row
        print("== city summary ==")
        for row in conn.execute(
            f"""
            SELECT json_extract(raw_data,'$.mobileSync.meta.city') city,
                   COUNT(*) total_snapshots,
                   COUNT(DISTINCT station_name) distinct_names,
                   COUNT(NULLIF(address,'')) with_address,
                   COUNT(price_fast) + COUNT(price_slow) + COUNT(price_super) price_fields,
                   MAX(COALESCE(snapshot_at, collected_at)) latest_snapshot
            FROM stations
            WHERE platform='didi-charging'
              AND source_type='mobile-ocr'
              AND json_extract(raw_data,'$.mobileSync.meta.city') IN ({city_sql})
            GROUP BY city
            ORDER BY city
            """,
            params,
        ):
            print(dict(row))

        print("\n== suspicious counts ==")
        suspicious_where = f"""
            json_extract(raw_data,'$.mobileSync.meta.city') IN ({city_sql})
            AND (
                station_name IS NULL
                OR TRIM(station_name) = ''
                OR LENGTH(station_name) < 4
                OR (station_name NOT LIKE '%充%' AND station_name NOT LIKE '%站%' AND station_name NOT LIKE '%桩%' AND station_name NOT LIKE '%换电%')
                OR {noise_sql}
                OR COALESCE(price_fast, price_slow, price_super) < 0.2
                OR COALESCE(price_fast, price_slow, price_super) > 3.5
                OR total_ports < 0
                OR available_ports < 0
                OR available_ports > total_ports
            )
        """
        row = conn.execute(
            f"""
            SELECT COUNT(*) suspicious_rows,
                   COUNT(DISTINCT station_name) suspicious_distinct
            FROM stations
            WHERE platform='didi-charging'
              AND source_type='mobile-ocr'
              AND {suspicious_where}
            """,
            params + noise_params,
        ).fetchone()
        print(dict(row))

        print("\n== suspicious samples ==")
        rows = conn.execute(
            f"""
            SELECT id,
                   json_extract(raw_data,'$.mobileSync.meta.city') city,
                   station_name,
                   price_fast,
                   price_slow,
                   price_super,
                   available_ports,
                   total_ports,
                   collected_at
            FROM stations
            WHERE platform='didi-charging'
              AND source_type='mobile-ocr'
              AND {suspicious_where}
            ORDER BY id DESC
            LIMIT ?
            """,
            params + noise_params + [args.sample_limit],
        ).fetchall()
        if not rows:
            print("none")
        for row in rows:
            print(dict(row))

        print("\n== field completeness ==")
        for row in conn.execute(
            f"""
            SELECT json_extract(raw_data,'$.mobileSync.meta.city') city,
                   SUM(CASE WHEN COALESCE(total_ports, 0) = 0 THEN 1 ELSE 0 END) zero_total_ports,
                   SUM(CASE WHEN price_fast IS NULL AND price_slow IS NULL AND price_super IS NULL THEN 1 ELSE 0 END) missing_price,
                   SUM(CASE WHEN address IS NULL OR TRIM(address) = '' THEN 1 ELSE 0 END) missing_address
            FROM stations
            WHERE platform='didi-charging'
              AND source_type='mobile-ocr'
              AND json_extract(raw_data,'$.mobileSync.meta.city') IN ({city_sql})
            GROUP BY city
            ORDER BY city
            """,
            params,
        ):
            print(dict(row))

        all_rows = conn.execute(
            f"""
            SELECT id,
                   json_extract(raw_data,'$.mobileSync.meta.city') city,
                   station_name,
                   address,
                   collected_at
            FROM stations
            WHERE platform='didi-charging'
              AND source_type='mobile-ocr'
              AND json_extract(raw_data,'$.mobileSync.meta.city') IN ({city_sql})
            ORDER BY id DESC
            """,
            params,
        ).fetchall()
        mismatches = find_city_mismatches(all_rows)
        print("\n== city mismatch risks ==")
        print(
            {
                "mismatch_rows": len(mismatches),
                "mismatch_distinct": len({row["station_name"] for row in mismatches}),
            }
        )
        print("\n== city mismatch samples ==")
        if not mismatches:
            print("none")
        for row in mismatches[: args.sample_limit]:
            print(row)

        print("\n== random samples ==")
        for row in conn.execute(
            f"""
            SELECT id,
                   json_extract(raw_data,'$.mobileSync.meta.city') city,
                   station_name,
                   address,
                   price_fast,
                   price_slow,
                   price_super,
                   available_ports,
                   total_ports,
                   collected_at
            FROM stations
            WHERE platform='didi-charging'
              AND source_type='mobile-ocr'
              AND json_extract(raw_data,'$.mobileSync.meta.city') IN ({city_sql})
            ORDER BY RANDOM()
            LIMIT ?
            """,
            params + [args.sample_limit],
        ):
            print(dict(row))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
