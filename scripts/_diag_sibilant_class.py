"""
Diagnostic: dump per-event sibilant-class measurements from a sibilance
events JSON, sorted by hfRatioDb.

Reads:
    <events_json>    (output of analyze_sibilance_events.py with the
                      hfRatioDb / sibilantClass fields populated)

Writes CSV-style rows to stdout:
    idx, t_start, t_end, durMs, eventType, sibilantClass, hfRatioDb, eventPeakDb

Used to validate STRIDENT_CLASSIFICATION_THRESHOLD_DB against real audio.
"""
import json
import sys


def main(events_json_path):
    with open(events_json_path) as fh:
        data = json.load(fh)

    evs = [e for e in data.get("events", []) if "hfRatioDb" in e]
    evs.sort(key=lambda e: e["hfRatioDb"])

    print("idx,t_start,t_end,durMs,eventType,sibilantClass,hfRatioDb,eventPeakDb")
    for i, e in enumerate(evs):
        print(
            f"{i:3d},"
            f"{e['startSec']:7.3f},"
            f"{e['endSec']:7.3f},"
            f"{e['durationMs']:6.1f},"
            f"{e['eventType']:10s},"
            f"{e['sibilantClass']:12s},"
            f"{e['hfRatioDb']:+7.2f},"
            f"{e['eventPeakDb']:+7.2f}"
        )

    # Distribution summary
    strident_count     = sum(1 for e in evs if e["sibilantClass"] == "strident")
    non_strident_count = sum(1 for e in evs if e["sibilantClass"] == "non_strident")
    if evs:
        hf_min = min(e["hfRatioDb"] for e in evs)
        hf_max = max(e["hfRatioDb"] for e in evs)
        print(
            f"\n# total={len(evs)} strident={strident_count} "
            f"non_strident={non_strident_count} "
            f"hfRatioDb range=[{hf_min:+.2f}, {hf_max:+.2f}]"
        )


if __name__ == "__main__":
    main(sys.argv[1])
