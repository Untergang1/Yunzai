"""Supervise a read-only probe and restore a standalone `node app.js` process.

Linux, Python standard library only. No Docker/service-manager mutations.
"""
import argparse
import datetime
import json
import os
from pathlib import Path
import signal
import socket
import subprocess
import time
import urllib.request

ROOT = Path(__file__).resolve().parents[1]


def now():
    return datetime.datetime.now(datetime.timezone.utc).isoformat()


def listening(port):
    try:
        with socket.create_connection(("127.0.0.1", port), timeout=1):
            return True
    except OSError:
        return False


def wait_for(check, seconds):
    deadline = time.monotonic() + seconds
    while time.monotonic() < deadline:
        if check():
            return True
        time.sleep(0.25)
    return False


def process_stamp(pid):
    try:
        return Path(f"/proc/{pid}/stat").read_text().rsplit(")", 1)[1].split()[19]
    except FileNotFoundError:
        return None


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--pid", type=int, required=True, help="Standalone Yunzai PID to temporarily stop")
    parser.add_argument("--wechat-config", required=True)
    parser.add_argument("--output", required=True)
    args = parser.parse_args()
    os.umask(0o077)
    output = Path(args.output).resolve()
    output.mkdir(parents=True, exist_ok=True)
    if any(output.iterdir()):
        raise RuntimeError("Output directory must be empty")
    proc = Path(f"/proc/{args.pid}")
    node = str((proc / "exe").resolve(strict=True))
    if Path(node).name != "node" or (proc / "cwd").resolve() != ROOT:
        raise RuntimeError("PID must be the standalone Yunzai Node process in this checkout")
    stamp = process_stamp(args.pid)
    env = dict(item.split(b"=", 1) for item in (proc / "environ").read_bytes().split(b"\0") if b"=" in item)
    if env.get(b"app_type", b"") not in (b"",):
        raise RuntimeError("Managed/external launch mode needs its own recovery procedure")
    parent = int((proc / "stat").read_text().rsplit(")", 1)[1].split()[1])
    if Path(f"/proc/{parent}/comm").read_text().strip() not in ("bash", "zsh", "sh"):
        raise RuntimeError("Only a standalone process launched from a shell is supported")
    # Secrets only travel through this pipe and memory; never printed or saved.
    source = """import fs from 'node:fs'; import YAML from 'yaml';
const read = p => YAML.parse(fs.readFileSync(p, 'utf8'));
console.log(JSON.stringify({server:read('config/config/server.yaml'),
onebot:read('config/config/onebotv12.yaml'),wechat:read(process.argv[1]).onebot}));"""
    configs = json.loads(subprocess.check_output([node, "--input-type=module", "-e", source, args.wechat_config], cwd=ROOT, env=env))
    server = configs["server"]
    port = int(server["port"])
    if not configs["onebot"].get("enable") or server.get("https"):
        raise RuntimeError("Requires enabled OneBot adapter and plain WS")
    if configs["wechat"].get("write_enabled", False) or not configs["wechat"].get("enabled"):
        raise RuntimeError("WeChat OneBot must be enabled with writes disabled")
    listeners = subprocess.check_output(["ss", "-lntp", f"sport = :{port}"], text=True)
    if f"pid={args.pid}," not in listeners:
        raise RuntimeError("The supplied PID does not own the configured port")
    config_files = [ROOT / "config/config/server.yaml", ROOT / "config/config/onebotv12.yaml", Path(args.wechat_config)]
    originals = [p.read_bytes() for p in config_files]
    lifecycle = {"started_at": now(), "original_pid": args.pid, "node": subprocess.check_output([node, "--version"], text=True).strip(),
                 "launch_mode": "standalone node app.js", "write_enabled_config": False,
                 "recovery": "pending", "offline_messages_replayed": False}

    def save():
        target = output / "lifecycle.json"
        temporary = output / "lifecycle.json.tmp"
        temporary.write_text(json.dumps(lifecycle, indent=2, ensure_ascii=False) + "\n")
        temporary.replace(target)
        (output / "lifecycle.md").write_text("# 启停与恢复\n\n```json\n" + json.dumps(lifecycle, indent=2, ensure_ascii=False) + "\n```\n")

    def interrupt(signum, frame):
        raise InterruptedError("Supervisor interrupted")

    for sig in (signal.SIGINT, signal.SIGTERM):
        signal.signal(sig, interrupt)
    probe = None
    stop_requested = False
    save()
    try:
        # Arm restoration before asking the known existing application to exit.
        if process_stamp(args.pid) != stamp:
            raise RuntimeError("Original PID changed during preflight")
        stop_requested = True
        lifecycle["takeover_started_at"] = now()
        save()
        request = urllib.request.Request(f"http://127.0.0.1:{port}/exit", headers=server.get("auth") or {})
        try:
            opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
            with opener.open(request, timeout=10):
                pass
        except (OSError, TimeoutError):
            pass  # /exit closes its connection as the process exits.
        if not wait_for(lambda: process_stamp(args.pid) != stamp and not listening(port), 30):
            raise RuntimeError("Original service did not stop; refusing takeover")
        lifecycle["original_stopped_at"] = now()
        save()
        probe = subprocess.Popen([node, "tools/onebot12-readonly.js", str(output)], cwd=ROOT, env=env,
                                 stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
                                 start_new_session=True)
        lifecycle["probe_pid"] = probe.pid
        save()
        try:
            lifecycle["probe_exit_code"] = probe.wait(timeout=900)
        except subprocess.TimeoutExpired:
            lifecycle["probe_timeout"] = True
    except BaseException as exc:
        # Exception messages can contain secrets/URLs. Persist only a bounded category.
        lifecycle["supervisor_error"] = type(exc).__name__
    finally:
        # Further terminal signals must not interrupt restoration.
        for sig in (signal.SIGINT, signal.SIGTERM):
            signal.signal(sig, signal.SIG_IGN)
        lifecycle["restore_started_at"] = now()
        if probe and probe.poll() is None:
            probe.terminate()
            try:
                probe.wait(timeout=10)
            except subprocess.TimeoutExpired:
                probe.kill()
                probe.wait(timeout=10)
        if stop_requested and process_stamp(args.pid) != stamp:
            if wait_for(lambda: not listening(port), 10):
                restored = subprocess.Popen([node, "app.js"], cwd=ROOT, env=env,
                                            stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
                                            start_new_session=True)
                lifecycle["restored_pid"] = restored.pid
                ready = wait_for(lambda: restored.poll() is not None or listening(port), 60)
                lifecycle["recovery"] = "listening" if ready and restored.poll() is None and listening(port) else "failed"
            else:
                lifecycle["recovery"] = "blocked_port_occupied"
        else:
            lifecycle["recovery"] = "original_still_running" if listening(port) else "failed"
        lifecycle["configs_unchanged"] = all(p.read_bytes() == old for p, old in zip(config_files, originals))
        lifecycle["finished_at"] = now()
        save()
    print(json.dumps({k: lifecycle.get(k) for k in ("recovery", "probe_exit_code", "restored_pid", "configs_unchanged")}, ensure_ascii=False))
    return 0 if lifecycle["recovery"] in ("listening", "original_still_running") and lifecycle.get("probe_exit_code") == 0 else 1


if __name__ == "__main__":
    raise SystemExit(main())
