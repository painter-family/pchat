#!/usr/bin/env python3
"""Export user-visible Codex messages for this repository; supports notify and watch."""
import argparse
import datetime
import json
import os
from pathlib import Path
import re
import subprocess
import sys
import time

PROJECT = Path(__file__).resolve().parent.parent
OUTPUT = PROJECT / "docs" / "codex"


def normalized(path):
    value = str(path).replace("\\", "/").rstrip("/")
    match = re.match(r"^([A-Za-z]):/(.*)$", value)
    if match:
        value = "/mnt/" + match[1].lower() + "/" + match[2]
    return value.casefold()


def in_project(cwd):
    root = normalized(PROJECT)
    candidate = normalized(cwd)
    return candidate == root or candidate.startswith(root + "/")


def roots(extra):
    result = [Path(os.environ.get("CODEX_HOME", str(Path.home() / ".codex"))) / "sessions"]
    if os.name != "nt":
        windows_home = Path("/mnt/c/Users/ppain/.codex/sessions")
        if windows_home.exists():
            result.append(windows_home)
    result.extend(Path(value) for value in extra)
    return list(dict.fromkeys(result))


def metadata(source):
    try:
        with source.open(encoding="utf-8") as stream:
            first = json.loads(next(stream))
        if first.get("type") == "session_meta":
            return first.get("payload", {})
    except (OSError, ValueError, StopIteration):
        pass
    return {}


def visible_user_text(text):
    stripped = text.strip()
    if stripped.startswith(("<environment_context>", "<external_codex_apps_open_page>", "# AGENTS.md instructions")):
        return None
    if stripped.startswith("<send_user_message_question_reply>"):
        try:
            replies = json.loads(stripped.split(">", 1)[1].rsplit("<", 1)[0].strip())
            return "\n\n".join("Question: " + item["question"] + "\nAnswer: " + item["answer"] for item in replies)
        except (ValueError, KeyError, TypeError):
            return stripped
    return text.rstrip()


def messages(source):
    result = []
    with source.open(encoding="utf-8") as stream:
        for line in stream:
            try:
                record = json.loads(line)
            except ValueError:
                continue  # A live rollout may have an unfinished final line.
            item = record.get("payload", {})
            if record.get("type") != "response_item" or item.get("type") != "message":
                continue
            role = item.get("role")
            if role not in ("user", "assistant"):
                continue
            phase = item.get("phase") or item.get("channel")
            if role == "assistant" and phase not in (None, "commentary", "final_answer", "final"):
                continue
            text = "\n".join(part.get("text", "") for part in item.get("content", [])
                             if part.get("type") in ("input_text", "output_text", "text"))
            if role == "user":
                text = visible_user_text(text)
            if not text or not text.strip():
                continue
            result.append({"timestamp": record.get("timestamp", ""), "role": role,
                           "phase": phase, "text": text.rstrip()})
    return result


def atomic_write(destination, content):
    destination.parent.mkdir(parents=True, exist_ok=True)
    if destination.exists() and destination.read_text(encoding="utf-8") == content:
        return
    temporary = destination.with_name(destination.name + "." + str(os.getpid()) + ".tmp")
    try:
        temporary.write_text(content, encoding="utf-8")
        os.replace(str(temporary), str(destination))
    finally:
        if temporary.exists():
            temporary.unlink()


def export(source):
    info = metadata(source)
    if not in_project(info.get("cwd", "")):
        return None
    session_id = info.get("id", "")
    if not re.fullmatch(r"[\w-]+", session_id):
        return None
    conversation = messages(source)
    if not conversation:
        return None
    date = str(info.get("timestamp") or conversation[0]["timestamp"])[:10]
    filename = date + "-" + session_id
    heading = "# pchat Codex transcript\n\nSession: `" + session_id + "`\n\n"
    heading += "User messages, assistant replies, and progress updates. Internal prompts, reasoning, and tool traces are excluded.\n\n"
    sections = [heading]
    for message in conversation:
        label = "User" if message["role"] == "user" else "Codex"
        if message["phase"] == "commentary":
            label += " (progress)"
        sections.append("## " + label + " — " + message["timestamp"] + "\n\n" + message["text"] + "\n\n")
    atomic_write(OUTPUT / (filename + ".md"), "".join(sections))
    atomic_write(OUTPUT / (filename + ".json"), json.dumps({"session_id": session_id, "messages": conversation}, ensure_ascii=False, indent=2) + "\n")
    index = "# Codex transcripts\n\nSaved conversations for this repository. Exports update after completed turns.\n\n"
    for file in sorted(OUTPUT.glob("*.md")):
        if file.name != "index.md":
            index += "- [" + file.stem + "](" + file.name + ")\n"
    atomic_write(OUTPUT / "index.md", index)
    return OUTPUT / (filename + ".md")


def find_sources(search_roots, session_id=None):
    if session_id and not re.fullmatch(r"[\w-]+", session_id):
        raise ValueError("Invalid Codex session identifier")
    pattern = "*" + session_id + "*.jsonl" if session_id else "rollout-*.jsonl"
    for root in search_roots:
        if root.exists():
            for source in root.rglob(pattern):
                if in_project(metadata(source).get("cwd", "")):
                    yield source


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("payload", nargs="?")
    parser.add_argument("--notify", action="store_true")
    parser.add_argument("--notify-chain", type=Path)
    parser.add_argument("--session-id")
    parser.add_argument("--sessions-dir", action="append", default=[])
    parser.add_argument("--all", action="store_true")
    parser.add_argument("--watch", action="store_true")
    parser.add_argument("--idle-timeout", type=int, default=21600)
    args = parser.parse_args()
    search_roots = roots(args.sessions_dir)
    notify = args.notify or args.notify_chain is not None
    if notify:
        notification = json.loads(args.payload or "{}")
        try:
            if notification.get("type") == "agent-turn-complete" and in_project(notification.get("cwd", "")):
                session_id = notification.get("thread-id")
                if session_id:
                    # Notification and rollout writes may reach disk at slightly different times.
                    for delay in (0, 0.5, 1):
                        if delay:
                            time.sleep(delay)
                        for source in find_sources(search_roots, session_id):
                            export(source)
        finally:
            if args.notify_chain:
                previous = json.loads(args.notify_chain.read_text(encoding="utf-8"))
                subprocess.run(previous + [args.payload or "{}"], check=False)
        return
    session_id = args.session_id or (None if args.all else os.environ.get("CODEX_THREAD_ID") or os.environ.get("CODEX_SESSION_ID"))
    if not session_id and not args.all:
        parser.error("Specify --all or --session-id, or run inside a Codex session.")
    if not args.watch:
        for source in find_sources(search_roots, session_id):
            destination = export(source)
            if destination:
                print(destination)
        return
    seen = {}
    last_change = time.monotonic()
    while time.monotonic() - last_change < args.idle_timeout:
        for source in find_sources(search_roots, session_id):
            try:
                stamp = (source.stat().st_mtime_ns, source.stat().st_size)
                if seen.get(source) != stamp:
                    export(source)
                    seen[source] = stamp
                    last_change = time.monotonic()
            except OSError as error:
                print("Transcript export failed: " + str(error), file=sys.stderr)
        time.sleep(3)


if __name__ == "__main__":
    main()
