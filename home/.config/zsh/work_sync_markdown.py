import argparse
import os
from pathlib import Path
import shlex
import signal
import subprocess
import sys
import tempfile
import time
from urllib.parse import unquote, urlsplit


FIND = r"find . \( -name .DS_Store -o -name '*.jsonl' -o -name .obsidian -o -name node_modules -o -name 'fsmonitor--daemon*' \) -prune -o \( -type f -o -type l \) -name '*.md' -print0"
active = None


def stop(signum, frame):
    if active is not None and active.poll() is None:
        try:
            os.killpg(active.pid, signum)
        except ProcessLookupError:
            pass
    raise SystemExit(128 + signum)


def run(command, cwd=None, capture=False):
    global active
    active = subprocess.Popen(command, cwd=cwd, start_new_session=True,
                              stdout=subprocess.PIPE if capture else None)
    try:
        output, _ = active.communicate()
        return active.returncode, output
    finally:
        if active.poll() is None:
            try:
                active.wait(timeout=5)
            except subprocess.TimeoutExpired:
                os.killpg(active.pid, signal.SIGKILL)
                active.wait()
        active = None


def markdown_paths(root, sshargs):
    if root.startswith("ssh://"):
        remote = urlsplit(root)
        command = "cd " + shlex.quote(unquote(remote.path[1:])) + " && " + FIND
        code, output = run(["ssh", *shlex.split(sshargs), remote.netloc, command], capture=True)
    else:
        code, output = run(["sh", "-c", FIND], cwd=root, capture=True)
    if code:
        raise RuntimeError(f"Could not list Markdown files in {root} (exit {code})")
    return {os.fsdecode(path[2:]) for path in output.split(b"\0") if path}


def archive_directory():
    if os.environ.get("UNISON"):
        return Path(os.environ["UNISON"])
    directory = Path.home() / ".unison"
    if sys.platform == "darwin" and not directory.exists():
        directory = Path.home() / "Library/Application Support/Unison"
    return directory


def sync(args):
    local_paths = markdown_paths(args.roots[0], args.sshargs)
    remote_paths = markdown_paths(args.roots[1], args.sshargs)
    paths = sorted(local_paths | remote_paths)
    if not paths:
        return 0
    directory = archive_directory()
    directory.mkdir(parents=True, exist_ok=True)
    with tempfile.NamedTemporaryFile(mode="w", prefix="markdown-", suffix=".prf",
                                     dir=directory) as profile:
        for path in paths:
            if "\n" in path or "\r" in path or path != path.strip():
                raise ValueError(f"Cannot represent Markdown path in a Unison profile: {path!r}")
            profile.write(f"path = {path}\n")
        profile.flush()
        deletion_args = ["-confirmbigdel=false"] if local_paths and remote_paths else []
        code, _ = run(["unison", *args.roots, "-source", Path(profile.name).name,
                       "-sshargs", args.sshargs, *args.unison_args,
                       *deletion_args])
        return code


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--repeat", type=float)
    parser.add_argument("--pidfile", type=Path)
    parser.add_argument("--sshargs", default="")
    parser.add_argument("roots", nargs=2)
    parser.add_argument("unison_args", nargs=argparse.REMAINDER)
    args = parser.parse_args()
    if args.repeat is not None and args.repeat <= 0:
        parser.error("--repeat must be positive")
    for signum in (signal.SIGTERM, signal.SIGINT, signal.SIGHUP):
        signal.signal(signum, stop)
    finish = Path(f"{args.pidfile}.{os.getpid()}.finish") if args.pidfile else None
    try:
        while True:
            final_pass = finish is not None and finish.exists()
            try:
                code = sync(args)
            except (OSError, RuntimeError, ValueError) as error:
                print(f"devbox Markdown sync failed: {error}", file=sys.stderr)
                code = 3
            if args.repeat is None or final_pass:
                return code
            deadline = time.monotonic() + args.repeat
            while time.monotonic() < deadline:
                if finish is not None and finish.exists():
                    break
                time.sleep(min(0.1, max(0, deadline - time.monotonic())))
    finally:
        if finish is not None:
            finish.unlink(missing_ok=True)
            try:
                if args.pidfile.read_text().strip() == str(os.getpid()):
                    args.pidfile.unlink()
            except FileNotFoundError:
                pass


if __name__ == "__main__":
    sys.exit(main())