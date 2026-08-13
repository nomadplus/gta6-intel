import sys
import re
import urllib.request

url = sys.argv[1]
html = urllib.request.urlopen(url).read().decode("utf-8", errors="replace")
forms = re.findall(r"<form.*?</form>", html, re.S)
for i, f in enumerate(forms):
    action_id = re.search(r"\$ACTION_ID_[A-Za-z0-9]+", f)
    names = re.findall(r'name="([^"]+)"', f)
    print(f"{i}\t{action_id.group() if action_id else ''}\t{','.join(names)}")
