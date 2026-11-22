"""The Aviary model family: small GPT-style transformers built and trained from scratch.

Every model shares the same architecture and tokenizer; only the size differs.
"""
import json
import math
from pathlib import Path

import torch
import torch.nn as nn
import torch.nn.functional as F

HERE = Path(__file__).resolve().parent
CKPT_DIR = HERE / "checkpoints"
DATA_DIR = HERE / "data"
TOKENIZER_PATH = CKPT_DIR / "tokenizer.json"

VOCAB_SIZE = 4096
SPECIALS = ["<|pad|>", "<|task|>", "<|code|>", "<|end|>"]

# name -> size. Bigger = smarter, but needs more data, time and (from Heron up) a GPU.
LINEUP = {
    "wren": dict(n_layer=4, n_head=4, n_embd=192, block_size=256,
                 blurb="Tiny and fast. Trains on a laptop CPU in under an hour."),
    "kestrel": dict(n_layer=6, n_head=6, n_embd=384, block_size=256,
                    blurb="Small. A few hours on CPU, minutes on a GPU."),
    "heron": dict(n_layer=8, n_head=8, n_embd=512, block_size=512,
                  blurb="Medium. Longer memory. Needs a GPU to train."),
    "condor": dict(n_layer=12, n_head=12, n_embd=768, block_size=1024,
                   blurb="Largest. Needs a strong GPU and far more data."),
}


def arch(name):
    return {k: v for k, v in LINEUP[name].items() if k != "blurb"}


def count_params(name):
    a, d = arch(name), LINEUP[name]["n_embd"]
    return VOCAB_SIZE * d + a["block_size"] * d + a["n_layer"] * (12 * d * d + 13 * d) + 2 * d


class Block(nn.Module):
    def __init__(self, n_embd, n_head):
        super().__init__()
        self.n_head = n_head
        self.ln1 = nn.LayerNorm(n_embd)
        self.qkv = nn.Linear(n_embd, 3 * n_embd)
        self.proj = nn.Linear(n_embd, n_embd)
        self.ln2 = nn.LayerNorm(n_embd)
        self.fc = nn.Linear(n_embd, 4 * n_embd)
        self.out = nn.Linear(4 * n_embd, n_embd)

    def forward(self, x):
        B, T, C = x.shape
        q, k, v = (self.qkv(self.ln1(x))
                   .view(B, T, 3, self.n_head, C // self.n_head)
                   .permute(2, 0, 3, 1, 4))
        att = F.scaled_dot_product_attention(q, k, v, is_causal=True)
        x = x + self.proj(att.transpose(1, 2).reshape(B, T, C))
        return x + self.out(F.gelu(self.fc(self.ln2(x))))


class GPT(nn.Module):
    def __init__(self, n_layer, n_head, n_embd, block_size, vocab_size=VOCAB_SIZE):
        super().__init__()
        self.block_size = block_size
        self.tok = nn.Embedding(vocab_size, n_embd)
        self.pos = nn.Embedding(block_size, n_embd)
        self.blocks = nn.ModuleList(Block(n_embd, n_head) for _ in range(n_layer))
        self.ln_f = nn.LayerNorm(n_embd)
        self.head = nn.Linear(n_embd, vocab_size, bias=False)
        self.head.weight = self.tok.weight  # weight tying
        self.apply(self._init)
        for name, p in self.named_parameters():
            if name.endswith(("proj.weight", "out.weight")):
                nn.init.normal_(p, std=0.02 / math.sqrt(2 * n_layer))

    @staticmethod
    def _init(m):
        if isinstance(m, (nn.Linear, nn.Embedding)):
            nn.init.normal_(m.weight, std=0.02)
            if getattr(m, "bias", None) is not None:
                nn.init.zeros_(m.bias)

    def n_params(self):
        return sum(p.numel() for p in self.parameters())

    def forward(self, idx, targets=None):
        T = idx.shape[1]
        x = self.tok(idx) + self.pos(torch.arange(T, device=idx.device))
        for block in self.blocks:
            x = block(x)
        logits = self.head(self.ln_f(x))
        loss = None
        if targets is not None:
            loss = F.cross_entropy(logits.view(-1, logits.size(-1)), targets.view(-1))
        return logits, loss

    @torch.no_grad()
    def stream(self, ids, max_new, temperature=0.7, top_k=40, stop_id=None):
        """Yield new token ids one at a time."""
        device = self.tok.weight.device
        x = torch.tensor([ids], dtype=torch.long, device=device)
        for _ in range(max_new):
            logits = self(x[:, -self.block_size:])[0][0, -1]
            if temperature <= 0:
                nxt = int(logits.argmax())
            else:
                logits = logits / temperature
                if top_k:
                    kth = torch.topk(logits, min(top_k, logits.numel())).values[-1]
                    logits[logits < kth] = -float("inf")
                nxt = int(torch.multinomial(F.softmax(logits, dim=-1), 1))
            if nxt == stop_id:
                return
            yield nxt
            x = torch.cat([x, torch.tensor([[nxt]], device=device)], dim=1)


def ckpt_path(name):
    return CKPT_DIR / f"{name}.pt"


def meta_path(name):
    return CKPT_DIR / f"{name}.json"


def save_checkpoint(name, model, meta):
    """Weights are stored as float16 to halve the file size."""
    CKPT_DIR.mkdir(exist_ok=True)
    state = {k: v.detach().cpu().half() for k, v in model.state_dict().items()}
    torch.save({"name": name, "arch": arch(name), "state": state}, ckpt_path(name))
    meta_path(name).write_text(json.dumps(meta, indent=2))


def load_model(name, device="cpu"):
    ckpt = torch.load(ckpt_path(name), map_location="cpu", weights_only=True)
    model = GPT(**ckpt["arch"])
    model.load_state_dict({k: v.float() for k, v in ckpt["state"].items()})
    return model.to(device).eval()


def read_meta(name):
    p = meta_path(name)
    return json.loads(p.read_text()) if p.exists() else None


def pick_device():
    if torch.cuda.is_available():
        return "cuda"
    if getattr(torch.backends, "mps", None) and torch.backends.mps.is_available():
        return "mps"
    return "cpu"
