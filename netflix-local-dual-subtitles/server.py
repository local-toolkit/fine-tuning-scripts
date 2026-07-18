#!/usr/bin/env python3
"""Small localhost bridge between the Chrome extension and Ollama.

The server deliberately uses only Python's standard library. It binds to
127.0.0.1, so subtitle text is sent only to the local Ollama process.
"""

from __future__ import annotations

import json
import os
import re
import sys
import urllib.error
import urllib.parse
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from threading import BoundedSemaphore
from typing import Any

# Chrome rejects unpacked extension directories containing __pycache__.
sys.dont_write_bytecode = True


# Keep the bundled OpenCC package inside the single extension directory. The
# environment variable remains available for development or an external copy.
LOCAL_DEPENDENCY_DIR = Path(
    os.environ.get("NLLS_DEPENDENCY_DIR", str(Path(__file__).resolve().parent))
)
if LOCAL_DEPENDENCY_DIR.is_dir():
    sys.path.insert(0, str(LOCAL_DEPENDENCY_DIR))

try:
    from opencc import OpenCC
except ImportError:
    OpenCC = None


HOST = "127.0.0.1"
PORT = int(os.environ.get("NLLS_PORT", "8765"))
DEFAULT_MODEL = os.environ.get("NLLS_MODEL", "translategemma:4b")
OLLAMA_URL = os.environ.get("OLLAMA_URL", "http://127.0.0.1:11434")
MODEL_KEEP_ALIVE = os.environ.get("NLLS_KEEP_ALIVE", "10m")
OLLAMA_TRANSLATION_TIMEOUT = float(os.environ.get("NLLS_TRANSLATION_TIMEOUT", "10"))
MAX_SUBTITLE_LENGTH = 500
MAX_MODEL_NAME_LENGTH = 200
MAX_MODEL_OUTPUT_LENGTH = 4_000
MAX_OLLAMA_RESPONSE_BYTES = 2 * 1024 * 1024
FALLBACK_MODEL = "translategemma:4b"
SIMPLIFIER = OpenCC("t2s") if OpenCC else None
LANGUAGE_FALLBACKS: set[str] = set()
# Ollama is local and memory-heavy. Keep only one translation request in the
# model at a time; extra tabs receive a fast 429 instead of accumulating
# worker threads and queued model contexts.
TRANSLATION_SLOT = BoundedSemaphore(1)
REQUEST_THREAD_LIMIT = 8
REQUEST_TIMEOUT_SECONDS = 40.0

LANGUAGES = {
    "en": "English",
    "ja": "Japanese",
    "ko": "Korean",
}
HY_MT_PREFIXES = (
    "hy-mt",
    "hf.co/tencent/hy-mt",
    "tencent/hy-mt",
    "ali6parmak/hy-mt",
    "sun_leaf/hy-mt",
)


def is_hy_mt_model(model: str) -> bool:
    normalized = str(model or "").strip().lower()
    return normalized.startswith(HY_MT_PREFIXES)


def json_response(handler: BaseHTTPRequestHandler, status: int, payload: dict[str, Any]) -> None:
    raw = json.dumps(payload, ensure_ascii=False).encode("utf-8")
    handler.send_response(status)
    handler.send_header("Content-Type", "application/json; charset=utf-8")
    handler.send_header("Content-Length", str(len(raw)))
    handler.send_header("Access-Control-Allow-Origin", "*")
    handler.send_header("Access-Control-Allow-Headers", "Content-Type")
    handler.end_headers()
    handler.wfile.write(raw)


def clean_subtitle(text: str) -> str:
    text = str(text or "").replace("\u00a0", " ")
    text = re.sub(r"[ \t]+", " ", text)
    return re.sub(r"\n{3,}", "\n\n", text).strip()


def to_simplified_chinese(text: str) -> str:
    """Normalize model output to Simplified Chinese when OpenCC is available."""
    cleaned = clean_subtitle(text)
    return SIMPLIFIER.convert(cleaned) if SIMPLIFIER else cleaned


def guess_language(text: str) -> str:
    if re.search(r"[\uac00-\ud7af]", text):
        return "ko"
    if re.search(r"[\u3040-\u30ff]", text):
        return "ja"
    return "en"


def model_prompt(text: str, source_language: str, model: str, retry: bool = False) -> str:
    if is_hy_mt_model(model):
        prompt = (
            "将以下字幕翻译为简体中文，只需要输出译文，不要解释；"
            "保留人名、数字、标点和语气：\n\n"
            f"{text}"
        )
        if retry:
            prompt = "不要保留英文原文，直接输出自然的简体中文译文：\n\n" + prompt
        return prompt

    source_name = LANGUAGES.get(source_language, "the source language")
    prompt = (
        f"Translate this {source_name} subtitle into Simplified Chinese (zh-CN). "
        "Return only the translation. Never use Traditional Chinese. "
        "Preserve names, numbers, punctuation, line breaks, and tone. "
        "Do not add explanations, labels, or notes.\n\n"
        f"{text}"
    )
    if retry:
        prompt = (
            "Translate every word now. Do not copy or leave the source sentence unchanged. "
            "Output only natural Simplified Chinese.\n\n"
            + prompt
        )
    return prompt


def ollama_request(path: str, payload: dict[str, Any] | None = None, timeout: float = 3.0) -> dict[str, Any]:
    body = None
    headers = {}
    method = "GET"
    if payload is not None:
        body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        headers["Content-Type"] = "application/json"
        method = "POST"
    request = urllib.request.Request(f"{OLLAMA_URL}{path}", data=body, headers=headers, method=method)
    with urllib.request.urlopen(request, timeout=timeout) as response:
        raw = response.read(MAX_OLLAMA_RESPONSE_BYTES + 1)
        if len(raw) > MAX_OLLAMA_RESPONSE_BYTES:
            raise RuntimeError("Ollama 响应过大，已拒绝读取。")
        return json.loads(raw.decode("utf-8"))


def installed_models() -> list[str]:
    data = ollama_request("/api/tags", timeout=2.0)
    return [str(item.get("name", "")) for item in data.get("models", [])]


def model_is_installed(model: str, models: list[str]) -> bool:
    return model in models or any(name.split(":", 1)[0] == model for name in models)


def clean_model_output(text: str) -> str:
    result = clean_subtitle(text)
    result = re.sub(r"^```(?:text|zh|中文)?\s*|\s*```$", "", result, flags=re.IGNORECASE).strip()
    result = re.sub(r"^(?:简体中文|中文翻译|Translation)\s*[:：]\s*", "", result, flags=re.IGNORECASE)
    return to_simplified_chinese(result)


def likely_untranslated(source: str, source_language: str, result: str) -> bool:
    source_normalized = re.sub(r"[\W_]+", "", source, flags=re.UNICODE).lower()
    result_normalized = re.sub(r"[\W_]+", "", result, flags=re.UNICODE).lower()
    if not result or source_normalized == result_normalized:
        return True

    cjk_count = len(re.findall(r"[\u3400-\u4dbf\u4e00-\u9fff]", result))
    if source_language == "en":
        source_words = re.findall(r"[A-Za-z]+", source)
        latin_count = len(re.findall(r"[A-Za-z]", result))
        if len(source_words) >= 2 and cjk_count == 0:
            return True
        if len(source) >= 12 and cjk_count > 0 and latin_count > cjk_count:
            return True
    elif source_language == "ko":
        if re.search(r"[\uac00-\ud7af]", result):
            return True
    elif source_language == "ja":
        kana_count = len(re.findall(r"[\u3040-\u30ff]", result))
        if kana_count >= 2:
            return True
    return False


def translate_once(text: str, source_language: str, model: str, retry: bool = False) -> str:
    is_hy_mt = is_hy_mt_model(model)
    payload = {
        "model": model,
        "messages": [{"role": "user", "content": model_prompt(text, source_language, model, retry)}],
        "stream": False,
        "keep_alive": MODEL_KEEP_ALIVE,
        "options": {
            "temperature": 0.0,
            "top_p": 0.6 if is_hy_mt else 0.8,
            # Netflix subtitle lines are short; a smaller context and output
            # budget reduces prompt processing and prevents long model tails.
            "num_ctx": 1024,
            "num_predict": 64 if is_hy_mt else 80,
        },
    }
    if model.startswith(("qwen3", "qwen3.5")):
        payload["think"] = False
    data = ollama_request("/api/chat", payload, timeout=OLLAMA_TRANSLATION_TIMEOUT)
    raw_result = data.get("message", {}).get("content", "")
    if not isinstance(raw_result, str) or len(raw_result) > MAX_MODEL_OUTPUT_LENGTH:
        raise RuntimeError("Ollama 返回内容过大或格式不正确。")
    result = clean_model_output(raw_result)
    if not result:
        raise RuntimeError("Ollama 返回了空翻译。")
    return result


def translate(text: str, source_language: str, model: str) -> str:
    if is_hy_mt_model(model):
        # HY-MT is already specialized for translation. Avoid the generic
        # TranslateGemma fallback, which makes occasional subtitle lines
        # several times slower. Retry at most once only when the output is
        # clearly unchanged or untranslated.
        result = translate_once(text, source_language, model)
        if not likely_untranslated(text, source_language, result):
            return result
        result = translate_once(text, source_language, model, retry=True)
        if not likely_untranslated(text, source_language, result):
            return result
        raise RuntimeError("HY-MT 返回了未完成的翻译，请稍后重试。")

    if model != FALLBACK_MODEL and source_language in LANGUAGE_FALLBACKS:
        preferred = translate_once(text, source_language, FALLBACK_MODEL, retry=True)
        if not likely_untranslated(text, source_language, preferred):
            return preferred

    result = translate_once(text, source_language, model)
    if not likely_untranslated(text, source_language, result):
        return result

    result = translate_once(text, source_language, model, retry=True)
    if not likely_untranslated(text, source_language, result):
        return result

    if model != FALLBACK_MODEL and model_is_installed(FALLBACK_MODEL, installed_models()):
        fallback = translate_once(text, source_language, FALLBACK_MODEL, retry=True)
        if not likely_untranslated(text, source_language, fallback):
            LANGUAGE_FALLBACKS.add(source_language)
            return fallback

    raise RuntimeError(
        "模型返回了未完成的翻译，已阻止显示混合原文；"
        "请稍后重试，或选择 TranslateGemma 4B。"
    )


class Handler(BaseHTTPRequestHandler):
    server_version = "NetflixLocalDualSubtitles/0.1"

    def setup(self) -> None:
        super().setup()
        self.connection.settimeout(REQUEST_TIMEOUT_SECONDS)

    def log_message(self, format: str, *args: Any) -> None:
        print(f"[nlds] {format % args}")

    def do_OPTIONS(self) -> None:  # noqa: N802
        self.send_response(204)
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type")
        self.end_headers()

    def do_GET(self) -> None:  # noqa: N802
        parsed = urllib.parse.urlparse(self.path)
        if parsed.path == "/health":
            query = urllib.parse.parse_qs(parsed.query)
            model = query.get("model", [DEFAULT_MODEL])[0] or DEFAULT_MODEL
            try:
                models = installed_models()
                json_response(self, 200, {
                    "ok": True,
                    "model": model,
                    "model_ready": model_is_installed(model, models),
                    "installed_models": models,
                })
            except Exception as exc:
                json_response(self, 503, {"ok": False, "error": f"无法连接 Ollama：{exc}"})
            return
        if parsed.path == "/":
            json_response(self, 200, {"name": "Netflix Local Dual Subtitles", "model": DEFAULT_MODEL})
            return
        json_response(self, 404, {"error": "Not found"})

    def do_POST(self) -> None:  # noqa: N802
        if urllib.parse.urlparse(self.path).path != "/translate":
            json_response(self, 404, {"error": "Not found"})
            return
        try:
            length = int(self.headers.get("Content-Length", "0"))
            if length <= 0 or length > 32_000:
                raise ValueError("请求内容过大或为空。")
            payload = json.loads(self.rfile.read(length).decode("utf-8"))
            text = clean_subtitle(payload.get("text", ""))
            if not text or len(text) > MAX_SUBTITLE_LENGTH:
                raise ValueError("字幕文本为空或过长。")
            source_language = str(payload.get("source_language", "auto"))
            if source_language == "auto":
                source_language = guess_language(text)
            if source_language not in LANGUAGES:
                raise ValueError("source_language 必须是 en、ja、ko 或 auto。")
            model = str(payload.get("model", "")).strip() or DEFAULT_MODEL
            if len(model) > MAX_MODEL_NAME_LENGTH or any(ord(char) < 32 for char in model):
                raise ValueError("model 名称过长或包含控制字符。")
            if not TRANSLATION_SLOT.acquire(blocking=False):
                json_response(self, 429, {"error": "本地模型正忙，请稍后重试。"})
                return
            try:
                result = translate(text, source_language, model)
            finally:
                TRANSLATION_SLOT.release()
            json_response(self, 200, {
                "ok": True,
                "translated": result,
                "source_language": source_language,
                "model": model,
            })
        except urllib.error.HTTPError as exc:
            detail = exc.read().decode("utf-8", errors="replace")
            json_response(self, 502, {"error": f"Ollama 请求失败（HTTP {exc.code}）：{detail[:500]}"})
        except urllib.error.URLError as exc:
            json_response(self, 503, {"error": f"无法连接 Ollama：{exc.reason}"})
        except Exception as exc:
            json_response(self, 500, {"error": str(exc)})


class ReusableThreadingHTTPServer(ThreadingHTTPServer):
    allow_reuse_address = True
    daemon_threads = True
    block_on_close = False
    request_slots = BoundedSemaphore(REQUEST_THREAD_LIMIT)

    def process_request(self, request, client_address):
        # Bound handler threads as well as model calls. Waiting here leaves
        # excess connections in the OS listen queue instead of allocating an
        # unbounded number of Python threads.
        self.request_slots.acquire()
        try:
            super().process_request(request, client_address)
        except BaseException:
            self.request_slots.release()
            raise

    def process_request_thread(self, request, client_address):
        try:
            super().process_request_thread(request, client_address)
        finally:
            self.request_slots.release()


def main() -> None:
    print(f"Netflix Local Dual Subtitles listening on http://{HOST}:{PORT}")
    print(f"Ollama: {OLLAMA_URL} | default model: {DEFAULT_MODEL}")
    ReusableThreadingHTTPServer((HOST, PORT), Handler).serve_forever()


if __name__ == "__main__":
    main()
