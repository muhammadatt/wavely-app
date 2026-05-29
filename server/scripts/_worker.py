#!/usr/bin/env python3
"""
Persistent Python worker for the Wavely pipeline.

A long-lived Python process that dispatches per-stage work to module-level
`run(argv)` functions. Replacing per-stage `python3 <script>.py` invocations
with calls into this worker amortizes interpreter startup, torch/numpy
imports, and (where the script caches them) model weights across the whole
pipeline run.

Protocol — newline-delimited JSON on stdin (in) and stdout (out):

  Request:   {"id": "<uuid>", "script": "<module_name>", "args": ["--input", "..."],
              "threads": 2}   # threads is optional; see below
  Success:   {"id": "<uuid>", "ok": true, "result": <jsonable>}
  Failure:   {"id": "<uuid>", "ok": false, "error": "...", "traceback": "..."}

  Control requests (script name starts with "__"):
    {"script": "__ping__"}      -> {"ok": true, "result": {"pid": ..., "torch_threads": ...}}
    {"script": "__shutdown__"}  -> exits with code 0

When the optional `threads` field is present, torch.set_num_threads(N) is
called before dispatching the script. This lets the JS side use a low
thread count for calls dispatched concurrently from a chunked block (where
multiple workers run in parallel) and the env-default high count for serial
calls (where only one worker is busy). The chunked runner threads this
value through via AsyncLocalStorage in threadingContext.js.

Anything written to stdout from inside a dispatched script is silently
redirected to stderr — stdout is reserved for the protocol. Scripts that
need to return structured data should `return` a dict from their `main()`
function (the dispatcher forwards it as the `result` field). Stderr is
the worker's "log channel" and the JS side streams it to the server log.
"""

import importlib
import io
import json
import os
import sys
import traceback


_LOADED_MODULES = {}


def _load(script_name):
    """Lazy-import a script module by name. Cached on success."""
    mod = _LOADED_MODULES.get(script_name)
    if mod is not None:
        return mod
    mod = importlib.import_module(script_name)
    _LOADED_MODULES[script_name] = mod
    return mod


_DEFAULT_TORCH_THREADS = None
_LAST_THREADS_HINT     = None  # most recent `threads` field seen (or None for env-default)


def _apply_torch_threads(threads):
    """
    Set torch's intra-op thread count for the current request. When
    `threads` is None we restore the worker's env-default value (captured
    on first call) — without this, a low-thread chunked dispatch would
    leak its setting into the next serial call.

    No-op when torch isn't installed (some scripts don't use it). Errors
    are swallowed because this is a hint, not a contract — a script that
    needs strict threading control can set its own value internally.

    Records the requested value in `_LAST_THREADS_HINT` regardless of
    whether torch is available; __ping__ echoes this back so tests can
    verify the threading wiring without depending on a torch install.
    """
    global _DEFAULT_TORCH_THREADS, _LAST_THREADS_HINT
    _LAST_THREADS_HINT = threads
    try:
        import torch
        if _DEFAULT_TORCH_THREADS is None:
            _DEFAULT_TORCH_THREADS = torch.get_num_threads()
        target = int(threads) if threads is not None else _DEFAULT_TORCH_THREADS
        if torch.get_num_threads() != target:
            torch.set_num_threads(target)
    except ImportError:
        return
    except Exception as exc:  # noqa: BLE001 — best-effort hint
        print(f'[worker] torch.set_num_threads({threads}) failed: {exc}',
              file=sys.stderr, flush=True)


def _dispatch(script, argv):
    """Run the named script's `run(argv)` and return its result (a dict)."""
    if script == '__ping__':
        out = {'pid': os.getpid(), 'last_threads_hint': _LAST_THREADS_HINT}
        # Report the current torch thread count too so tests with torch
        # installed can verify the setting actually took effect. Tests
        # without torch fall back to inspecting last_threads_hint.
        try:
            import torch
            out['torch_threads'] = torch.get_num_threads()
        except ImportError:
            pass
        return out
    if script == '__shutdown__':
        sys.exit(0)

    mod = _load(script)
    if not hasattr(mod, 'run'):
        raise RuntimeError(
            f"Script '{script}' does not expose a top-level run(argv) function. "
            "Refactor its main() to accept an argv list and add `def run(argv): return main(argv)`."
        )
    result = mod.run(argv or [])
    return result if result is not None else {}


def _write_response(real_stdout, payload):
    real_stdout.write(json.dumps(payload, default=str) + '\n')
    real_stdout.flush()


def main():
    # Reserve stdout for protocol traffic. Redirect any script-level print()
    # to stderr so log messages don't corrupt the response stream.
    real_stdout = sys.stdout
    sys.stdout = sys.stderr

    # Announce readiness on stderr (visible to JS log stream, ignored by protocol).
    print(f'[worker] ready pid={os.getpid()}', file=sys.stderr, flush=True)

    for raw_line in sys.stdin:
        line = raw_line.strip()
        if not line:
            continue

        req_id = None
        try:
            req = json.loads(line)
            req_id = req.get('id')
            script = req['script']
            argv   = req.get('args', [])
            if not isinstance(argv, list):
                raise TypeError(f"args must be a list of strings, got {type(argv).__name__}")
            # Apply the per-call thread hint before dispatching. Each request
            # carries its own desired thread count (low for chunked-block
            # dispatches, env-default for serial); requests with no `threads`
            # field leave the previously-set value in place — the worker is
            # single-threaded over requests so this never races.
            _apply_torch_threads(req.get('threads'))
            result = _dispatch(script, argv)
            _write_response(real_stdout, {'id': req_id, 'ok': True, 'result': result})
        except SystemExit:
            # __shutdown__ propagates up — let it exit cleanly.
            raise
        except BaseException as exc:
            _write_response(real_stdout, {
                'id': req_id,
                'ok': False,
                'error': f'{type(exc).__name__}: {exc}',
                'traceback': traceback.format_exc(),
            })

    # stdin closed — JS side has disconnected. Exit cleanly.
    print('[worker] stdin closed, exiting', file=sys.stderr, flush=True)


if __name__ == '__main__':
    main()
