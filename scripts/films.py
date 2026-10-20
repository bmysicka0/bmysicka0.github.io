"""Letterboxd RSS (stdin) -> films.json (stdout): latest unique films, newest first, with small posters.

    curl -s https://letterboxd.com/brand0m/rss/ | python3 scripts/films.py > films.json
"""
import json
import re
import sys
import xml.etree.ElementTree as ET

LB = "{https://letterboxd.com}"
MAX = 40

films, seen = [], set()
for item in ET.parse(sys.stdin).getroot().iter("item"):
    title = item.findtext(LB + "filmTitle")
    if not title:  # lists and other non-diary items
        continue
    year = item.findtext(LB + "filmYear") or ""
    if (title, year) in seen:
        continue
    seen.add((title, year))
    poster = re.search(r'<img src="([^"]+)"', item.findtext("description") or "")
    rating = item.findtext(LB + "memberRating")
    stars = ""
    if rating:
        r = float(rating)
        stars = "★" * int(r) + ("½" if r % 1 else "")
    films.append({
        "title": title,
        "year": year,
        "stars": stars,
        "link": item.findtext("link"),
        # 150x225 rendition instead of the feed's 600x900
        "poster": poster and poster.group(1).replace("-0-600-0-900-crop", "-0-150-0-225-crop"),
    })
    if len(films) == MAX:
        break

json.dump(films, sys.stdout, ensure_ascii=False, indent=1)
sys.stdout.write("\n")
