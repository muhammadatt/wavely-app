"""
build_reference_curves.py
Offline corpus processor for referenceEQ.

Converts a curated set of professional recordings into one stored reference
curve per preset. Run this whenever the corpus changes — NOT on each server
start. Output is one JSON file per preset, committed to the repository; the
corpus audio itself is never committed.

Reference: referenceEQ stage spec v1.0, Part A
           (docs/instant_polish_reference_eq_spec.md).

Corpus layout (gitignored — see data/.gitignore):
    data/corpus/<preset_id>/*.wav

Output:
    data/reference_curves/<preset_id>.json

Usage:
    python build_reference_curves.py
    python build_reference_curves.py --preset acx_audiobook
    python build_reference_curves.py --corpus-dir <path> --output-dir <path>

Dependencies: numpy, scipy
"""

import argparse
import datetime
import json
import logging
import os
import sys

import numpy as np

from reference_eq import THIRD_OCTAVE_CENTERS, speech_spectrum, _load_audio

logger = logging.getLogger(__name__)

SPEC_VERSION   = '1.0'
MIN_CORPUS_FILES = 1          

PRESETS        = ['acx_audiobook', 'podcast_ready', 'general_clean', 'noise_eraser']

# Repository-relative defaults. This script lives in server/scripts/.
_SCRIPT_DIR  = os.path.dirname(os.path.abspath(__file__))
_REPO_ROOT   = os.path.normpath(os.path.join(_SCRIPT_DIR, '..', '..'))
DEFAULT_CORPUS_DIR = os.path.join(_REPO_ROOT, 'data', 'corpus')
DEFAULT_OUTPUT_DIR = os.path.join(_REPO_ROOT, 'data', 'reference_curves')

# WAV only — _load_audio reads via scipy.io.wavfile, which does not decode
# other container formats. Convert corpus audio to WAV before building.
AUDIO_EXTS = ('.wav',)


def _log_spread_diagnostic(preset_id, names, stack, wide_idx, median, p25, p75):
    """Per-file deviation from median at wide-spread bands. Sorted worst-first."""
    iqr   = p75 - p25
    lo,hi = p25 - 1.5 * iqr, p75 + 1.5 * iqr
    band_hz = [int(THIRD_OCTAVE_CENTERS[i]) for i in wide_idx]

    header  = '  '.join(f'{hz:>5d}' for hz in band_hz)
    lines   = [
        f'[{preset_id}] per-file deviation from median at wide bands '
        f'(dB; * = outside Tukey fence P25-1.5*IQR..P75+1.5*IQR):',
        f'  {"file":38s}  {header}    score',
    ]
    rows = []
    for name, lev in zip(names, stack):
        dev  = lev[wide_idx] - median[wide_idx]
        cells = '  '.join(
            f'{d:+5.1f}{"*" if (lev[i] < lo[i] or lev[i] > hi[i]) else " "}'
            for d, i in zip(dev, wide_idx)
        )
        score = float(np.nansum(np.abs(dev)))
        rows.append((score, f'  {name[:38]:38s}  {cells}    {score:6.1f}'))
    rows.sort(key=lambda r: -r[0])
    lines.extend(row for _, row in rows)
    logger.warning('\n'.join(lines))


def build_preset_curve(preset_id, corpus_dir, output_dir, diagnose_spread=False):
    """Build and write one preset's reference curve. Returns True on success."""
    preset_corpus = os.path.join(corpus_dir, preset_id)
    if not os.path.isdir(preset_corpus):
        logger.warning('[%s] no corpus directory at %s — skipped', preset_id, preset_corpus)
        return False

    files = sorted(
        os.path.join(preset_corpus, f)
        for f in os.listdir(preset_corpus)
        if f.lower().endswith(AUDIO_EXTS)
    )

    names   = []
    spectra = []
    for path in files:
        try:
            sr, audio = _load_audio(path)
        except Exception as err:  # noqa: BLE001 — corrupt corpus file, keep going
            logger.warning('[%s] could not read %s: %s', preset_id, path, err)
            continue
        # Corpus files have no pipeline noise floor — speech_spectrum derives a
        # 10th-percentile estimate when noise_floor_db is None.
        levels, n_speech = speech_spectrum(audio, sr, noise_floor_db=None)
        if levels is None:
            logger.warning('[%s] skipped %s — only %d speech frames',
                            preset_id, os.path.basename(path), n_speech)
            continue
        names.append(os.path.basename(path))
        spectra.append(levels)
        logger.info('[%s] measured %s (%d speech frames)',
                    preset_id, os.path.basename(path), n_speech)

    if len(spectra) < MIN_CORPUS_FILES:
        logger.error('[%s] only %d valid corpus spectra — need at least %d. Curve NOT written.',
                      preset_id, len(spectra), MIN_CORPUS_FILES)
        return False

    stack = np.vstack(spectra)
    with np.errstate(all='ignore'):
        reference_levels = np.nanmedian(stack, axis=0)
        levels_p25       = np.nanpercentile(stack, 25, axis=0)
        levels_p75       = np.nanpercentile(stack, 75, axis=0)

    # Spread diagnostic — a wide IQR means the median may not be representative.
    spread   = levels_p75 - levels_p25
    wide_idx = np.where(spread > 4.0)[0]
    if len(wide_idx):
        wide_hz = [int(THIRD_OCTAVE_CENTERS[i]) for i in wide_idx]
        logger.warning('[%s] wide corpus spread (P75-P25 > 4 dB) at %s Hz — '
                        'review corpus for outliers', preset_id, wide_hz)
        if diagnose_spread:
            _log_spread_diagnostic(preset_id, names, stack, wide_idx,
                                   reference_levels, levels_p25, levels_p75)

    # Preserve corpus_version across rebuilds: increment the existing value.
    out_path = os.path.join(output_dir, f'{preset_id}.json')
    corpus_version = 1
    if os.path.isfile(out_path):
        try:
            with open(out_path) as fh:
                corpus_version = int(json.load(fh).get('corpus_version', 0)) + 1
        except Exception:  # noqa: BLE001 — malformed prior file, restart at 1
            corpus_version = 1

    curve = {
        'preset':                preset_id,
        'spec_version':          SPEC_VERSION,
        'corpus_version':        corpus_version,
        'generated':             datetime.datetime.now(datetime.timezone.utc)
                                   .replace(microsecond=0).isoformat(),
        'n_corpus_files':        len(spectra),
        'normalization_band_hz': [800, 1200],
        'frequencies_hz':        [int(f) for f in THIRD_OCTAVE_CENTERS],
        'levels_db':             [round(float(v), 3) for v in reference_levels],
        'levels_db_p25':         [round(float(v), 3) for v in levels_p25],
        'levels_db_p75':         [round(float(v), 3) for v in levels_p75],
    }

    os.makedirs(output_dir, exist_ok=True)
    with open(out_path, 'w') as fh:
        json.dump(curve, fh, indent=2)
    logger.info('[%s] wrote %s (corpus_version=%d, %d files)',
                preset_id, out_path, corpus_version, len(spectra))
    return True


if __name__ == '__main__':
    logging.basicConfig(level=logging.INFO, stream=sys.stderr, format='%(message)s')
    parser = argparse.ArgumentParser(description='Build referenceEQ reference curves from a corpus')
    parser.add_argument('--preset', default=None,
                        help='Build only this preset (default: all non-noise_eraser presets)')
    parser.add_argument('--corpus-dir', default=DEFAULT_CORPUS_DIR,
                        help=f'Corpus root (default: {DEFAULT_CORPUS_DIR})')
    parser.add_argument('--output-dir', default=DEFAULT_OUTPUT_DIR,
                        help=f'Reference curve output directory (default: {DEFAULT_OUTPUT_DIR})')
    parser.add_argument('--diagnose-spread', action='store_true',
                        help='When the wide-spread warning fires, log a per-file '
                             'deviation table (sorted worst-first) to help identify outliers')
    args = parser.parse_args()

    targets = [args.preset] if args.preset else PRESETS
    built   = sum(build_preset_curve(p, args.corpus_dir, args.output_dir,
                                     diagnose_spread=args.diagnose_spread)
                  for p in targets)
    logger.info('Built %d/%d reference curve(s).', built, len(targets))
    sys.exit(0 if built == len(targets) else 1)
