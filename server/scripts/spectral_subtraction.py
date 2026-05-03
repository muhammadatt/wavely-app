#!/usr/bin/env python3
"""
MMSE Decision-Directed Spectral Subtraction Pre-Pass

Lightweight DSP pre-pass applied before the main ML noise reduction
(DeepFilterNet3, RNNoise, DTLN). Reduces diffuse noise and reverb energy,
lowering the problem complexity for the ML model and improving its output.

Algorithm: MMSE decision-directed Wiener gain + optional transient shaper,
computed in a single STFT pass. Musical noise prevention via:
  1. Decision-directed SNR estimation (alpha_dd) — temporally coherent gains
  2. Spectral floor (beta) — no bin ever reaches zero gain
  3. 3-bin frequency-axis median filter — kills isolated spectral spikes

Usage:
  python3 spectral_subtraction.py --input <path> --output <path>
    [--alpha-dd 0.98] [--beta 0.05] [--strength 1.0]
    [--transient-shaper] [--transient-max-reduction-db 6.0]

Input/output: 32-bit float PCM WAV at 44.1 kHz (pipeline internal format).
"""

import argparse
import sys
import warnings
warnings.filterwarnings('ignore')

import numpy as np

# STFT parameters — 2048-point FFT at 44.1 kHz gives ~46 ms resolution,
# adequate for voiced speech without over-smoothing transients.
N_FFT      = 2048
HOP_LENGTH = 512
PIPELINE_SR = 44100

# Noise estimator time constants (as recursive-average alpha).
# Speech frames: very slow adaptation so voiced energy is not mistaken for noise.
# Silence frames: faster adaptation to track room condition changes between phrases.
ALPHA_NOISE_SPEECH  = np.float32(0.99)
ALPHA_NOISE_SILENCE = np.float32(0.85)

# Energy-based VAD threshold: mean a posteriori SNR (gamma_mean) above this
# value classifies the frame as speech. 1.5 ≈ +1.8 dB above noise.
VAD_SNR_THRESHOLD = np.float32(1.5)

# ── Numba JIT (optional) ─────────────────────────────────────────────────────
# The MMSE frame loop is sequential (each frame depends on the previous noise
# estimate) and dominates runtime on long files. Numba JIT compiles it to
# native code (~10-20x speedup). Falls back to vectorised NumPy when unavailable.

try:
    from numba import njit as _njit
    _HAS_NUMBA = True
except ImportError:
    _HAS_NUMBA = False


if _HAS_NUMBA:
    from numba import njit

    @njit(cache=True)
    def _mmse_loop(mag, n_frames, n_bins, alpha_dd, beta,
                   alpha_noise_speech, alpha_noise_silence, vad_snr_threshold):
        """
        MMSE decision-directed Wiener gain — Numba JIT implementation.

        Decision-directed estimator (Ephraim & Malah 1984):
          xi[t] = alpha_dd * |G[t-1]·Y[t-1]|² / λ[t]  +  (1−alpha_dd) * max(γ[t]−1, 0)
          G[t]  = xi[t] / (xi[t] + 1)   ← Wiener gain, floored at beta

        mag   : (n_frames, n_bins) float32 — STFT magnitude
        returns gains (n_frames, n_bins) float32 in [beta, 1.0]
        """
        _ad   = np.float32(alpha_dd)
        _mad  = np.float32(1.0 - alpha_dd)
        _b    = np.float32(beta)
        _aSp  = np.float32(alpha_noise_speech)
        _aSi  = np.float32(alpha_noise_silence)
        _mSp  = np.float32(1.0 - alpha_noise_speech)
        _mSi  = np.float32(1.0 - alpha_noise_silence)
        _vth  = np.float32(vad_snr_threshold)
        _eps  = np.float32(1e-10)
        _one  = np.float32(1.0)
        _zero = np.float32(0.0)

        noise_est  = mag[0].copy()
        prev_clean = mag[0].copy()
        gains      = np.empty((n_frames, n_bins), dtype=np.float32)

        for t in range(n_frames):
            mag_t     = mag[t]
            gamma_sum = _zero

            for b in range(n_bins):
                lam   = noise_est[b] * noise_est[b] + _eps
                gamma_b = mag_t[b] * mag_t[b] / lam

                xi_dd = prev_clean[b] * prev_clean[b] / lam
                xi_sp = gamma_b - _one
                xi_sp = xi_sp if xi_sp > _zero else _zero
                xi    = _ad * xi_dd + _mad * xi_sp

                g = xi / (xi + _one)
                if g < _b:
                    g = _b

                gains[t, b]    = g
                prev_clean[b]  = g * mag_t[b]
                gamma_sum     += gamma_b

            # Energy-based VAD: mean a posteriori SNR
            is_speech = (gamma_sum / np.float32(n_bins)) > _vth

            if is_speech:
                for b in range(n_bins):
                    noise_est[b] = _aSp * noise_est[b] + _mSp * mag_t[b]
            else:
                for b in range(n_bins):
                    noise_est[b] = _aSi * noise_est[b] + _mSi * mag_t[b]

        return gains

else:
    def _mmse_loop(mag, n_frames, n_bins, alpha_dd, beta,
                   alpha_noise_speech, alpha_noise_silence, vad_snr_threshold):
        """
        MMSE decision-directed Wiener gain — vectorised NumPy fallback.
        Same algorithm as the Numba version; slower due to the Python for loop,
        but each iteration is fully vectorised over the frequency bins.
        """
        _ad  = np.float32(alpha_dd)
        _mad = np.float32(1.0 - alpha_dd)
        _b   = np.float32(beta)
        _aSp = np.float32(alpha_noise_speech)
        _aSi = np.float32(alpha_noise_silence)
        _mSp = np.float32(1.0 - alpha_noise_speech)
        _mSi = np.float32(1.0 - alpha_noise_silence)

        noise_est  = mag[0].copy()
        prev_clean = mag[0].copy()
        gains      = np.empty((n_frames, n_bins), dtype=np.float32)

        for t in range(n_frames):
            mag_t = mag[t]
            lam   = noise_est * noise_est + np.float32(1e-10)
            gamma = (mag_t * mag_t) / lam

            xi    = _ad * (prev_clean * prev_clean / lam) + _mad * np.maximum(gamma - 1.0, 0.0)
            g     = xi / (xi + 1.0)
            g     = np.maximum(g, _b)

            gains[t]   = g
            prev_clean = g * mag_t

            if float(gamma.mean()) > float(vad_snr_threshold):
                noise_est = _aSp * noise_est + _mSp * mag_t
            else:
                noise_est = _aSi * noise_est + _mSi * mag_t

        return gains


# ── Main entry point ─────────────────────────────────────────────────────────

def main():
    parser = argparse.ArgumentParser(description='MMSE spectral subtraction pre-pass')
    parser.add_argument('--input',                      required=True,
                        help='Input WAV (32-bit float, 44.1 kHz)')
    parser.add_argument('--output',                     required=True,
                        help='Output WAV (32-bit float, 44.1 kHz)')
    parser.add_argument('--alpha-dd',                   type=float, default=0.98,
                        help='Decision-directed smoothing factor (default 0.98)')
    parser.add_argument('--beta',                       type=float, default=0.05,
                        help='Spectral floor / minimum Wiener gain (default 0.05)')
    parser.add_argument('--strength',                   type=float, default=1.0,
                        help='Suppression strength 0–1 (default 1.0; 0 = bypass)')
    parser.add_argument('--transient-shaper',           action='store_true',
                        help='Enable transient shaper for inter-phrase reverb tail suppression')
    parser.add_argument('--transient-max-reduction-db', type=float, default=6.0,
                        help='Transient shaper maximum gain reduction in dB (default 6.0)')
    args = parser.parse_args()

    from scipy.io import wavfile

    sr, audio_np = wavfile.read(args.input)
    audio_np = audio_np.astype(np.float32)

    if audio_np.ndim == 1:
        out = _process_channel(audio_np, args, sr)
        wavfile.write(args.output, sr, out.astype(np.float32))
    else:
        # Stereo: process each channel independently to preserve spatial information
        ch0 = _process_channel(audio_np[:, 0], args, sr)
        ch1 = _process_channel(audio_np[:, 1], args, sr)
        wavfile.write(args.output, sr,
                      np.stack([ch0, ch1], axis=1).astype(np.float32))

    print(
        f'[spectral-sub] Done: alpha_dd={args.alpha_dd} beta={args.beta} '
        f'strength={args.strength} transient_shaper={args.transient_shaper} '
        f'numba={_HAS_NUMBA}',
        flush=True,
    )


# ── Per-channel processing ────────────────────────────────────────────────────

def _process_channel(audio, args, sr):
    """Full MMSE + optional transient shaper pass on a single audio channel."""
    from scipy.signal import stft, istft

    n_overlap = N_FFT - HOP_LENGTH

    # Forward STFT — boundary='reflect' avoids edge discontinuities; padded=True
    # ensures the full signal is covered even when len(audio) % HOP_LENGTH != 0.
    _, _, Zxx = stft(
        audio, fs=sr, window='hann',
        nperseg=N_FFT, noverlap=n_overlap,
        boundary='reflect', padded=True,
    )
    # Zxx: (n_bins, n_frames) complex64
    mag   = np.abs(Zxx).astype(np.float32)    # (n_bins, n_frames) — used for MMSE gain computation

    # Transpose to (n_frames, n_bins) for the sequential frame loop
    mag_T = np.ascontiguousarray(mag.T)
    n_frames, n_bins = mag_T.shape

    # ── MMSE Wiener gains ─────────────────────────────────────────────────────
    gains = _mmse_loop(
        mag_T, n_frames, n_bins,
        np.float32(args.alpha_dd),
        np.float32(args.beta),
        ALPHA_NOISE_SPEECH,
        ALPHA_NOISE_SILENCE,
        VAD_SNR_THRESHOLD,
    )  # (n_frames, n_bins)

    # 3-bin frequency-axis median filter: kills isolated spectral spikes that
    # survive the decision-directed estimator. Size (1,3) = 1 frame × 3 bins.
    gains = _median_filter_3bin(gains)

    # Blend MMSE gain with identity (passthrough) based on strength.
    # strength=0 → no processing; strength=1 → full MMSE suppression.
    if args.strength < 1.0:
        gains = np.float32(1.0) + np.float32(args.strength) * (gains - np.float32(1.0))

    # ── Transient shaper (optional, same STFT pass) ───────────────────────────
    if args.transient_shaper:
        t_gain = _compute_transient_gains(mag_T, sr, HOP_LENGTH,
                                          args.transient_max_reduction_db)
        # Scale transient gain by strength so strength=0 disables it fully
        if args.strength < 1.0:
            t_gain = np.float32(1.0) + np.float32(args.strength) * (t_gain - np.float32(1.0))
        gains *= t_gain[:, np.newaxis]   # broadcast to (n_frames, n_bins)

    # ── Reconstruct via ISTFT ─────────────────────────────────────────────────
    # Apply the real-valued gain directly to the complex STFT rather than
    # reconstructing via mag*exp(1j*phase). This avoids a redundant angle/exp
    # round-trip and eliminates numerical edge cases around near-zero magnitudes
    # where phase is poorly defined.
    gains_T = np.ascontiguousarray(gains.T)    # (n_bins, n_frames)
    Zxx_out = gains_T * Zxx                    # real × complex → complex (broadcast)

    _, out = istft(
        Zxx_out, fs=sr, window='hann',
        nperseg=N_FFT, noverlap=n_overlap,
        boundary=True,
    )
    # Fix output length to exactly match input. scipy.signal.istft may return
    # slightly more or slightly fewer samples than len(audio) depending on
    # boundary padding and hop alignment. Both cases must be handled: truncation
    # is not enough — if the output is shorter, downstream frame/VAD label
    # alignment breaks because the pipeline assumes sample count is stable after
    # analyzeFramesRaw.
    n_in  = len(audio)
    n_out = len(out)
    if n_out < n_in:
        out = np.pad(out, (0, n_in - n_out))
    elif n_out > n_in:
        out = out[:n_in]
    return out.astype(np.float32)


# ── DSP helpers ───────────────────────────────────────────────────────────────

def _median_filter_3bin(gains):
    """3-bin frequency-axis median filter over the gains array.

    Replaces each bin's gain with the median of itself and its two neighbours.
    Applied on the frequency axis only (size=(1,3)) so temporal coherence
    established by the decision-directed estimator is preserved.
    """
    from scipy.ndimage import median_filter
    return median_filter(gains, size=(1, 3), mode='reflect').astype(np.float32)


def _compute_transient_gains(mag_T, sr, hop_length, max_reduction_db):
    """Per-frame gain envelope for inter-phrase reverb tail suppression.

    Uses a peak-hold envelope with slow exponential decay (~300 ms). When the
    current frame energy drops more than ~12 dB below the held peak, additional
    gain reduction is applied. This targets the decaying reverb tail after a
    voiced phrase ends without touching the speech itself.

    Returns a (n_frames,) float32 array in [max_reduction_linear, 1.0].
    """
    # Frame energy: RMS of magnitude spectrum per frame
    frame_energy = np.sqrt(np.mean(mag_T ** 2, axis=1) + np.float32(1e-10))
    n_frames = len(frame_energy)

    # Frames per second at the configured hop length
    fps = sr / hop_length   # ~86.1 fps at 44.1 kHz / 512

    # Peak hold with ~300 ms exponential decay — long enough to span inter-word
    # gaps without decaying into a running phrase, short enough to release after
    # a genuine inter-phrase pause.
    decay_frames = max(int(0.30 * fps), 1)
    decay_coeff  = np.float32(np.exp(-1.0 / decay_frames))

    max_red_lin  = np.float32(10.0 ** (-max_reduction_db / 20.0))
    threshold    = np.float32(0.25)   # -12 dB below peak → begin attenuating

    peak    = frame_energy[0]
    t_gains = np.ones(n_frames, dtype=np.float32)

    for t in range(n_frames):
        e = frame_energy[t]
        if e > peak:
            peak = e              # Instantaneous attack — catch phrase onsets immediately
        else:
            peak = decay_coeff * peak   # Slow decay during reverb tail / silence

        if peak > np.float32(1e-8):
            ratio = e / peak
            if ratio < threshold:
                # Soft linear ramp: 1.0 at threshold, max_red_lin at 0.0
                g = ratio / threshold
                t_gains[t] = g * (np.float32(1.0) - max_red_lin) + max_red_lin

    return t_gains


if __name__ == '__main__':
    main()
