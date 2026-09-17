#!/usr/bin/env bash
# Transcode a device screen recording to H.264, attach it to the Tie Dyer
# App Review detail, and update review-notes item 1 to say it is attached.
#   ios/appstore/attach-recording.sh ~/Downloads/RPReplay_Final....mov [version]
set -euo pipefail
SRC=${1:?usage: attach-recording.sh <recording.mov|mp4> [version]}
VERSION=${2:-}   # default: newest App Store version (the rejected one)
BUNDLE=com.dnuke.tiedyer
V=${ASC_PYTHON:-$HOME/sandbox/dnewcome/sagebaker/.venv/bin/python}
T=$HOME/.claude/skills/app-store-release/tools
HERE=$(cd "$(dirname "$0")" && pwd)
OUT=${TMPDIR:-/tmp}/tiedyer-review${VERSION:+-$VERSION}.mp4

echo "transcoding $SRC -> $OUT (H.264, 30 fps, <=1366p)"
ffmpeg -y -loglevel error -i "$SRC" -vf "scale='min(1366,iw)':-2:flags=lanczos,fps=30" \
  -c:v libx264 -preset slow -crf 23 -pix_fmt yuv420p -movflags +faststart -an "$OUT"
ls -l "$OUT"

echo "attaching to $BUNDLE ${VERSION:-(newest version)}"
"$V" "$T/asc_review_attachment.py" --bundle-id "$BUNDLE" ${VERSION:+--version "$VERSION"} --replace --file "$OUT"

echo "updating review notes item 1"
NOTES="$HERE/metadata/review_notes.txt"
python3 - "$NOTES" <<'PY'
import re, sys
p = sys.argv[1]; s = open(p).read()
new = ("1. Screen recording: attached to these review notes (App Review Attachments), captured on a physical "
       "device running the current iOS, starting from the Home Screen and app launch. It shows the typical flow "
       "described in item 3: loading the demos, dyeing the folded bundle, the 3D view, adding a rubber band, and "
       "exporting through the share sheet. The app has no account registration, login, account deletion, "
       "user-generated content that is shared or published, paid content, subscription, or in-app purchase, "
       "so none of those flows exist to record.")
s2 = re.sub(r"1\. Screen recording:.*?(?=\n\n2\. )", new, s, count=1, flags=re.S)
open(p, "w").write(s2); print("  notes file updated" if s2 != s else "  notes file already current")
PY
"$V" - "$BUNDLE" "$VERSION" "$NOTES" <<'PY'
import sys; sys.path.insert(0, __import__('os').path.expanduser('~/.claude/skills/app-store-release/tools'))
from asc_listing import Client, attrs
bundle, version, notes_path = sys.argv[1:]
c = Client(dry=False)
app = c.get("/apps", **{"filter[bundleId]": bundle})["data"][0]["id"]
vers = c.get(f"/apps/{app}/appStoreVersions", limit=10)["data"]
v = [x for x in vers if not version or x["attributes"]["versionString"] == version][0]
print(f"  version {v['attributes']['versionString']} ({v['attributes'].get('appVersionState')})")
d = c.get(f"/appStoreVersions/{v['id']}/appStoreReviewDetail")["data"]
notes = open(notes_path).read().strip()
assert len(notes) <= 4000, len(notes)
c.write("PATCH", f"/appStoreReviewDetails/{d['id']}", attrs("appStoreReviewDetails", d["id"], {"notes": notes}))
print(f"  review notes updated in App Store Connect ({len(notes)} chars)")
PY
echo "done. Now: Resolution Center -> Reply (ios/appstore/review/2.1-response.md section 4) -> Resubmit."
