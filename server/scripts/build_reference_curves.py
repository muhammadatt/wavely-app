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
MIN_CORPUS_FILES = 8           # hard floor — see spec §A1
# Non-noise_eraser presets defined in src/audio/presets.js. noise_eraser is
# excluded — source separation invalidates corpus comparison.
PRESETS        = ['acx_audiobook', 'podcast_ready', 'general_clean']

# Repository-relative defaults. This script lives in server/scripts/.
_SCRIPT_DIR  = os.path.dirname(os.path.abspath(__file__))
_REPO_ROOT   = os.path.normpath(os.path.join(_SCRIPT_DIR, '..', '..'))
DEFAULT_CORPUS_DIR = os.path.join(_REPO_ROOT, 'data', 'corpus')
DEFAULT_OUTPUT_DIR = os.path.join(_REPO_ROOT, 'data', 'reference_curves')

# WAV only — _load_audio reads via scipy.io.wavfile, which does not decode
# other container formats. Convert corpus audio to WAV before building.
AUDIO_EXTS = ('.wav',)


def build_preset_curve(preset_id, corpus_dir, output_dir):
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
    spread = levels_p75 - levels_p25
    wide   = [int(THIRD_OCTAVE_CENTERS[i]) for i in np.where(spread > 4.0)[0]]
    if wide:
        logger.warning('[%s] wide corpus spread (P75-P25 > 4 dB) at %s Hz — '
                        'review corpus for outliers', preset_id, wide)

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
    args = parser.parse_args()

    targets = [args.preset] if args.preset else PRESETS
    built   = sum(build_preset_curve(p, args.corpus_dir, args.output_dir) for p in targets)
    logger.info('Built %d/%d reference curve(s).', built, len(targets))
    sys.exit(0 if built == len(targets) else 1)
