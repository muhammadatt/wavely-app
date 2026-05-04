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
  3. 5-bin frequency-axis median filter — kills isolated spectral spikes
  4. Temporal IIR gain smoothing — prevents frame-to-frame modulation artifacts

Usage:
  python3 spectral_subtraction.py --input <path> --output <path>
    [--alpha-dd 0.98] [--beta 0.15] [--strength 1.0]
    [--transient-shaper] [--transient-max-reduction-db 6.0]
    [--vad-labels <path-to-isSilence.json>]

Input/output: 32-bit float PCM WAV at 44.1 kHz (pipeline internal format).
"""

import argparse
import json as _json
import os as _os
import sys
import warnings
warnings.filterwarnings('ignore')

import numpy as np

# Loaded from the shared config so JS and Python always use the same value.
# To change the pipeline frame duration, edit server/config/frame_config.json.
_config_path = _os.path.join(_os.path.dirname(_os.path.abspath(__file__)), '..', 'config', 'frame_config.json')
with open(_config_path) as _f:
    PIPELINE_FRAME_S = _json.load(_f)['FRAME_DURATION_S']  # 0.025 s = 25 ms

# STFT parameters — 2048-point FFT at 44.1 kHz gives ~46 ms resolution,
# adequate for voiced speech without over-smoothing transients.
N_FFT      = 2048
HOP_LENGTH = 512
PIPELINE_SR = 44100

# Noise estimator time constants (as recursive-average alpha).
# Speech frames: very slow adaptation so voiced energy is not mistaken for noise.
# Silence frames: moderate adaptation to track room condition changes between
# phrases without absorbing transitional voiced frames into the noise estimate.
ALPHA_NOISE_SPEECH  = np.float32(0.99)
ALPHA_NOISE_SILENCE = np.float32(0.92)

# Speech-protective gain floor: voiced frames are full passthrough (1.0).
# Spectral subtraction cannot separate speech from noise within the same
# time-frequency bin — any gain < 1.0 on a voiced frame attenuates speech.
# DF3 downstream handles in-speech NR with a model that can actually do that.
BETA_SPEECH = np.float32(1.0)

# Voiced-mask expansion applied after loading Silero labels.
# Silero labels are at 25 ms resolution (~2 STFT frames each at 86 fps).
# At a voiced/silence boundary the label can be up to one 25 ms frame late.
#
# PRE_ROLL extends the voiced region backward from each voiced onset — covers
# the worst-case 25 ms label latency at the start of a phrase.
# POST_ROLL extends it forward from each voiced offset — covers consonant tails
# and short within-phrase dips.
#
# At 44100 Hz / 512 hop ≈ 86 fps:
#   PRE_ROLL  = 3 frames ≈ 35 ms  (covers one full 25 ms Silero frame boundary)
#   POST_ROLL = 3 frames ≈ 35 ms
VAD_STFT_PRE_ROLL  = 3
VAD_STFT_POST_ROLL = 3

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
    def _mmse_loop(mag, n_frames, n_bins, alpha_dd, beta, beta_speech,
                   alpha_noise_speech, alpha_noise_silence, voiced_mask):
        """
        MMSE decision-directed Wiener gain — Numba JIT implementation.

        Decision-directed estimator (Ephraim & Malah 1984):
          xi[t] = alpha_dd * |G[t-1]·Y[t-1]|² / λ[t]  +  (1−alpha_dd) * max(γ[t]−1, 0)
          G[t]  = xi[t] / (xi[t] + 1)   ← Wiener gain, floored at beta

        Two gain floors per frame type:
          - beta        : silence frames — full noise suppression
          - beta_speech : speech frames — passthrough (1.0); DF3 handles in-speech NR

        voiced_mask[t] is a precomputed bool: True = voiced, False = silence.
        This is derived from Silero VAD labels when available, or from the
        energy-based fallback (_compute_voiced_mask_energy).

        mag          : (n_frames, n_bins) float32 — STFT magnitude
        voiced_mask  : (n_frames,) bool
        returns gains (n_frames, n_bins) float32 in [beta, 1.0]
        """
        _ad   = np.float32(alpha_dd)
        _mad  = np.float32(1.0 - alpha_dd)
        _b    = np.float32(beta)
        _bSp  = np.float32(beta_speech)
        _aSp  = np.float32(alpha_noise_speech)
        _aSi  = np.float32(alpha_noise_silence)
        _mSp  = np.float32(1.0 - alpha_noise_speech)
        _mSi  = np.float32(1.0 - alpha_noise_silence)
        _eps  = np.float32(1e-10)
        _one  = np.float32(1.0)
        _zero = np.float32(0.0)

        noise_est  = mag[0].copy()
        prev_clean = mag[0].copy()
        gains      = np.empty((n_frames, n_bins), dtype=np.float32)

        for t in range(n_frames):
            mag_t     = mag[t]
            in_speech = voiced_mask[t]
            floor     = _bSp if in_speech else _b

            for b in range(n_bins):
                lam     = noise_est[b] * noise_est[b] + _eps
                gamma_b = mag_t[b] * mag_t[b] / lam

                xi_dd = prev_clean[b] * prev_clean[b] / lam
                xi_sp = gamma_b - _one
                xi_sp = xi_sp if xi_sp > _zero else _zero
                xi    = _ad * xi_dd + _mad * xi_sp

                g = xi / (xi + _one)
                if g < floor:
                    g = floor

                gains[t, b]   = g
                # prev_clean tracks actual output so the decision-directed
                # estimator's prior is consistent with the gain we applied.
                prev_clean[b] = g * mag_t[b]

            # Noise estimator: slow adaptation during speech to prevent voiced
            # energy bleeding into the noise estimate.
            if in_speech:
                for b in range(n_bins):
                    noise_est[b] = _aSp * noise_est[b] + _mSp * mag_t[b]
            else:
                for b in range(n_bins):
                    noise_est[b] = _aSi * noise_est[b] + _mSi * mag_t[b]

        return gains

else:
    def _mmse_loop(mag, n_frames, n_bins, alpha_dd, beta, beta_speech,
                   alpha_noise_speech, alpha_noise_silence, voiced_mask):
        """
        MMSE decision-directed Wiener gain — vectorised NumPy fallback.
        Same algorithm as the Numba version; slower due to the Python for loop,
        but each iteration is fully vectorised over the frequency bins.

        voiced_mask : (n_frames,) bool — precomputed speech/silence labels.
        """
        _ad  = np.float32(alpha_dd)
        _mad = np.float32(1.0 - alpha_dd)
        _b   = np.float32(beta)
        _bSp = np.float32(beta_speech)
        _aSp = np.float32(alpha_noise_speech)
        _aSi = np.float32(alpha_noise_silence)
        _mSp = np.float32(1.0 - alpha_noise_speech)
        _mSi = np.float32(1.0 - alpha_noise_silence)

        noise_est  = mag[0].copy()
        prev_clean = mag[0].copy()
        gains      = np.empty((n_frames, n_bins), dtype=np.float32)

        for t in range(n_frames):
            mag_t     = mag[t]
            in_speech = bool(voiced_mask[t])

            lam = noise_est * noise_est + np.float32(1e-10)
            xi  = _ad * (prev_clean * prev_clean / lam) + _mad * np.maximum(
                    (mag_t * mag_t) / lam - 1.0, 0.0)
            g   = np.maximum(xi / (xi + 1.0), _bSp if in_speech else _b)

            gains[t]   = g
            prev_clean = g * mag_t   # track actual output for next frame's DD prior

            if in_speech:
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
    parser.add_argument('--beta',                       type=float, default=0.15,
                        help='Spectral floor / minimum Wiener gain (default 0.15)')
    parser.add_argument('--strength',                   type=float, default=1.0,
                        help='Suppression strength 0–1 (default 1.0; 0 = bypass)')
    parser.add_argument('--transient-shaper',           action='store_true',
                        help='Enable transient shaper for inter-phrase reverb tail suppression')
    parser.add_argument('--transient-max-reduction-db', type=float, default=6.0,
                        help='Transient shaper maximum gain reduction in dB (default 6.0)')
    parser.add_argument('--vad-labels',                  default=None,
                        help='Path to JSON file with Silero isSilence labels (one bool per '
                             '25 ms pipeline frame). When provided, replaces the internal '
                             'energy-based VAD with the high-quality Silero classifications '
                             'already computed by the pipeline.')
    args = parser.parse_args()

    import json
    from scipy.io import wavfile

    # Load external Silero VAD labels if provided
    vad_labels = None
    if args.vad_labels:
        with open(args.vad_labels, 'r') as f:
            vad_labels = json.load(f)   # list[bool] — True = silence
        print(f'[spectral-sub] Loaded {len(vad_labels)} Silero VAD frames from '
              f'{args.vad_labels}', flush=True)

    sr, audio_np = wavfile.read(args.input)
    audio_np = audio_np.astype(np.float32)

    if audio_np.ndim == 1:
        out = _process_channel(audio_np, args, sr, vad_labels)
        wavfile.write(args.output, sr, out.astype(np.float32))
    else:
        # Stereo: process each channel independently to preserve spatial information
        ch0 = _process_channel(audio_np[:, 0], args, sr, vad_labels)
        ch1 = _process_channel(audio_np[:, 1], args, sr, vad_labels)
        wavfile.write(args.output, sr,
                      np.stack([ch0, ch1], axis=1).astype(np.float32))

    print(
        f'[spectral-sub] Done: alpha_dd={args.alpha_dd} beta={args.beta} '
        f'strength={args.strength} transient_shaper={args.transient_shaper} '
        f'numba={_HAS_NUMBA}',
        flush=True,
    )


# ── Per-channel processing ────────────────────────────────────────────────────

def _process_channel(audio, args, sr, vad_labels=None):
    """Full MMSE + optional transient shaper pass on a single audio channel.

    vad_labels : list of bool (isSilence) from the pipeline's Silero VAD pass,
                 or None to fall back to the internal energy-based VAD.
    """
    from scipy.signal import stft, istft

    # Guard: audio shorter than one FFT window cannot be meaningfully processed.
    # Return it unchanged rather than crashing in scipy.signal.stft.
    if len(audio) < N_FFT:
        print(f'[spectral-sub] WARNING: audio too short ({len(audio)} samples < '
              f'N_FFT={N_FFT}), returning unchanged', flush=True)
        return audio

    n_overlap = N_FFT - HOP_LENGTH

    # Forward STFT — boundary='even' (symmetric reflection) avoids edge
    # discontinuities; padded=True ensures the full signal is covered even
    # when len(audio) % HOP_LENGTH != 0.
    _, _, Zxx = stft(
        audio, fs=sr, window='hann',
        nperseg=N_FFT, noverlap=n_overlap,
        boundary='even', padded=True,
    )
    # Zxx: (n_bins, n_frames) complex64
    mag   = np.abs(Zxx).astype(np.float32)    # (n_bins, n_frames) — used for MMSE gain computation

    # Transpose to (n_frames, n_bins) for the sequential frame loop
    mag_T = np.ascontiguousarray(mag.T)
    n_frames, n_bins = mag_T.shape

    # ── Build voiced mask ────────────────────────────────────────────────────
    # Silero VAD labels are required.  Without them the stage cannot distinguish
    # speech from silence and must pass through unchanged to avoid attenuation.
    if vad_labels is None:
        print('[spectral-sub] WARNING: no VAD labels supplied — bypassing (no-op)', flush=True)
        return audio

    voiced_mask = _load_vad_labels(vad_labels, n_frames, HOP_LENGTH, sr)
    voiced_mask = _expand_voiced_mask(voiced_mask, VAD_STFT_PRE_ROLL, VAD_STFT_POST_ROLL)
    n_voiced = int(voiced_mask.sum())
    print(f'[spectral-sub] VAD: {len(vad_labels)} Silero frames -> {n_frames} STFT frames '
          f'({n_voiced} voiced, {n_frames - n_voiced} silence)', flush=True)

    # ── MMSE Wiener gains ─────────────────────────────────────────────────────
    gains = _mmse_loop(
        mag_T, n_frames, n_bins,
        np.float32(args.alpha_dd),
        np.float32(args.beta),
        BETA_SPEECH,
        ALPHA_NOISE_SPEECH,
        ALPHA_NOISE_SILENCE,
        voiced_mask,
    )  # (n_frames, n_bins)

    # 5-bin frequency-axis median filter: kills isolated spectral spikes that
    # survive the decision-directed estimator. Size (1,5) = 1 frame × 5 bins.
    gains = _median_filter_freq(gains)

    # Temporal gain smoothing: first-order IIR lowpass across frames.
    # Prevents rapid per-bin gain fluctuations that cause the characteristic
    # "watery" / "underwater" spectral subtraction artifact.  At ~86 fps
    # (44.1 kHz / 512 hop), alpha=0.85 gives a ~7-frame time constant (~80 ms)
    # — fast enough to track genuine speech/silence transitions, slow enough
    # to eliminate audible amplitude modulation.
    gains = _smooth_gains_temporal(gains, alpha=np.float32(0.85))

    # Restore voiced frames to exact passthrough after the temporal smoother.
    # The IIR carries low silence-mode gains (beta ≈ 0.15) forward into the
    # onset of every voiced passage — causing 6-8 dB attenuation for the first
    # ~200 ms of speech after each pause.  Voiced frames must always be 1.0
    # regardless of the smoother state; the smoother is only needed to suppress
    # musical noise within silence regions.
    gains[voiced_mask] = np.float32(1.0)

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

def _load_vad_labels(is_silence_list, n_stft_frames, hop_length, sr,
                     pipeline_frame_sec=PIPELINE_FRAME_S):
    """Map pipeline Silero VAD labels (25 ms frames) to STFT frame resolution.

    is_silence_list : list[bool] — True = silence, one entry per pipeline frame
    n_stft_frames   : number of STFT frames to produce
    hop_length      : STFT hop in samples
    sr              : sample rate
    pipeline_frame_sec : duration of each pipeline frame in seconds (from frame_config.json).

    Returns voiced_mask : np.ndarray[bool] of shape (n_stft_frames,)
    """
    stft_frame_sec  = hop_length / sr            # ~11.6 ms per STFT frame
    n_pipeline      = len(is_silence_list)
    voiced_mask     = np.empty(n_stft_frames, dtype=bool)

    for t in range(n_stft_frames):
        t_sec        = t * stft_frame_sec
        pipeline_idx = min(int(t_sec / pipeline_frame_sec), n_pipeline - 1)
        # isSilence=True → not voiced; isSilence=False → voiced
        voiced_mask[t] = not is_silence_list[pipeline_idx]

    return voiced_mask


def _expand_voiced_mask(voiced_mask, pre_roll, post_roll):
    """Expand voiced regions to compensate for Silero label resolution (25 ms).

    Silero labels switch state at 25 ms frame boundaries.  At a silence->voiced
    transition the label can be up to one full Silero frame (~2 STFT frames)
    late, causing the onset of a phrase to receive silence-mode suppression.

    pre_roll  : STFT frames to mark as voiced *before* each voiced onset.
    post_roll : STFT frames to mark as voiced *after* each voiced offset.

    Both passes reference the original mask so expansions don't chain.
    """
    n        = len(voiced_mask)
    expanded = voiced_mask.copy()

    # Post-roll: hold voiced state for post_roll frames after each voiced->silence edge
    countdown = 0
    for t in range(n):
        if voiced_mask[t]:
            countdown = post_roll
        elif countdown > 0:
            expanded[t] = True
            countdown  -= 1

    # Pre-roll: mark pre_roll frames before each silence->voiced edge as voiced
    countdown = 0
    for t in range(n - 1, -1, -1):
        if voiced_mask[t]:
            countdown = pre_roll
        elif countdown > 0:
            expanded[t] = True
            countdown  -= 1

    return expanded


def _median_filter_freq(gains):
    """5-bin frequency-axis median filter over the gains array.

    Replaces each bin's gain with the median of itself and its four neighbours.
    Applied on the frequency axis only (size=(1,5)) so temporal coherence
    established by the decision-directed estimator is preserved.  5 bins
    provides stronger musical noise suppression than 3 bins without noticeably
    smearing spectral detail at the 2048-point FFT resolution (~21 Hz/bin).
    """
    from scipy.ndimage import median_filter
    return median_filter(gains, size=(1, 5), mode='reflect').astype(np.float32)


def _smooth_gains_temporal(gains, alpha=np.float32(0.85)):
    """First-order IIR lowpass across frames (temporal axis).

    g_smooth[t] = alpha * g_smooth[t-1] + (1 - alpha) * g[t]

    This prevents rapid frame-to-frame gain changes in individual frequency
    bins — the primary cause of "watery" / "underwater" spectral subtraction
    artifacts.  The smoothing applies only along the time axis; frequency
    resolution is preserved.

    gains : (n_frames, n_bins) float32
    alpha : smoothing coefficient in (0, 1).  Higher = smoother / slower.
    returns smoothed gains (n_frames, n_bins) float32
    """
    smoothed = np.empty_like(gains)
    smoothed[0] = gains[0]
    one_minus_alpha = np.float32(1.0) - alpha
    for t in range(1, gains.shape[0]):
        smoothed[t] = alpha * smoothed[t - 1] + one_minus_alpha * gains[t]
    return smoothed


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
