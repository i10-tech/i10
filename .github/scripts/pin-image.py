"""Rewrite every reference to one image under infra/k8s to a pinned ref.

Usage: pin-image.py <registry>/<namespace>/<image> <full pinned ref>

Called by the Build workflow's pin step and again by push-deploy.sh when it
re-pins on top of a newer main (#210), so both use one definition.

REPLACE THE WHOLE REFERENCE, INCLUDING ANY EXISTING `@sha256:`. The manifests
start life pinned to `:prod-latest` and end up pinned to
`:prod-<sha>@sha256:<digest>`; a pattern that only matched the tag would append
a second digest to an already-pinned line and produce a reference Kubernetes
rejects at pull time, not at apply time.

IT SCANS EVERY MANIFEST RATHER THAN A MAPPED FILE PER IMAGE. `i10-api` runs
both the API and the worker, and a per-image file mapping once left the second
file on a stale digest with nothing to notice.
"""

import pathlib
import re
import sys

repo, ref = sys.argv[1], sys.argv[2]
# A repo name is a prefix of no other repo name here, so anchoring on
# `<registry>/<ns>/<image>:` is unambiguous.
pattern = re.compile(rf"{re.escape(repo)}:\S+")
total = 0
for path in sorted(pathlib.Path("infra/k8s").rglob("*.yaml")):
    src = path.read_text()
    out, n = pattern.subn(ref, src)
    if n:
        path.write_text(out)
        total += n
        print(f"  {path}: {n} reference(s)")
if total == 0:
    sys.exit(f"no reference to {repo} under infra/k8s - is the image still deployed?")
print(f"  -> {ref}")
