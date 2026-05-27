#!/usr/bin/env python3
"""
Persistent Python worker for the Wavely pipeline.

A long-lived Python process that dispatches per-stage work to module-level
`run(argv)` functions. Replacing per-stage `python3 <script>.py` invocations
with calls into this worker amortizes interpreter startup, torch/numpy
imports, and (where the script caches them) model weights across the whole
pipeline run.

Protocol — newline-delimited JSON on stdin (in) and stdout (out):

  Request:   {"id": "<uuid>", "script": "<module_name>", "args": ["--input", "..."]}
  Success:   {"id": "<uuid>", "ok": true, "result": <jsonable>}
  Failure:   {"id": "<uuid>", "ok": false, "error": "...", "traceback": "..."}

  Control requests (script name starts with "__"):
    {"script": "__ping__"}      -> {"ok": true, "result": {"pid": ...}}
    {"script": "__shutdown__"}  -> exits with code 0

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


def _dispatch(script, argv):
    """Run the named script's `run(argv)` and return its result (a dict)."""
    if script == '__ping__':
        return {'pid': os.getpid()}
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
