#!/usr/bin/env python3
"""Put a review report into the reports branch, where the board looks for it.

Creates the branch as an orphan (reports only, no code) the first time. Uses the gh
CLI, so it acts as the logged-in user. Updating an existing report replaces it; the
branch history keeps the old versions.

usage: publish_report.py <report.md> --repo <owner/repo> [--branch ai-reviews] [--dir reviews]
Prints the URL of the file on GitHub."""
import argparse
import base64
import json
import os
import re
import subprocess
import sys


def gh_api(path, method="GET", body=None, allow_missing=False):
    args = ["gh", "api", "-X", method, path]
    if body is not None:
        args += ["--input", "-"]
    result = subprocess.run(args, input=json.dumps(body) if body is not None else None, capture_output=True, text=True)
    if result.returncode != 0:
        if allow_missing and "HTTP 404" in result.stderr:
            return None
        sys.exit(f"gh api {method} {path} failed: {result.stderr.strip()}")
    return json.loads(result.stdout) if result.stdout.strip() else None


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("report")
    parser.add_argument("--repo", required=True)
    parser.add_argument("--branch", default="ai-reviews")
    parser.add_argument("--dir", default="reviews")
    args = parser.parse_args()
    if not re.fullmatch(r"[\w.-]+/[\w.-]+", args.repo):
        sys.exit("repo must look like owner/name")
    if not re.fullmatch(r"[\w./-]+", args.branch) or not re.fullmatch(r"[\w./-]*", args.dir):
        sys.exit("branch and dir may only contain letters, digits, '.', '_', '-' and '/'")

    name = os.path.basename(args.report)
    with open(args.report, "rb") as fh:
        content = fh.read()
    path = f"{args.dir.strip('/')}/{name}" if args.dir.strip("/") else name
    message = f"Review report {name}"

    if gh_api(f"repos/{args.repo}/branches/{args.branch}", allow_missing=True) is None:
        # First report: an orphan branch holding only reports.
        blob = gh_api(f"repos/{args.repo}/git/blobs", "POST", {"content": base64.b64encode(content).decode(), "encoding": "base64"})
        tree = gh_api(f"repos/{args.repo}/git/trees", "POST", {"tree": [{"path": path, "mode": "100644", "type": "blob", "sha": blob["sha"]}]})
        commit = gh_api(f"repos/{args.repo}/git/commits", "POST", {"message": message, "tree": tree["sha"], "parents": []})
        gh_api(f"repos/{args.repo}/git/refs", "POST", {"ref": f"refs/heads/{args.branch}", "sha": commit["sha"]})
    else:
        existing = gh_api(f"repos/{args.repo}/contents/{path}?ref={args.branch}", allow_missing=True)
        body = {"message": message, "content": base64.b64encode(content).decode(), "branch": args.branch}
        if existing:
            body["sha"] = existing["sha"]
        gh_api(f"repos/{args.repo}/contents/{path}", "PUT", body)

    print(f"https://github.com/{args.repo}/blob/{args.branch}/{path}")


if __name__ == "__main__":
    main()
