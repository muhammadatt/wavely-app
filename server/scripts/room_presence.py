"""
room_presence_ir.py
Wavely — Room Presence Stage (Convolution Reverb)

Replaces the algorithmic reverb with IR-based convolution using a .wir file.
.wir files are standard WAV audio with a renamed extension and can be read
directly by soundfile.

Config block (matches existing roomPresence shape):

    roomPresence: {
      enabled: true,
      ir_path: "/path/to/your/room.wir",   # required
      wet: 0.10,                            # wet/dry ratio
      rt60Ms: 100,                          # hard trim ceiling on IR tail
      preDelayMs: 10.0,                     # zero-pad before IR onset
      early_reflections: 2,                 # onset ramp (1=sharp, 5=gradual)
      normalize_ir: true,                   # normalize IR peak to 0dBFS before use
    }
"""

import os
import numpy as np
import soundfile as sf
from scipy.signal import fftconvolve, resample_poly
from math import gcd

_SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))


def generate_synthetic_ir(sr: int, rt60_ms: float, diffusion: float = 0.7) -> np.ndarray:
    """
    Generate a simple exponentially-decaying noise IR when no .wir file is available.

    diffusion (0.0–1.0) controls tail density: low values give sparse early
    reflections; high values give a denser, smoother tail.
    """
    rng = np.random.default_rng(seed=42)
    n_samples = max(1, int(sr * rt60_ms / 1000))

    # White noise base
    noise = rng.standard_normal(n_samples)

    # Exponential decay: 60 dB over rt60_ms → decay constant = ln(1000)/n_samples
    decay = np.exp(-np.linspace(0, 6.9078, n_samples))  # 6.9078 ≈ ln(1000)
    ir = noise * decay

    # diffusion: low-pass filter the tail for higher values (smoother, denser)
    if diffusion > 0:
        from scipy.signal import butter, sosfilt
        cutoff = 4000 + (1.0 - diffusion) * 16000  # 4–20 kHz as diffusion→0
        sos = butter(2, cutoff / (sr / 2), btype='low', output='sos')
        ir = sosfilt(sos, ir)

    return ir.astype(np.float64)


def load_ir(ir_path: str, target_sr: int) -> np.ndarray:
    """
    Load a .wir (or .wav) impulse response file and resample to target_sr
    if necessary. Returns a mono float64 IR array.

    Relative paths are resolved against the script's own directory so that
    paths like "../ir/room.ir" work regardless of the Node server's CWD.

    Falls back to interpreting the file as raw float32 mono at target_sr when
    libsndfile cannot identify a container format (headerless IR files).
    """
    if not os.path.isabs(ir_path):
        ir_path = os.path.normpath(os.path.join(_SCRIPT_DIR, ir_path))
    try:
        ir, ir_sr = sf.read(ir_path, always_2d=False)
        print(f"[room-presence] IR: file — {os.path.basename(ir_path)} "
              f"({len(ir) if ir.ndim == 1 else ir.shape[0]} samples @ {ir_sr} Hz)", flush=True)
    except Exception:
        # No recognised audio container — try interpreting as raw float32 mono.
        raw = np.fromfile(ir_path, dtype=np.float32)
        finite_count = np.sum(np.isfinite(raw))
        finite_ratio = finite_count / max(len(raw), 1)
        # Require ≥95 % finite values and a max amplitude ≤ 2.0 (normalised audio).
        if finite_ratio >= 0.95 and np.max(np.abs(raw[np.isfinite(raw)]), initial=0) <= 2.0:
            ir = raw.astype(np.float64)
            ir_sr = target_sr
            print(f"[room-presence] {os.path.basename(ir_path)}: no audio header — "
                  f"loaded as raw float32 mono ({len(ir)} samples @ {ir_sr} Hz)", flush=True)
        else:
            raise RuntimeError(
                f"{os.path.basename(ir_path)}: not a recognised audio file and raw float32 "
                f"interpretation is invalid ({len(raw) - finite_count}/{len(raw)} NaN/Inf values, "
                f"max amplitude {np.max(np.abs(raw[np.isfinite(raw)]), initial=0):.2e}). "
                f"Please supply a WAV-format IR file."
            )

    # Collapse to mono if stereo (average channels)
    if ir.ndim == 2:
        ir = np.mean(ir, axis=1)

    # Resample if sample rates differ
    if ir_sr != target_sr:
        g = gcd(ir_sr, target_sr)
        ir = resample_poly(ir, target_sr // g, ir_sr // g)

    return ir.astype(np.float64)


def prepare_ir(
    ir: np.ndarray,
    sr: int,
    rt60_ms: float,
    pre_delay_ms: float,
    early_reflections: int,
    normalize: bool = True,
) -> np.ndarray:
    """
    Shape the raw IR according to the roomPresence config parameters.

    Steps:
      1. Normalize peak to 0 dBFS (optional)
      2. Hard-trim to rt60_ms ceiling
      3. Apply cosine fade-out over the last 10% to avoid a click at the trim point
      4. Prepend pre_delay_ms of silence
      5. Apply a short onset ramp controlled by early_reflections
    """
    # 1. Normalize
    peak = np.max(np.abs(ir))
    if normalize and peak > 1e-9:
        ir = ir / peak

    # 2. Hard trim to rt60_ms
    trim_samples = int(sr * rt60_ms / 1000)
    if len(ir) > trim_samples:
        ir = ir[:trim_samples]

    # 3. Cosine fade-out over the last 10% (avoids click at trim boundary)
    fade_len = max(1, len(ir) // 10)
    fade_curve = 0.5 * (1 + np.cos(np.linspace(0, np.pi, fade_len)))
    ir[-fade_len:] *= fade_curve

    # 4. Pre-delay: prepend silence
    pre_delay_samples = int(sr * pre_delay_ms / 1000)
    if pre_delay_samples > 0:
        ir = np.concatenate([np.zeros(pre_delay_samples), ir])

    # 5. Onset ramp (early_reflections: 1 = 1ms sharp, 5 = 5ms gradual)
    #    This softens the unnatural "instant-slam" of direct reflections.
    ramp_ms = max(0.5, early_reflections * 1.0)  # 1ms per unit
    ramp_samples = int(sr * ramp_ms / 1000)
    ramp_start = pre_delay_samples  # ramp begins after the pre-delay silence
    ramp_end = ramp_start + ramp_samples
    if ramp_end <= len(ir):
        ramp_curve = np.sin(np.linspace(0, np.pi / 2, ramp_samples))
        ir[ramp_start:ramp_end] *= ramp_curve

    return ir


def apply_room_presence_ir(
    audio: np.ndarray,
    sr: int,
    config: dict,
    _out_info: dict = None,
) -> np.ndarray:
    """
    Main entry point. Convolves audio with the shaped IR and returns
    the wet/dry mix, trimmed to the original signal length.

    Args:
        audio:      1D float64 numpy array (mono, already processed by prior stages)
        sr:         Sample rate of audio
        config:     roomPresence config dict (see module docstring)
        _out_info:  Optional dict populated with ir_source / ir_file for the caller.

    Returns:
        1D float64 numpy array, same length as input
    """
    if not config.get("enabled", True):
        return audio

    ir_path = config.get("ir_path")
    wet = float(config.get("wet", 0.10))
    rt60_ms = float(config.get("rt60Ms", 100))
    pre_delay_ms = float(config.get("preDelayMs", 10.0))
    early_reflections = int(config.get("early_reflections", 2))
    normalize_ir = bool(config.get("normalize_ir", True))
    diffusion = float(config.get("diffusion", 0.7))

    # Load IR from file, or generate a synthetic one when no path is supplied.
    # If the file exists but cannot be read as valid audio, fall back to synthetic
    # rather than letting garbage values propagate into the convolution.
    if ir_path:
        try:
            ir_raw = load_ir(ir_path, sr)
            if _out_info is not None:
                _out_info['ir_source'] = 'file'
                _out_info['ir_file']   = os.path.basename(ir_path)
        except Exception as e:
            print(f"[room-presence] IR: file load failed ({e})", flush=True)
            print(f"[room-presence] IR: synthetic fallback (rt60={rt60_ms}ms, diffusion={diffusion})", flush=True)
            ir_raw = generate_synthetic_ir(sr, rt60_ms, diffusion)
            if _out_info is not None:
                _out_info['ir_source'] = 'synthetic_fallback'
    else:
        print(f"[room-presence] IR: synthetic (rt60={rt60_ms}ms, diffusion={diffusion})", flush=True)
        ir_raw = generate_synthetic_ir(sr, rt60_ms, diffusion)
        if _out_info is not None:
            _out_info['ir_source'] = 'synthetic'
    ir = prepare_ir(
        ir_raw,
        sr,
        rt60_ms=rt60_ms,
        pre_delay_ms=pre_delay_ms,
        early_reflections=early_reflections,
        normalize=normalize_ir,
    )

    # FFT convolution — fast even at 44100Hz; 100ms IR = 4410 taps
    reverb_full = fftconvolve(audio, ir, mode="full")

    # Trim to original signal length (discard the reverb "tail" beyond input end)
    reverb = reverb_full[: len(audio)]

    # Gain-compensate the wet signal so wet=1.0 matches dry loudness
    # (convolution with a normalized IR can still add ~6dB depending on IR density)
    rms_dry = np.sqrt(np.mean(audio ** 2)) + 1e-9
    rms_rev = np.sqrt(np.mean(reverb ** 2)) + 1e-9
    reverb *= rms_dry / rms_rev

    # Wet/dry blend
    return (1.0 - wet) * audio + wet * reverb


# ---------------------------------------------------------------------------
# CLI entry point — called by the Node pipeline via spawnPython
# ---------------------------------------------------------------------------
if __name__ == "__main__":
    import argparse

    parser = argparse.ArgumentParser(description="Room Presence (convolution reverb)")
    parser.add_argument("--input",             required=True,  help="Input WAV path")
    parser.add_argument("--output",            required=True,  help="Output WAV path")
    parser.add_argument("--ir-path",           default=None,   help="Impulse response file (.wir/.wav); omit to use synthetic IR")
    parser.add_argument("--wet",               type=float, default=0.10)
    parser.add_argument("--rt60-ms",           type=float, default=100.0)
    parser.add_argument("--pre-delay-ms",      type=float, default=10.0)
    parser.add_argument("--early-reflections", type=int,   default=2)
    parser.add_argument("--diffusion",         type=float, default=0.7,  help="Tail density for synthetic IR (0.0–1.0)")
    parser.add_argument("--normalize-ir",      action="store_true", default=True)
    parser.add_argument("--result-path",       default=None,   help="Path to write JSON result (ir_source etc.)")
    args = parser.parse_args()

    input_path  = args.input
    output_path = args.output
    ir_path     = args.ir_path

    audio, sr = sf.read(input_path, always_2d=False)
    if audio.ndim == 2:
        audio = np.mean(audio, axis=1)
    audio = audio.astype(np.float64)

    config = {
        "enabled": True,
        "ir_path": ir_path,
        "wet": args.wet,
        "rt60Ms": args.rt60_ms,
        "preDelayMs": args.pre_delay_ms,
        "early_reflections": args.early_reflections,
        "diffusion": args.diffusion,
        "normalize_ir": args.normalize_ir,
    }

    ir_info = {}
    result = apply_room_presence_ir(audio, sr, config, _out_info=ir_info)

    # Prevent clipping before write
    peak = np.max(np.abs(result))
    if peak > 0.99:
        result *= 0.99 / peak

    sf.write(output_path, result, sr, subtype="PCM_24")
    print(f"Written: {output_path}")
    print(f"Settings: wet={config['wet']}, rt60Ms={config['rt60Ms']}ms, "
          f"preDelayMs={config['preDelayMs']}ms, "
          f"early_reflections={config['early_reflections']}")

    if args.result_path:
        import json
        with open(args.result_path, "w") as _f:
            json.dump(ir_info, _f)