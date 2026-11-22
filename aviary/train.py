"""Train one of the Aviary models from scratch (or keep training it with --resume).

Usage:  python train.py wren --minutes 30
        python train.py wren --minutes 60 --resume
"""
import argparse
import math
import time

import numpy as np
import torch

from models import (DATA_DIR, GPT, LINEUP, arch, ckpt_path, load_model, pick_device,
                    read_meta, save_checkpoint)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("model", choices=LINEUP)
    ap.add_argument("--minutes", type=float, default=30, help="how long to train")
    ap.add_argument("--batch", type=int, default=32)
    ap.add_argument("--lr", type=float, default=1e-3)
    ap.add_argument("--resume", action="store_true", help="continue from the saved checkpoint")
    ap.add_argument("--eval-every", type=int, default=200)
    args = ap.parse_args()

    if not (DATA_DIR / "train.bin").exists():
        raise SystemExit("No training data yet - run: python prepare_data.py")
    device = pick_device()
    torch.manual_seed(0)
    train = np.memmap(DATA_DIR / "train.bin", dtype=np.uint16, mode="r")
    val = np.memmap(DATA_DIR / "val.bin", dtype=np.uint16, mode="r")

    prev = read_meta(args.model) if args.resume else None
    if args.resume and ckpt_path(args.model).exists():
        model = load_model(args.model, device).train()
    else:
        model = GPT(**arch(args.model)).to(device)
        prev = None
    T = model.block_size
    print(f"{args.model}: {model.n_params() / 1e6:.1f}M parameters on {device}, "
          f"{len(train) / 1e6:.1f}M training tokens, {args.minutes:g} min budget", flush=True)

    def batch(data, gen=None):
        ix = torch.randint(len(data) - T - 1, (args.batch,), generator=gen)
        x = torch.stack([torch.from_numpy(data[i:i + T].astype(np.int64)) for i in ix])
        y = torch.stack([torch.from_numpy(data[i + 1:i + T + 1].astype(np.int64)) for i in ix])
        return x.to(device), y.to(device)

    @torch.no_grad()
    def evaluate():
        model.eval()
        gen = torch.Generator().manual_seed(1)  # same validation batches every time
        loss = sum(model(*batch(val, gen))[1].item() for _ in range(20)) / 20
        model.train()
        return loss

    opt = torch.optim.AdamW(model.parameters(), lr=args.lr, betas=(0.9, 0.95), weight_decay=0.1)
    budget = args.minutes * 60
    best = prev["val_loss"] if prev else float("inf")
    start, step, last_saved = time.time(), 0, None

    def save(val_loss):
        nonlocal last_saved
        last_saved = step
        save_checkpoint(args.model, model, {
            "name": args.model,
            "params": model.n_params(),
            "val_loss": round(val_loss, 4),
            "steps": step + (prev["steps"] if prev else 0),
            "minutes": round((time.time() - start) / 60 + (prev["minutes"] if prev else 0), 1),
            "device": device,
            "trained_on": time.strftime("%Y-%m-%d"),
        })

    while True:
        elapsed = time.time() - start
        done = elapsed >= budget
        if step % args.eval_every == 0 or done:
            val_loss = evaluate()
            tag = ""
            if val_loss < best:
                best = val_loss
                save(val_loss)
                tag = "  (saved)"
            print(f"step {step:6d}  {elapsed / 60:5.1f} min  val loss {val_loss:.3f}{tag}", flush=True)
        if done:
            break
        progress = min(1.0, elapsed / budget)
        lr = args.lr * min(1.0, (step + 1) / 100) * (0.1 + 0.45 * (1 + math.cos(math.pi * progress)))
        for group in opt.param_groups:
            group["lr"] = lr
        _, loss = model(*batch(train))
        opt.zero_grad(set_to_none=True)
        loss.backward()
        torch.nn.utils.clip_grad_norm_(model.parameters(), 1.0)
        opt.step()
        step += 1

    print(f"Done. Best val loss {best:.3f}. "
          + ("Checkpoint saved - start the app with: python serve.py" if last_saved is not None
             else "No improvement over the existing checkpoint, which was kept."), flush=True)


if __name__ == "__main__":
    main()
