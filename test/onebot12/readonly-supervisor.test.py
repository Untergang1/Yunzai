"""Exercise real supervisor stop/restore using disposable local HTTP processes."""
import json
import os
from pathlib import Path
import shutil
import signal
import socket
import subprocess
import tempfile
import time
import unittest

ROOT = Path(__file__).resolve().parents[2]
SCRIPT = ROOT / "tools/onebot12-readonly-run.py"
NODE = shutil.which("node")


def wait_for(check, seconds=10):
    end = time.monotonic() + seconds
    while time.monotonic() < end:
        if check():
            return True
        time.sleep(0.05)
    return False


class RecoveryTests(unittest.TestCase):
    def scenario(self, interrupt=False):
        with tempfile.TemporaryDirectory(prefix="readonly-recovery-") as temp:
            root = Path(temp)
            (root / "config/config").mkdir(parents=True)
            (root / "tools").mkdir()
            (root / "node_modules").symlink_to(ROOT / "node_modules", target_is_directory=True)
            with socket.socket() as sock:
                sock.bind(("127.0.0.1", 0))
                port = sock.getsockname()[1]
            (root / "config/config/server.yaml").write_text(f"port: {port}\n")
            (root / "config/config/onebotv12.yaml").write_text("enable: true\n")
            (root / "wechat.yaml").write_text("onebot:\n  enabled: true\n  write_enabled: false\n")
            (root / "app.js").write_text("const fs=require('fs');const http=require('http');"
                f"http.createServer((q,s)=>{{if(q.url==='/exit')process.exit();s.end('ok')}}).listen({port},'127.0.0.1',()=>fs.writeFileSync('pid',String(process.pid)));setInterval(()=>{{}},1000);")
            (root / "tools/onebot12-readonly.js").write_text("setInterval(()=>{},1000)" if interrupt else "process.exit(1)")
            # Keep a real shell parent, matching the supported standalone deployment.
            shell = subprocess.Popen(["bash", "-c", '"$1" app.js & wait', "probe-test", NODE], cwd=root,
                                     stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
            supervisor = None
            restored_pid = None
            original_pid = None
            try:
                self.assertTrue(wait_for(lambda: (root / "pid").exists()))
                original_pid = int((root / "pid").read_text())
                output = root / "report"
                code = "import importlib.util,sys,pathlib;spec=importlib.util.spec_from_file_location('runner',sys.argv.pop(1));m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m);m.ROOT=pathlib.Path(sys.argv.pop(1));sys.exit(m.main())"
                supervisor = subprocess.Popen(["python3", "-c", code, str(SCRIPT), str(root), "--pid", str(original_pid),
                                               "--wechat-config", str(root / "wechat.yaml"), "--output", str(output)],
                                              stdout=subprocess.PIPE, stderr=subprocess.PIPE)
                if interrupt:
                    def armed():
                        try:
                            return "probe_pid" in json.loads((output / "lifecycle.json").read_text())
                        except (FileNotFoundError, json.JSONDecodeError):
                            return False
                    self.assertTrue(wait_for(armed))
                    supervisor.send_signal(signal.SIGTERM)
                stdout, stderr = supervisor.communicate(timeout=15)
                self.assertEqual(supervisor.returncode, 1, stderr.decode())
                result = json.loads((output / "lifecycle.json").read_text())
                restored_pid = result.get("restored_pid")
                self.assertEqual(result["recovery"], "listening", stdout.decode())
                self.assertTrue(result["configs_unchanged"])
                self.assertNotEqual(original_pid, restored_pid)
                with socket.create_connection(("127.0.0.1", port), timeout=1):
                    pass
                self.assertEqual(result.get("supervisor_error"), "InterruptedError" if interrupt else None)
            finally:
                if supervisor and supervisor.poll() is None:
                    supervisor.terminate()
                    supervisor.communicate(timeout=15)
                for pid in (original_pid, restored_pid):
                    if pid:
                        try:
                            os.kill(pid, signal.SIGTERM)
                        except ProcessLookupError:
                            pass
                shell.wait(timeout=5)

    def test_failed_probe_restores_original_service(self):
        self.scenario()

    def test_interrupted_supervisor_restores_original_service(self):
        self.scenario(interrupt=True)


if __name__ == "__main__":
    unittest.main()
