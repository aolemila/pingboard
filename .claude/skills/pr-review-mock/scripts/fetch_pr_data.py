#!/usr/bin/env python3
"""Fetch everything the review needs for one PR in one go: metadata, the full diff,
discussion, reviews and CI status. Uses the gh CLI, so it acts as the logged-in user.

usage: fetch_pr_data.py <owner/repo> <number> [--out DIR]
Writes DIR/<owner>_<repo>-pr-<number>.json (default DIR: outputs/pr-data) and prints the path."""
import argparse
import json
import os
import re
import subprocess
import sys

FIELDS = ",".join([
    "number", "title", "body", "url", "author", "state", "isDraft",
    "baseRefName", "headRefName", "headRefOid",
    "additions", "deletions", "changedFiles", "files", "labels",
    "comments", "reviews", "statusCheckRollup", "mergeable",
])


def gh(*args):
    result = subprocess.run(["gh", *args], capture_output=True, text=True)
    if result.returncode != 0:
        sys.exit(f"gh {' '.join(args[:3])}… failed: {result.stderr.strip()}")
    return result.stdout


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("repo")
    parser.add_argument("number", type=int)
    parser.add_argument("--out", default="outputs/pr-data")
    args = parser.parse_args()
    if not re.fullmatch(r"[\w.-]+/[\w.-]+", args.repo):
        sys.exit("repo must look like owner/name")

    data = json.loads(gh("pr", "view", str(args.number), "--repo", args.repo, "--json", FIELDS))
    data["repo"] = args.repo
    data["diff"] = gh("pr", "diff", str(args.number), "--repo", args.repo)

    os.makedirs(args.out, exist_ok=True)
    path = os.path.join(args.out, f"{args.repo.replace('/', '_')}-pr-{args.number}.json")
    with open(path, "w", encoding="utf-8") as fh:
        json.dump(data, fh, ensure_ascii=False, indent=2)
    print(path)


if __name__ == "__main__":
    main()
