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
import logging
import os
import sys
import traceback


# Route Python logging at INFO to stderr so dispatched scripts' logger.info()
# calls reach the JS-side log stream. Without this the root logger keeps its
# default WARNING level and every logger.info() emitted by a script run via
# this worker is silently dropped -- whereas the same script invoked through
# the legacy spawn path sees its CLI shim's `logging.basicConfig(level=INFO)`
# under `if __name__ == "__main__"` and logs normally. Configuring once here
# matches that behaviour for the worker path. Stderr is reserved as the
# worker's log channel (stdout is the JSON protocol); pythonWorker.js prefixes
# stderr lines with `[python]` before forwarding them to the server log.
logging.basicConfig(level=logging.INFO, stream=sys.stderr, format='%(message)s')


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


def _apply_thread_limits(threads):
    """
    Set thread caps for the current request across all relevant pools:
    torch's intra-op pool AND the underlying OMP / MKL / OpenBLAS pools
    that BLAS-heavy work (Conv layers in DF3, numpy matmul, etc.) actually
    uses.

    Constraining only torch.set_num_threads() leaves OMP/MKL at whatever
    env-default the worker spawned with — so a chunked dispatch that drops
    torch to 2 but leaves OMP at 6 still oversubscribes when multiple
    workers run concurrently. threadpoolctl provides a uniform runtime
    interface for all three backends and is the de-facto standard fix.

    ⚠ KNOWN LIMITATION — DeepFilterNet3 ignores this.

    The torch / MKL / OpenMP pools that DF3 uses get pinned at the
    spawn-time env values when DF3 first runs inference (model load +
    first forward pass). Runtime calls to torch.set_num_threads() and
    threadpoolctl.threadpool_limits() succeed without error but don't
    shrink the already-spawned worker threads. Verified empirically:
    TORCH_NUM_THREADS=6 + per-call=2 still produced 6-thread DF3
    behaviour and severe oversubscription with concurrent workers.

    For DF3 specifically, the only effective control is TORCH_NUM_THREADS
    at worker spawn (env var, applied before first inference). For other
    stages (RNNoise, click_remover, numpy/scipy work) the runtime path
    here is fully effective.

    See pythonWorker.js header and the GitHub issue tracking a future
    fix for this — a two-pool architecture (separate workers for chunked
    vs serial dispatch) is the likely path forward when serial-stage
    throughput at low env thread counts becomes a measured bottleneck.

    When `threads` is None we restore the worker's captured env-default
    (the value torch reported on first call, which equals the spawn-time
    OMP/MKL/TORCH env var). Without this restore step, a low-thread
    chunked dispatch would leak its setting into the next serial call.

    Records the requested value in `_LAST_THREADS_HINT` regardless of
    whether torch or threadpoolctl are available; __ping__ echoes this
    back so tests can verify the threading wiring without depending on
    either package being installed.

    No-op for any backend that isn't loaded — some scripts don't use
    torch; threadpoolctl is optional.
    """
    global _DEFAULT_TORCH_THREADS, _LAST_THREADS_HINT
    _LAST_THREADS_HINT = threads

    # Capture the env-default thread count on first call so omitted-threads
    # requests can restore to it.
    if _DEFAULT_TORCH_THREADS is None:
        try:
            import torch
            _DEFAULT_TORCH_THREADS = torch.get_num_threads()
        except ImportError:
            # No torch — fall back to the OMP env var that the JS-side
            # spawned the worker with. Defaults to 1 if even that's absent.
            _DEFAULT_TORCH_THREADS = int(os.environ.get('OMP_NUM_THREADS', '1'))

    target = int(threads) if threads is not None else _DEFAULT_TORCH_THREADS

    # 1) Torch intra-op pool
    try:
        import torch
        if torch.get_num_threads() != target:
            torch.set_num_threads(target)
    except ImportError:
        pass
    except Exception as exc:  # noqa: BLE001 — best-effort hint
        print(f'[worker] torch.set_num_threads({target}) failed: {exc}',
              file=sys.stderr, flush=True)

    # 2) OMP / MKL / OpenBLAS / BLIS pools — runtime limit via threadpoolctl.
    # Without this, DF3's Conv ops still use the env-default OMP/MKL
    # thread count regardless of what torch was told. Constructing
    # threadpool_limits(limits=N) applies the cap immediately to every
    # loaded backend; the cap persists until the next call replaces it.
    try:
        from threadpoolctl import threadpool_limits
        threadpool_limits(limits=target)
    except ImportError:
        pass  # threadpoolctl not installed — torch-only is best effort
    except Exception as exc:  # noqa: BLE001
        print(f'[worker] threadpool_limits({target}) failed: {exc}',
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
            # dispatches, env-default for serial). When the `threads` field is
            # omitted, _apply_thread_limits(None) restores the worker's
            # captured env-default — without this restore step, a low-thread
            # chunked dispatch would leak its setting into the next serial
            # call. Constrains torch's intra-op pool AND the OMP/MKL/BLAS
            # pools underneath; without the latter, DF3's Conv ops still
            # use the env-default OMP threads regardless of torch's setting.
            # The worker is single-threaded over requests, so the set →
            # dispatch → next-set sequence never races.
            _apply_thread_limits(req.get('threads'))
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
