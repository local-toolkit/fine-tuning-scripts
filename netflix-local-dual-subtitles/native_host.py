#!/opt/homebrew/bin/python3
"""Chrome Native Messaging host for the local Netflix subtitle service."""

from __future__ import annotations

import json
import os
import shutil
import signal
import struct
import subprocess
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path
from typing import Any

# Chrome rejects unpacked extension directories containing __pycache__.
sys.dont_write_bytecode = True


BASE_DIR = Path(__file__).resolve().parent
DEFAULT_OLLAMA_URL = os.environ.get("OLLAMA_URL", "http://127.0.0.1:11434")
DEFAULT_SERVER_URL = "http://127.0.0.1:8765"
MODEL_KEEP_ALIVE = os.environ.get("NLLS_KEEP_ALIVE", "10m")
MODEL_WARMUP_TIMEOUT = float(os.environ.get("NLLS_WARMUP_TIMEOUT", "15"))
MAX_OLLAMA_RESPONSE_BYTES = 2 * 1024 * 1024
LOG_FILE = Path.home() / "Library" / "Logs" / "NetflixLocalDualSubtitles" / "native-host.log"
MAX_LOG_BYTES = 1 * 1024 * 1024
RUNTIME_STATE_FILE = (
    Path.home()
    / "Library"
    / "Application Support"
    / "NetflixLocalDualSubtitles"
    / "runtime.json"
)


def log(message: str) -> None:
    line = f"[nlds-native] {message}"
    print(line, file=sys.stderr, flush=True)
    try:
        LOG_FILE.parent.mkdir(parents=True, exist_ok=True)
        if LOG_FILE.exists() and LOG_FILE.stat().st_size >= MAX_LOG_BYTES:
            backup = LOG_FILE.with_name(f"{LOG_FILE.name}.1")
            backup.unlink(missing_ok=True)
            LOG_FILE.replace(backup)
        with LOG_FILE.open("a", encoding="utf-8") as handle:
            handle.write(line + "\n")
    except Exception:
        pass


def read_message() -> dict[str, Any] | None:
    header = sys.stdin.buffer.read(4)
    if not header:
        return None
    if len(header) != 4:
        raise RuntimeError("Native Messaging 消息头不完整。")
    length = struct.unpack("<I", header)[0]
    if length > 1024 * 1024:
        raise RuntimeError("Native Messaging 消息过大。")
    payload = sys.stdin.buffer.read(length)
    if len(payload) != length:
        raise RuntimeError("Native Messaging 消息内容不完整。")
    return json.loads(payload.decode("utf-8"))


def send_message(message: dict[str, Any]) -> None:
    payload = json.dumps(message, ensure_ascii=False).encode("utf-8")
    sys.stdout.buffer.write(struct.pack("<I", len(payload)))
    sys.stdout.buffer.write(payload)
    sys.stdout.buffer.flush()


def request_json(url: str, payload: dict[str, Any] | None = None, timeout: float = 1.0) -> dict[str, Any]:
    body = None
    headers = {}
    method = "GET"
    if payload is not None:
        body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        headers["Content-Type"] = "application/json"
        method = "POST"
    request = urllib.request.Request(url, data=body, headers=headers, method=method)
    with urllib.request.urlopen(request, timeout=timeout) as response:
        raw = response.read(MAX_OLLAMA_RESPONSE_BYTES + 1)
        if len(raw) > MAX_OLLAMA_RESPONSE_BYTES:
            raise RuntimeError("Ollama 响应过大，已拒绝读取。")
        return json.loads(raw.decode("utf-8"))


def wait_until(check, timeout: float, interval: float = 0.25) -> bool:
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        if check():
            return True
        time.sleep(interval)
    return False


def read_runtime_state() -> dict[str, Any] | None:
    try:
        return json.loads(RUNTIME_STATE_FILE.read_text(encoding="utf-8"))
    except Exception:
        return None


def clear_runtime_state() -> None:
    try:
        RUNTIME_STATE_FILE.unlink(missing_ok=True)
        for temporary_path in RUNTIME_STATE_FILE.parent.glob(f"{RUNTIME_STATE_FILE.name}.*.tmp"):
            temporary_path.unlink(missing_ok=True)
    except Exception:
        pass


def terminate_pid(pid: int, expected: str = "") -> None:
    if not pid or pid == os.getpid():
        return
    try:
        if expected:
            command = subprocess.run(
                ["ps", "-p", str(pid), "-o", "command="],
                capture_output=True,
                text=True,
                check=False,
            ).stdout
            if expected not in command:
                return
        os.kill(pid, signal.SIGTERM)
    except (OSError, subprocess.SubprocessError):
        pass


def terminate_process_group(pid: int, expected: str = "") -> None:
    if not pid:
        return
    try:
        if expected:
            command = subprocess.run(
                ["ps", "-p", str(pid), "-o", "command="],
                capture_output=True,
                text=True,
                check=False,
            ).stdout
            if expected not in command:
                return
        process_group = os.getpgid(pid)
        os.killpg(process_group, signal.SIGTERM)
        deadline = time.monotonic() + 2.0
        while time.monotonic() < deadline:
            try:
                os.kill(pid, 0)
            except ProcessLookupError:
                try:
                    os.killpg(process_group, 0)
                except ProcessLookupError:
                    return
                break
            except PermissionError:
                return
            time.sleep(0.05)
        # A detached runtime must not survive a failed graceful shutdown.
        # Re-check the command before escalating in case the PID was reused.
        if expected:
            command = subprocess.run(
                ["ps", "-p", str(pid), "-o", "command="],
                capture_output=True,
                text=True,
                check=False,
            ).stdout
            if expected not in command:
                return
        os.killpg(process_group, signal.SIGKILL)
    except (OSError, subprocess.SubprocessError):
        pass


def unload_model(ollama_url: str, model: str) -> None:
    if not model:
        return
    try:
        request_json(
            f"{ollama_url}/api/generate",
            {"model": model, "prompt": "", "stream": False, "keep_alive": 0},
            timeout=5.0,
        )
    except Exception:
        pass


def unload_loaded_models(ollama_url: str) -> None:
    """Release all loaded models for compatibility with stale state files."""
    try:
        data = request_json(f"{ollama_url}/api/ps", timeout=2.0)
        models = [str(item.get("name", "")) for item in data.get("models", [])]
    except Exception:
        models = []
    for model in models:
        unload_model(ollama_url, model)


def stop_saved_runtime() -> None:
    state = read_runtime_state()
    if not state:
        return
    terminate_process_group(int(state.get("server_pid") or 0), "server.py")
    if state.get("owns_ollama"):
        terminate_process_group(int(state.get("ollama_pid") or 0), "ollama serve")
    elif state.get("runtime_active", True):
        model = str(state.get("model") or "").strip()
        if model:
            unload_model(str(state.get("ollama_url") or DEFAULT_OLLAMA_URL), model)
        else:
            unload_loaded_models(str(state.get("ollama_url") or DEFAULT_OLLAMA_URL))
    terminate_pid(int(state.get("host_pid") or 0), "native_host.py")
    clear_runtime_state()


class Runner:
    def __init__(self) -> None:
        self.ollama_url = DEFAULT_OLLAMA_URL
        self.server_url = DEFAULT_SERVER_URL
        self.model = "translategemma:4b"
        self.ollama_process: subprocess.Popen | None = None
        self.server_process: subprocess.Popen | None = None
        self.owns_ollama = False
        self.owns_server = False
        self.runtime_active = False

    def ollama_ready(self) -> bool:
        try:
            request_json(f"{self.ollama_url}/api/version", timeout=0.8)
            return True
        except Exception:
            return False

    def installed_models(self) -> list[str]:
        data = request_json(f"{self.ollama_url}/api/tags", timeout=3.0)
        return [str(item.get("name", "")) for item in data.get("models", [])]

    def model_installed(self) -> bool:
        models = self.installed_models()
        return self.model in models or any(name.split(":", 1)[0] == self.model for name in models)

    def server_ready(self) -> bool:
        try:
            request_json(f"{self.server_url}/", timeout=0.8)
            return True
        except Exception:
            return False

    def start_ollama(self) -> None:
        if wait_until(self.ollama_ready, timeout=2.0):
            return

        ollama = shutil.which("ollama") or "/opt/homebrew/bin/ollama"
        if not Path(ollama).exists():
            raise RuntimeError("找不到 ollama 命令，请先安装 Ollama。")
        log(f"启动 Ollama：{ollama} serve")
        self.ollama_process = subprocess.Popen(
            [ollama, "serve"],
            stdin=subprocess.DEVNULL,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
            start_new_session=True,
        )
        self.owns_ollama = True
        self.write_runtime_state()
        if not wait_until(self.ollama_ready, timeout=12.0):
            raise RuntimeError("Ollama 启动超时。")
        # If another Ollama instance won the port race, the process we
        # launched has already exited. Do not claim ownership of that other
        # instance or skip model unloading during cleanup.
        if self.ollama_process.poll() is not None:
            self.ollama_process = None
            self.owns_ollama = False

    def start_server(self) -> None:
        parsed = urllib.parse.urlparse(self.server_url)
        if parsed.hostname not in (None, "127.0.0.1", "localhost") or parsed.port not in (None, 8765):
            log(f"检测到错误的本地服务地址 {self.server_url}，已改回 {DEFAULT_SERVER_URL}")
            self.server_url = DEFAULT_SERVER_URL
        if self.server_ready():
            return

        port = 8765
        env = os.environ.copy()
        env["NLLS_PORT"] = str(port)
        env["NLLS_MODEL"] = self.model
        server_path = BASE_DIR / "server.py"
        log(f"启动本地翻译服务：{server_path}")
        self.server_process = subprocess.Popen(
            [sys.executable, str(server_path)],
            cwd=str(BASE_DIR),
            env=env,
            stdin=subprocess.DEVNULL,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
            start_new_session=True,
        )
        self.owns_server = True
        self.write_runtime_state()
        if not wait_until(self.server_ready, timeout=10.0):
            exit_code = self.server_process.poll()
            log(f"本地翻译服务未就绪，进程退出码：{exit_code}")
            raise RuntimeError("本地翻译服务启动超时，8765 端口可能已被旧进程占用。")
        if self.server_process.poll() is not None:
            self.server_process = None
            self.owns_server = False

    def warm_model(self) -> None:
        """Load the selected model before the first real subtitle arrives."""
        log(f"预热模型：{self.model}")
        try:
            request_json(
                f"{self.ollama_url}/api/generate",
                {
                    "model": self.model,
                    "prompt": " ",
                    "stream": False,
                    "keep_alive": MODEL_KEEP_ALIVE,
                    "options": {
                        "temperature": 0.0,
                        "num_ctx": 1024,
                        "num_predict": 1,
                    },
                },
                timeout=MODEL_WARMUP_TIMEOUT,
            )
            log(f"模型预热完成：{self.model}")
        except Exception as exc:
            # A failed warm-up must not prevent the bridge from starting; the
            # first translation will simply load the model on demand.
            log(f"模型预热失败（不影响启动）：{exc}")

    def start(self, message: dict[str, Any]) -> None:
        self.model = str(message.get("model") or self.model)
        self.server_url = str(message.get("server_url") or DEFAULT_SERVER_URL).rstrip("/")
        self.start_ollama()
        models = self.installed_models()
        if self.model not in models and not any(name.split(":", 1)[0] == self.model for name in models):
            available = "、".join(models) or "（没有已安装模型）"
            raise RuntimeError(
                f"模型 {self.model} 尚未安装。已安装模型：{available}。"
                f"请在插件中选择已安装模型，或执行：ollama pull {self.model}"
            )
        self.runtime_active = True
        self.start_server()
        self.write_runtime_state()
        self.warm_model()
        log(f"本地翻译服务已就绪，模型：{self.model}")

    def write_runtime_state(self) -> None:
        temporary_path = None
        try:
            RUNTIME_STATE_FILE.parent.mkdir(parents=True, exist_ok=True)
            temporary_path = RUNTIME_STATE_FILE.with_name(
                f"{RUNTIME_STATE_FILE.name}.{os.getpid()}.tmp"
            )
            temporary_path.write_text(
                json.dumps(
                    {
                        "host_pid": os.getpid(),
                        "server_pid": self.server_process.pid if self.server_process else 0,
                        "ollama_pid": self.ollama_process.pid if self.ollama_process else 0,
                        "owns_server": self.owns_server,
                        "owns_ollama": self.owns_ollama,
                        "runtime_active": self.runtime_active,
                        "ollama_url": self.ollama_url,
                        "model": self.model,
                    },
                    ensure_ascii=False,
                ),
                encoding="utf-8",
            )
            os.replace(temporary_path, RUNTIME_STATE_FILE)
        except Exception as exc:
            log(f"无法写入运行状态：{exc}")
        finally:
            if temporary_path:
                try:
                    temporary_path.unlink(missing_ok=True)
                except Exception:
                    pass

    @staticmethod
    def terminate_process(process: subprocess.Popen | None) -> None:
        if not process or process.poll() is not None:
            return
        try:
            os.killpg(process.pid, signal.SIGTERM)
        except ProcessLookupError:
            return
        try:
            process.wait(timeout=2.0)
        except subprocess.TimeoutExpired:
            try:
                os.killpg(process.pid, signal.SIGKILL)
            except ProcessLookupError:
                pass

    def stop(self) -> None:
        if self.owns_server:
            self.terminate_process(self.server_process)
        if self.owns_ollama:
            self.terminate_process(self.ollama_process)
        elif self.runtime_active:
            self.unload_model()
        self.server_process = None
        self.ollama_process = None
        self.owns_server = False
        self.owns_ollama = False
        self.runtime_active = False
        state = read_runtime_state()
        if state and int(state.get("host_pid") or 0) == os.getpid():
            clear_runtime_state()

    def unload_model(self) -> None:
        """Release only the model selected by the plugin."""
        unload_model(self.ollama_url, self.model)

def main() -> None:
    runner = Runner()
    log("Native Messaging host started")
    try:
        while True:
            message = read_message()
            if message is None:
                # A closed/disabled extension closes the Native Messaging
                # input while Chrome itself may still be running. Do not keep
                # the plugin-owned runtime alive in that case; the finally
                # block releases its processes and loaded model.
                log("Native Messaging 输入已关闭，停止插件托管的本地运行时")
                break
            kind = message.get("type")
            if kind == "start":
                try:
                    runner.start(message)
                    send_message({"type": "ready", "model": runner.model})
                except Exception as exc:
                    log(str(exc))
                    runner.stop()
                    send_message({"type": "error", "error": str(exc)})
                    # Keep the native port alive so the extension receives the
                    # real startup error instead of Chrome's generic
                    # "Native host has exited" message.
            elif kind == "stop":
                runner.stop()
                send_message({"type": "stopped"})
                break
            elif kind == "stop_all":
                stop_saved_runtime()
                runner.stop()
                send_message({"type": "stopped"})
                break
            elif kind == "ping":
                if runner.server_process and runner.server_process.poll() is not None:
                    log("检测到本地翻译服务已退出，尝试自动重启")
                    try:
                        runner.start_server()
                        log("本地翻译服务自动重启成功")
                    except Exception as exc:
                        log(f"本地翻译服务自动重启失败：{exc}")
                send_message({"type": "pong"})
    except Exception as exc:
        log(f"Native Messaging 输入已断开：{exc}")
        log(str(exc))
    finally:
        log("Native Messaging host shutting down")
        runner.stop()


if __name__ == "__main__":
    main()
