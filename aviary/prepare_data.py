"""Build the training set and tokenizer from Python source code already on this computer.

Every function that has a docstring becomes one lesson:
    <|task|>{what the function does}<|code|>{the function}<|end|>

Usage:  python prepare_data.py [--src DIR ...]
"""
import argparse
import ast
import hashlib
import random
import sysconfig
import textwrap
from pathlib import Path

import numpy as np
from tokenizers import Regex, Tokenizer, decoders, models, pre_tokenizers, trainers

from models import DATA_DIR, SPECIALS, TOKENIZER_PATH, VOCAB_SIZE


def lessons_from_file(path, max_chars):
    try:
        text = path.read_text(encoding="utf-8")
        tree = ast.parse(text)
    except (SyntaxError, UnicodeDecodeError, ValueError, OSError, RecursionError):
        return
    lines = text.splitlines()
    for node in ast.walk(tree):
        if not isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)):
            continue
        doc = ast.get_docstring(node)
        if not doc or len(node.body) < 2:
            continue
        summary = " ".join(doc.strip().split("\n\n")[0].split())
        if not 15 <= len(summary) <= 200:
            continue
        doc_node = node.body[0]
        start = min([node.lineno] + [d.lineno for d in node.decorator_list])
        kept = lines[start - 1:doc_node.lineno - 1] + lines[doc_node.end_lineno:node.end_lineno]
        code = textwrap.dedent("\n".join(kept)).strip()
        if 40 <= len(code) <= max_chars:
            yield summary, code


def build_tokenizer(texts):
    tok = Tokenizer(models.BPE())
    # Keep runs of whitespace together so indentation becomes single tokens.
    tok.pre_tokenizer = pre_tokenizers.Sequence([
        pre_tokenizers.Split(Regex(r"\s+|\w+|[^\w\s]"), behavior="isolated"),
        pre_tokenizers.ByteLevel(add_prefix_space=False, use_regex=False),
    ])
    tok.decoder = decoders.ByteLevel()
    trainer = trainers.BpeTrainer(
        vocab_size=VOCAB_SIZE, special_tokens=SPECIALS,
        initial_alphabet=pre_tokenizers.ByteLevel.alphabet(), show_progress=False)
    tok.train_from_iterator(texts, trainer)
    return tok


def main():
    stdlib = sysconfig.get_paths()["stdlib"]
    ap = argparse.ArgumentParser()
    ap.add_argument("--src", nargs="*", default=[stdlib],
                    help="folders of Python code to learn from (default: Python's own library)")
    ap.add_argument("--max-chars", type=int, default=1500)
    args = ap.parse_args()

    seen, texts = set(), []
    for src in args.src:
        for path in sorted(Path(src).rglob("*.py")):
            for summary, code in lessons_from_file(path, args.max_chars):
                key = hashlib.md5(code.encode()).digest()
                if key not in seen:
                    seen.add(key)
                    texts.append(f"<|task|>{summary}<|code|>{code}<|end|>")
    if len(texts) < 1000:
        raise SystemExit(f"Only found {len(texts)} lessons - point --src at more Python code.")
    random.Random(0).shuffle(texts)
    print(f"{len(texts):,} lessons, {sum(map(len, texts)) / 1e6:.1f} MB of text")

    tok = build_tokenizer(texts)
    TOKENIZER_PATH.parent.mkdir(exist_ok=True)
    tok.save(str(TOKENIZER_PATH))

    sample = texts[0]
    assert tok.decode(tok.encode(sample).ids, skip_special_tokens=False) == sample, "tokenizer round-trip failed"

    ids = [e.ids for e in tok.encode_batch(texts)]
    n_val = max(200, len(ids) // 50)
    DATA_DIR.mkdir(exist_ok=True)
    for split, chunk in (("val", ids[:n_val]), ("train", ids[n_val:])):
        arr = np.fromiter((t for seq in chunk for t in seq), dtype=np.uint16)
        arr.tofile(DATA_DIR / f"{split}.bin")
        print(f"{split}: {len(arr):,} tokens")


if __name__ == "__main__":
    main()
