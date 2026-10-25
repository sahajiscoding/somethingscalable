import json
import os

p = "results.sarif"
if os.path.exists(p):
    with open(p, "r", encoding="utf-8") as f:
        data = json.load(f)
else:
    data = {"version": "2.1.0", "runs": []}

retired = [
    "Pylint (reported by Codacy)",
    "Pylintpython3 (reported by Codacy)",
    "Prospector (reported by Codacy)",
    "Csslint (reported by Codacy)",
    "Stylelint (reported by Codacy)",
]

present = {r.get("tool", {}).get("driver", {}).get("name") for r in data.get("runs", [])}
for name in retired:
    if name not in present:
        data.setdefault("runs", []).append({
            "tool": {"driver": {"name": name, "version": "1.0"}},
            "results": []
        })

with open(p, "w", encoding="utf-8") as f:
    json.dump(data, f, indent=2)

print(f"Reconciled {p} with {len(data.get('runs', []))} tool runs.")
