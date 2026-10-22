"""Spotify playlist embed page (stdin) -> tracks.json (stdout): playlist name and each track's "artist - title" and length.

    curl -s https://open.spotify.com/embed/playlist/0TuQrG6ttGKuI6cAWvabNj | python3 scripts/tracks.py > tracks.json
"""
import json
import re
import sys

data = re.search(r'<script id="__NEXT_DATA__" type="application/json">(.*?)</script>', sys.stdin.read()).group(1)
entity = json.loads(data)["props"]["pageProps"]["state"]["data"]["entity"]
json.dump({
    "name": entity["name"],
    # The iframe API reports only the playing track's length, so the site names tracks by matching it.
    "tracks": [{"name": f'{t["subtitle"]} - {t["title"]}', "ms": t["duration"]} for t in entity["trackList"]],
}, sys.stdout, ensure_ascii=False, indent=1)
sys.stdout.write("\n")
