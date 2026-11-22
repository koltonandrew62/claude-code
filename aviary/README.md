# Aviary

A family of small AI models built and trained from scratch, plus a chat page to talk to them.
Everything runs on your own computer: no API, no account, no usage limits, no cost per message.

## The models

All four share one design (a GPT-style transformer) and one tokenizer. Only the size differs.

| Model | Parameters | Reads | What it takes to train |
| --- | --- | --- | --- |
| **Wren** | 2.6M | 256 tokens | 30 to 60 minutes on a laptop CPU. A trained copy is included. |
| **Kestrel** | 12M | 256 tokens | A few hours on CPU, minutes on a GPU. |
| **Heron** | 28M | 512 tokens | Needs a GPU. |
| **Condor** | 89M | 1024 tokens | Needs a strong GPU and far more training data. |

## What to expect

These models learn one skill: you describe a Python function and they write it. They learn it from
Python code already on your computer (every function that has a description becomes one lesson).

They are tiny. The included Wren is roughly a million times smaller than a commercial assistant and was
trained for half an hour on a CPU. It writes Python that looks right and is often loosely on topic,
but it makes mistakes, does not hold a conversation, and cannot reason through a new problem. Bigger
models, more training time and more code to learn from all make it better; none of the four will come
close to a commercial assistant, which takes thousands of GPUs and a large share of the internet.

## Run it

```bash
python3 -m venv .venv
```

```bash
.venv/bin/pip install -r requirements.txt
```

```bash
.venv/bin/python serve.py
```

Then open http://127.0.0.1:8000. On Windows use `.venv\Scripts\python` instead of `.venv/bin/python`.

## Train your own

Build the lessons and the tokenizer (about a minute). Add `--src` folders to learn from more code:

```bash
.venv/bin/python prepare_data.py
```

Train a model for a set number of minutes. The best version so far is saved as it goes:

```bash
.venv/bin/python train.py wren --minutes 30
```

Keep training a model you already have:

```bash
.venv/bin/python train.py wren --minutes 60 --resume
```

The chat page picks up new and improved models without a restart; reload the page to refresh the list.

If you rebuild the tokenizer with `prepare_data.py`, retrain your models from scratch (without
`--resume`), because their vocabulary has changed. The included Wren was trained on Python's own
library plus the PyTorch package, so pass both folders to `--src` if you want to continue from it.

## Files

- `models.py`: the model family and the transformer itself
- `prepare_data.py`: turns Python code into lessons and builds the tokenizer
- `train.py`: the training loop
- `serve.py`: the local web server
- `web/index.html`: the chat page
- `checkpoints/`: trained models and the tokenizer
