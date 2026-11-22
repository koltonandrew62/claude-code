"""Aviary: a local chat page for the models you trained. No API, no account, no usage.

Usage:  python serve.py            then open http://127.0.0.1:8000
"""
import argparse
import json
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

import torch
from tokenizers import Tokenizer

from models import (HERE, LINEUP, TOKENIZER_PATH, ckpt_path, count_params, load_model,
                    pick_device, read_meta)

DEVICE = pick_device()
INDEX = HERE / "web" / "index.html"
MAX_BODY = 64 * 1024
_loaded = {}            # name -> (checkpoint mtime, model)
_busy = threading.Lock()  # one answer at a time so the CPU isn't split
_tok = None


def tokenizer():
    global _tok
    if _tok is None:
        _tok = Tokenizer.from_file(str(TOKENIZER_PATH))
    return _tok


def get_model(name):
    mtime = ckpt_path(name).stat().st_mtime
    if name not in _loaded or _loaded[name][0] != mtime:  # reload after more training
        _loaded[name] = (mtime, load_model(name, DEVICE))
    return _loaded[name][1]


def model_list():
    out = []
    for name, cfg in LINEUP.items():
        meta = read_meta(name) if ckpt_path(name).exists() else None
        params = count_params(name)
        out.append({"name": name, "blurb": cfg["blurb"], "params": params,
                    "context": cfg["block_size"], "trained": meta is not None, "meta": meta})
    return out


def generate(name, prompt, temperature, top_k, max_tokens):
    """Yield pieces of text as the model writes them."""
    tok, model = tokenizer(), get_model(name)
    task, code, end = (tok.token_to_id(t) for t in ("<|task|>", "<|code|>", "<|end|>"))
    room = model.block_size - 32
    ids = [task] + tok.encode(prompt.strip()).ids[:room // 2] + [code]
    out, sent = [], ""
    for nxt in model.stream(ids, min(max_tokens, model.block_size - len(ids)),
                            temperature, top_k, stop_id=end):
        out.append(nxt)
        text = tok.decode(out, skip_special_tokens=True)
        if text.endswith("�"):  # half of a multi-byte character; wait for the rest
            continue
        yield text[len(sent):]
        sent = text


class Handler(BaseHTTPRequestHandler):
    def log_message(self, *args):
        pass

    def send_json(self, obj, status=200):
        body = json.dumps(obj).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        if self.path in ("/", "/index.html"):
            body = INDEX.read_bytes()
            self.send_response(200)
            self.send_header("Content-Type", "text/html; charset=utf-8")
            self.send_header("Content-Length", str(len(body)))
            self.send_header("Cache-Control", "no-store")
            self.end_headers()
            self.wfile.write(body)
        elif self.path == "/api/models":
            self.send_json({"device": DEVICE, "models": model_list()})
        else:
            self.send_json({"error": "not found"}, 404)

    def do_POST(self):
        if self.path != "/api/generate":
            return self.send_json({"error": "not found"}, 404)
        try:
            length = int(self.headers.get("Content-Length", 0))
            if not 0 < length <= MAX_BODY:
                raise ValueError("request too large")
            req = json.loads(self.rfile.read(length))
            name, prompt = req["model"], str(req["prompt"])
            temperature = min(2.0, max(0.0, float(req.get("temperature", 0.7))))
            max_tokens = min(1024, max(1, int(req.get("max_tokens", 200))))
            if name not in LINEUP or not prompt.strip():
                raise ValueError("unknown model or empty prompt")
        except (KeyError, ValueError, TypeError) as e:
            return self.send_json({"error": f"bad request: {e}"}, 400)
        if not ckpt_path(name).exists():
            return self.send_json(
                {"error": f"{name.title()} isn't trained yet. Run: python train.py {name}"}, 409)

        # HTTP/1.0 response with no length: the browser reads until we close the socket.
        self.send_response(200)
        self.send_header("Content-Type", "text/plain; charset=utf-8")
        self.send_header("Cache-Control", "no-store")
        self.send_header("X-Accel-Buffering", "no")
        self.end_headers()
        with _busy:
            try:
                for piece in generate(name, prompt, temperature, 40, max_tokens):
                    self.wfile.write(piece.encode())
            except (BrokenPipeError, ConnectionResetError):
                pass  # the user pressed Stop or closed the tab


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--host", default="127.0.0.1", help="keep the default to stay private to this computer")
    ap.add_argument("--port", type=int, default=8000)
    args = ap.parse_args()
    torch.set_grad_enabled(False)
    server = ThreadingHTTPServer((args.host, args.port), Handler)
    trained = [m["name"] for m in model_list() if m["trained"]]
    print(f"Aviary running on http://{args.host}:{args.port}  (device: {DEVICE}, "
          f"trained models: {', '.join(trained) or 'none yet'})")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass


if __name__ == "__main__":
    main()
