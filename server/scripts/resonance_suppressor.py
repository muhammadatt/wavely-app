"""
resonance_suppressor.py
Dynamic Resonance Suppressor

Soothe2-inspired spectral spike detection and dynamic attenuation.
Operates on 32-bit float PCM at 44.1 kHz (Instant Polish internal format).

Scope: narrow resonant spike detection via within-frame cepstral liftering.
Catches room modes, microphone resonances, and isolated harmonic buildups
anywhere in the active frequency range.

Dependencies: numpy, scipy
All processing is frame-based via STFT/ISTFT with overlap-add reconstruction.
"""

import time

import numpy as np
from numpy.lib.stride_tricks import sliding_window_view
from scipy.signal import get_window
from scipy.ndimage import convolve1d
import logging

logger = logging.getLogger(__name__)


# ---------------------------------------------------------------------------
# JIT-compiled inner loops
# ---------------------------------------------------------------------------
# The attack/release IIR is genuinely serial (next state depends on previous
# state via a data-dependent coefficient) and the overlap-add accumulation
# has overlapping writes -- neither vectorises in numpy. Both are JITed via
# numba so the per-frame Python overhead disappears. Compiled artefacts are
# cached under server/scripts/__pycache__ so the ~3 s first-run compile is
# paid once per environment and reused across server restarts.
try:
    from numba import njit

    @njit(cache=True, fastmath=True)
    def _iir_attack_release(target_gr, prev_init, attack_coeff, release_coeff):
        """Per-bin attack/release IIR over a (n_frames, n_bins) chunk."""
        n_frames, n_bins = target_gr.shape
        out  = np.empty_like(target_gr)
        prev = prev_init.copy()
        for j in range(n_frames):
            for b in range(n_bins):
                t = target_gr[j, b]
                c = attack_coeff if t >= prev[b] else release_coeff
                prev[b] = c * prev[b] + (np.float32(1.0) - c) * t
                out[j, b] = prev[b]
        return out, prev

    @njit(cache=True, fastmath=True)
    def _overlap_add(time_frames, window_squared, output_buffer,
                     window_accumulator, frame_offset, hop, n_padded):
        """Accumulate windowed time-domain frames into the OLA buffers."""
        n_frames, n_fft = time_frames.shape
        for j in range(n_frames):
            s = (frame_offset + j) * hop
            e = s + n_fft
            if e > n_padded:
                e = n_padded
            trim = e - s
            for k in range(trim):
                output_buffer[s + k]      += time_frames[j, k]
                window_accumulator[s + k] += window_squared[k]

    _NUMBA_AVAILABLE = True
except ImportError:
    _NUMBA_AVAILABLE = False
    _iir_attack_release = None
    _overlap_add        = None
    logger.warning(
        "ResonanceSuppressor: numba not available, falling back to numpy loops."
    )


# ---------------------------------------------------------------------------
# Default parameters
# ---------------------------------------------------------------------------
# Single source of truth for every tunable. Per-preset overrides live in
# src/audio/presets.js as resonanceSuppressor blocks and are passed in via
# --params-json. Anything not specified there inherits from this dict.

DEFAULT_PARAMS = {
    "depth": 0.5,           # Global reduction scale (0.0-1.0).
    "sharpness": 0.5,       # Attenuation curve shape.
                            # 0.0 = wide gentle cuts (broad energy build-ups).
                            # 1.0 = deep narrow notches (precise resonances).
    "selectivity": 8.0,     # Spike threshold in dB above the cepstral inter-harmonic
                            # floor.  IMPORTANT: this reference is ~8–15 dB BELOW
                            # the spectral peak envelope, so selectivity must be set
                            # much higher than it would be for a mel-smoothed reference
                            # (which sits at the peaks).  8 dB catches genuine room
                            # modes and mic resonances (typically 8–20 dB above the
                            # floor) while leaving the normal ±3–5 dB inter-harmonic
                            # spectral variation untouched.  Do NOT lower below ~6 dB —
                            # values ≤ 3 dB will trigger on voiced speech excitation
                            # noise and produce broad, audible spectral thinning.
    "attack_ms": 15.0,      # Gain reduction onset speed.
    "release_ms": 80.0,     # Gain reduction recovery speed.
    "max_reduction_db": 9.0,# Hard ceiling on reduction at any bin.
    "freq_floor_hz": 80.0,  # Don't process below this (HPF already handles sub-vocals).
    "freq_ceil_hz": 16000.0,# Don't process above this.
    "mode": "soft",         # "soft" = gradual knee; "hard" = linear above threshold.
    "preserve_harmonics": True,   # Protect harmonic overtone bins from reduction.
                                  # Must be True in production: cepstral liftering
                                  # places the reference at the inter-harmonic floor,
                                  # so vocal harmonics protrude above it and will be
                                  # attenuated unless this mask is active.
                                  # Set False only for testing / diagnostic runs.
    "harmonic_width_bins": 2,     # Minimum half-width of the protection zone (STFT
                                  # bins; 1 bin ≈ 21.5 Hz at 44.1 kHz / n_fft=2048).
                                  # 3 bins (≈ 64 Hz) provides margin for autocorrelation
                                  # lag quantization error in the per-frame F0 contour.
                                  # The rolling F0 is updated every 3rd voiced frame and
                                  # forward-filled between updates; a 3-step lag drift
                                  # at f0≈188 Hz can shift H10 by up to ~48 Hz. A 2-bin
                                  # (43 Hz) zone is too tight to absorb this drift,
                                  # leaving those bins unprotected on affected frames.
                                  # 3 bins (64 Hz) covers the worst-case drift while
                                  # leaving ~60 Hz of inter-harmonic space per gap at
                                  # 188 Hz — sufficient for room mode detection.
                                  # harmonic_width_pct takes over above ~H20.
    "harmonic_width_pct": 0.01,   # Protection half-width as a fraction of the overtone
                                  # frequency (1 %). With a per-frame F0 contour the
                                  # old 3 % value was compensating for pitch drift across
                                  # frames — that is now handled by the contour itself.
                                  # 1 % retains margin for F0 estimation quantization
                                  # error at high harmonics (where lag rounding compounds)
                                  # without over-protecting inter-harmonic spectrum.
                                  # Whichever of harmonic_width_bins or harmonic_width_pct
                                  # produces more bins wins.
    "max_harmonic": 100,          # Hard cap on overtones to protect (H1 … H<n>).
                                  # In practice freq_ceil_hz is the binding limit —
                                  # this cap only matters for pathologically low f0.
    "lifter_cutoff_bins": None,   # Optional hard override for the cepstral lifter
                                  # cutoff (samples).  When None the cutoff is derived
                                  # from f0: max(20, int(0.40 * sr / f0)).
                                  # Set to a small value (3–5) to produce a nearly flat
                                  # reference that exposes broad spectral elevations
                                  # (e.g. sibilant plateaux spanning 3–6 kHz) as spikes
                                  # above the floor.  At L=3 the floor resolves features
                                  # wider than n_fft/(2*3) ≈ 7.3 kHz only, so anything
                                  # narrower — including a 4–8 kHz sibilant plateau —
                                  # protrudes above it.  Pair with higher selectivity
                                  # (12–18 dB) when using low values: the floor sits
                                  # 15–25 dB below spectral peaks at L=3, so a low
                                  # selectivity threshold will trigger on everything.
    "band_summary_max_cluster_bins": 46,
                                  # Maximum cluster width (STFT bins) before the
                                  # trough-split fires in the band_summary reporter.
                                  # Default 46 ≈ 1 kHz at 44.1 kHz / n_fft=2048.
                                  # Increase to 186 (≈4 kHz) or higher for passes
                                  # that use a wide spread kernel (sharpness ≤ 0.2):
                                  # a wide kernel produces smooth broad reduction where
                                  # troughs between nearby micro-features are very
                                  # shallow, causing the 1 kHz cap to split a plateau
                                  # into dozens of adjacent 20 Hz micro-clusters.
    "sibilant_only": False,       # When True, suppression for this pass is applied
                                  # only on frames classified as sibilant by the shared
                                  # sibilance event map (sibilantFrameIndices from
                                  # analyze_sibilance_events.py).  Non-sibilant frames
                                  # receive target_gr=0 so the IIR decays through them
                                  # without disturbing voiced non-sibilant frames.
                                  # Requires sibilant_frame_indices to be passed into
                                  # process() (via events_map in
                                  # apply_resonance_suppression()).  If sibilant_only=True
                                  # but no indices are provided, the pass logs a warning
                                  # and processes all voiced frames as a safe fallback.
    "combine": "max",             # How this pass's gain reduction is merged into the
                                  # accumulated combined_gr.
                                  # "max" (default) — np.maximum: the deeper reduction
                                  #   at each bin wins.  Passes compete; only the most
                                  #   aggressive value at each bin survives.  Use for
                                  #   passes that target distinct resonances via
                                  #   different lifter/selectivity settings, where
                                  #   mutual exclusion per bin is the correct semantic.
                                  # "add" — additive: this pass's reduction is summed
                                  #   on top of whatever prior passes computed.  Use
                                  #   when this pass is meant to complement rather than
                                  #   compete with earlier passes — e.g. a sibilant-only
                                  #   broad plateau reduction stacked on top of a
                                  #   narrow-spike pass that already covers the same
                                  #   frequency range.  Each pass's own max_reduction_db
                                  #   still caps its individual contribution before
                                  #   combining; the summed total is uncapped.
}


def resolve_params(overrides: dict = None) -> dict:
    """Merge sparse overrides over DEFAULT_PARAMS. None or empty -> defaults."""
    params = DEFAULT_PARAMS.copy()
    if overrides:
        params.update(overrides)
    return params


# ---------------------------------------------------------------------------
# Core algorithm
# ---------------------------------------------------------------------------

class ResonanceSuppressor:
    """
    Within-frame dynamic resonance suppressor.

    For each STFT frame:
      1. Compute magnitude spectrum.
      2. Compute a mel-domain smoothed reference envelope from the current
         frame's own spectrum -- the expected spectral shape without sharp peaks.
      3. Flag bins where actual magnitude exceeds reference by more than
         `selectivity` dB.
      4. Compute per-bin gain reduction scaled by `depth`, shaped by `sharpness`.
      5. Smooth gain reduction in time via attack/release IIR.
      6. Apply gain reduction to STFT bins (magnitude only, phase preserved).
      7. Reconstruct via ISTFT with overlap-add.

    Detection reference:
      Cepstral liftering computes the real cepstrum of each frame's
      log-magnitude spectrum (irfft of the one-sided log-magnitude), zeroes
      all quefrency indices above a cutoff set just below the fundamental
      quefrency (sr / f0), then transforms back (rfft). The pitch peak and
      all harmonic overtones fall above the cutoff and are removed, leaving
      only the smooth vocal-tract formant envelope. Because harmonic peaks
      are excluded from the reference, it sits at the inter-harmonic floor
      rather than being elevated by them -- room modes and mic resonances are
      detectable at their true prominence regardless of proximity to vocal
      harmonics. The lifter cutoff is f0-adaptive (40 % of sr/f0 samples),
      floored at 20 samples to prevent degenerate behaviour on high f0 input.

    Sharpness:
      Controls the shape of the applied attenuation, not the detection.
      Implemented as Gaussian spreading of the computed gain reduction array.
      Low sharpness -> wide kernel -> gentle broad cuts around detected peaks.
      High sharpness -> narrow kernel -> tight notches at detected bins only.

    Scope limitation:
      Within-frame smoothing cannot detect broad spectral elevations where the
      entire context window is elevated (e.g. sibilant plateaus). Those events
      are handled by the sibilance suppressor (Stage 4), which uses F0-derived
      detection and a long-term EMA reference.
    """

    def __init__(
        self,
        sample_rate: int = 44100,
        n_fft: int = 2048,
        hop_length: int = 512,
        params: "dict | list | None" = None,
        f0: float = None,
        f0_contour: list | None = None,
    ):
        self.sr         = sample_rate
        self.n_fft      = n_fft
        self.hop_length = hop_length

        # If a per-frame contour is supplied, derive the scalar f0 from its
        # median so the lifter cutoff is calibrated to the actual speaker pitch
        # rather than a hardcoded default.
        if f0_contour and not f0:
            valid = [v for v in f0_contour if v and v > 0]
            f0 = float(np.median(valid)) if valid else None

        self.f0         = f0
        self.f0_contour = f0_contour  # per-frame list, aligned to STFT frames

        self.freqs  = np.fft.rfftfreq(n_fft, d=1.0 / sample_rate)
        self.n_bins = len(self.freqs)

        # Normalise params to a list — either a single dict or an array of
        # pass configs. Each element is resolved independently against
        # DEFAULT_PARAMS so passes are fully independent: different
        # lifter_cutoff, selectivity, attack/release, frequency bounds, etc.
        if isinstance(params, list):
            params_list = params
        else:
            params_list = [params]

        # Build per-pass derived state (lifter_cutoff, active_bins,
        # spread_kernel, IIR coefficients). Stored in self._pass_configs so
        # the chunk loop can iterate over them without re-deriving each chunk.
        self._pass_configs = [self._build_pass_config(p) for p in params_list]

        # self.params = first pass resolved params — used for harmonic mask
        # computation, which is shared across all passes (all passes protect
        # the same vocal harmonics at the same pitch positions).
        self.params = self._pass_configs[0]["resolved"]

        # Harmonic mask ceiling: use the highest freq_ceil_hz across all passes
        # so that harmonics in every pass's active range are protected.  Using
        # only the first pass's freq_ceil_hz (e.g. 3000 Hz) would leave all
        # harmonics above that ceiling unprotected in higher-frequency passes
        # (e.g. a sibilant-only pass covering 3–12 kHz).
        self._harmonic_freq_ceil = max(
            pc["resolved"]["freq_ceil_hz"] for pc in self._pass_configs
        )

        # Backward-compat: single-pass code expects self._lifter_cutoff.
        self._lifter_cutoff = self._pass_configs[0]["lifter_cutoff"]

        # Harmonic protection cache — shared across all passes.
        # _mask_cache: maps rounded f0 → precomputed bool mask so each unique
        # pitch level is only built once even when the contour has hundreds of
        # distinct values.
        # _static_harmonic_mask: fallback when no contour is provided.
        self._mask_cache           = {}
        self._static_harmonic_mask = (
            self._compute_harmonic_mask_for_f0(self.f0)
            if self.params.get("preserve_harmonics") and self.f0
            else None
        )

        # Cached overlap-add window (computed once per instance).
        self._window         = get_window("hann", n_fft, fftbins=True).astype(np.float32)
        self._window_squared = (self._window.astype(np.float64) ** 2)

        n_passes = len(self._pass_configs)
        for i, pc in enumerate(self._pass_configs):
            p = pc["resolved"]
            logger.info(
                f"ResonanceSuppressor pass {i + 1}/{n_passes} | n_fft={n_fft} | "
                f"lifter_cutoff={pc['lifter_cutoff']} samples | "
                f"selectivity={p['selectivity']} dB | depth={p['depth']} | "
                f"sharpness={p['sharpness']} | max_cut={p['max_reduction_db']} dB | "
                f"freq={p['freq_floor_hz']:.0f}–{p['freq_ceil_hz']:.0f} Hz | "
                f"preserve_harmonics={p['preserve_harmonics']} | "
                f"sibilant_only={pc['sibilant_only']} | "
                f"combine={pc['combine']} | "
                f"f0_mode={'contour' if f0_contour else 'scalar'}"
            )

    @staticmethod
    def _time_to_coeff(time_ms: float, frame_period_ms: float) -> float:
        if time_ms <= 0 or frame_period_ms <= 0:
            return 1.0
        return np.exp(-frame_period_ms / time_ms)

    def _build_pass_config(self, params_override: "dict | None") -> dict:
        """
        Derive and cache all per-pass state from a single params dict.

        Called once per pass element in __init__; results stored in
        self._pass_configs so the chunk loop can iterate over them without
        recomputing derived values.

        Returns a dict with keys:
          resolved      — fully merged params dict
          lifter_cutoff — cepstral lifter cutoff in cepstrum samples (L)
          active_bins   — bool array (n_bins,) for active frequency range
          spread_kernel — Gaussian convolution kernel, or None
          attack_coeff  — float32 IIR coefficient for attack
          release_coeff — float32 IIR coefficient for release
        """
        resolved = resolve_params(params_override)

        # Lifter cutoff: override takes priority; otherwise derive from f0.
        cutoff_override = resolved.get("lifter_cutoff_bins")
        if cutoff_override is not None:
            lifter_cutoff = max(1, int(cutoff_override))
        elif self.f0 and self.f0 > 0:
            lifter_cutoff = max(20, int(0.40 * self.sr / self.f0))
        else:
            lifter_cutoff = 60

        # Active frequency bins for this pass.
        active_bins = (
            (self.freqs >= resolved["freq_floor_hz"]) &
            (self.freqs <= resolved["freq_ceil_hz"])
        )

        # Gaussian spread kernel — width set by sharpness.
        sharpness   = resolved["sharpness"]
        spread_bins = int(30 * (1.0 - sharpness))
        if spread_bins >= 2:
            sigma  = spread_bins / 3.0
            half   = spread_bins
            x      = np.arange(-half, half + 1, dtype=float)
            kernel = np.exp(-0.5 * (x / sigma) ** 2)
            spread_kernel = kernel / kernel.max()
        else:
            spread_kernel = None

        # Attack/release IIR coefficients.
        frame_period_ms = (self.hop_length / self.sr) * 1000.0
        attack_coeff    = np.float32(self._time_to_coeff(resolved["attack_ms"],  frame_period_ms))
        release_coeff   = np.float32(self._time_to_coeff(resolved["release_ms"], frame_period_ms))

        return {
            "resolved":               resolved,
            "lifter_cutoff":          lifter_cutoff,
            "active_bins":            active_bins,
            "spread_kernel":          spread_kernel,
            "attack_coeff":           attack_coeff,
            "release_coeff":          release_coeff,
            "max_cluster_bins":       int(resolved.get("band_summary_max_cluster_bins", 46)),
            "sibilant_only":          bool(resolved.get("sibilant_only", False)),
            "combine":                str(resolved.get("combine", "max")),
        }

    def _compute_harmonic_mask_for_f0(self, f0_val: float) -> np.ndarray | None:
        """
        Return a boolean array of shape (n_bins,) where True marks bins that
        belong to a harmonic overtone of f0_val and should be protected from
        reduction.  Returns None when f0_val is invalid.

        Results are cached in self._mask_cache keyed by f0_val rounded to the
        nearest Hz, so each distinct pitch level across the contour is only
        computed once.

        Protection zone: per-harmonic half-width is the larger of:
          • harmonic_width_bins  — fixed bin floor (low-frequency minimum)
          • harmonic_width_pct   — fraction of the overtone frequency in bins
                                   (scales with the harmonic so that the zone
                                   stays proportionally consistent up the series)
        Default harmonic_width_pct=0.01 matches the tolerance used by the
        band-summary reporter, guaranteeing every bin labelled is_harmonic=True
        is also inside the protection zone.
        """
        if not f0_val or f0_val <= 0:
            return None

        cache_key = round(f0_val)
        if cache_key in self._mask_cache:
            return self._mask_cache[cache_key]

        bin_width = self.sr / self.n_fft
        min_half  = int(self.params["harmonic_width_bins"])
        width_pct = float(self.params.get("harmonic_width_pct", 0.01))
        max_h     = int(self.params["max_harmonic"])
        freq_ceil = self._harmonic_freq_ceil
        mask      = np.zeros(self.n_bins, dtype=bool)

        # Iterate until the harmonic exceeds freq_ceil_hz or the hard max_harmonic
        # cap, whichever comes first.  This prevents unprotected vocal harmonics
        # above the old fixed H20 cap from being treated as suppressible spikes.
        for h in range(1, max_h + 1):
            freq = h * f0_val
            if freq > freq_ceil or freq > self.freqs[-1]:
                break
            center   = int(round(freq / bin_width))
            pct_half = int(round(freq * width_pct / bin_width))
            half     = max(min_half, pct_half)
            lo = max(0, center - half)
            hi = min(self.n_bins - 1, center + half)
            mask[lo : hi + 1] = True

        self._mask_cache[cache_key] = mask
        return mask

    def _cepstral_envelope_matrix(
        self,
        magnitude_db: np.ndarray,
        lifter_cutoff: "int | None" = None,
    ) -> np.ndarray:
        """
        Cepstral liftering reference envelope for a batch of frames.

        Args:
            magnitude_db:  (n_frames, n_bins) magnitude in dB.
            lifter_cutoff: Override the instance's self._lifter_cutoff.
                           Provided by multi-pass callers so each pass uses its
                           own L without mutating shared state.

        Returns:
            (n_frames, n_bins) smooth spectral envelope in dB, with harmonic
            structure removed.

        The real cepstrum is computed by treating each frame's one-sided
        log-magnitude spectrum as a real one-sided spectrum and inverting it
        (irfft). Zeroing all quefrency indices above the lifter cutoff removes
        the pitch peak and all harmonic overtones — they all fall at multiples
        of sr/f0 samples, well above the cutoff. Transforming back (rfft)
        gives a reference that sits at the inter-harmonic floor rather than
        being elevated by harmonic peaks, so room modes and mic resonances are
        detectable at their true prominence regardless of their proximity to
        vocal harmonics.

        The round-trip (irfft -> zero middle -> rfft of a real-valued input)
        is exact in theory; .real discards any floating-point residue.
        """
        n_fft = self.n_fft
        # Real cepstrum: treat the one-sided log-magnitude as a real one-sided
        # spectrum and invert to a full-length cepstrum.
        cepstrum = np.fft.irfft(magnitude_db, n=n_fft, axis=1)  # (n_frames, n_fft)

        # Rectangular lifter: zero the high-quefrency middle section.
        # Kept: indices 0..L-1 and n_fft-L+1..n_fft-1 (symmetric about zero).
        # Zeroed: indices L..n_fft-L (pitch peak and all harmonic overtones).
        L        = lifter_cutoff if lifter_cutoff is not None else self._lifter_cutoff
        liftered = cepstrum.copy()
        liftered[:, L : n_fft - L + 1] = 0.0

        # Back to log-magnitude domain; discard floating-point imaginary residue.
        envelope_db = np.fft.rfft(liftered, n=n_fft, axis=1).real[:, : self.n_bins]
        return envelope_db.astype(np.float32, copy=False)

    def _compute_gain_reduction_matrix(
        self,
        magnitude_db:  np.ndarray,
        smoothed_db:   np.ndarray,
        harmonic_mask: np.ndarray | None = None,
        pc:            "dict | None" = None,
    ) -> np.ndarray:
        """
        Batched gain-reduction. Inputs/output shape (n_frames, n_bins).

        Args:
            magnitude_db:  Per-frame log-magnitude spectrum (n_frames, n_bins).
            smoothed_db:   Cepstral envelope reference (n_frames, n_bins).
            harmonic_mask: Optional boolean array where True = protected bin.
                           Shape (n_bins,)         — static scalar-F0 path;
                                                     broadcast to all rows.
                           Shape (n_frames, n_bins) — per-frame contour path;
                                                     each row protects only
                                                     the harmonic positions at
                                                     that frame's own pitch.
                           When None, falls back to self._static_harmonic_mask
                           (also None when no scalar f0 was supplied).
            pc:            Per-pass config dict from self._pass_configs.
                           When supplied, uses pc["resolved"], pc["active_bins"],
                           and pc["spread_kernel"] for this pass.  When None,
                           falls back to the first pass config (single-pass path).
        """
        if pc is None:
            pc = self._pass_configs[0]
        p             = pc["resolved"]
        active_bins   = pc["active_bins"]
        spread_kernel = pc["spread_kernel"]
        selectivity   = p["selectivity"]
        depth         = p["depth"]
        max_reduction = p["max_reduction_db"]

        # Resolve mask: explicit chunk mask takes priority over static fallback.
        mask = harmonic_mask if harmonic_mask is not None else self._static_harmonic_mask

        spike_db        = magnitude_db - smoothed_db
        spike_db_masked = np.where(active_bins, spike_db, 0.0)
        above_threshold = np.maximum(0.0, spike_db_masked - selectivity)

        if p["mode"] == "soft":
            knee_width = selectivity * 0.5
            in_knee    = above_threshold < knee_width
            soft_curve = np.where(
                in_knee,
                above_threshold ** 2 / (2.0 * max(knee_width, 1e-6)),
                above_threshold,
            )
            raw_reduction = soft_curve * depth
        else:
            raw_reduction = above_threshold * depth

        reduction_db = np.clip(raw_reduction, 0.0, max_reduction)

        # Harmonic protection — pre-spread pass.
        # Zero harmonic bins before the spread kernel runs so their spike
        # energy is never convolved into neighbouring inter-harmonic bins.
        # Without this, a large harmonic spike bleeds at Gaussian weight into
        # the gaps on either side, defeating the protection intent.
        #
        # mask shape:
        #   1D (n_bins,)        — static scalar-F0 path; broadcast to all rows.
        #   2D (n_frames,n_bins)— per-frame contour path; each row protects only
        #                         the harmonic positions at that frame's own pitch.
        if mask is not None:
            if mask.ndim == 1:
                reduction_db[:, mask] = 0.0
            else:
                reduction_db[mask] = 0.0

        # Spread kernel applied along the bin axis for every frame at once.
        # Matches np.convolve(reduction_db, kernel, mode='same') per frame.
        if spread_kernel is not None:
            reduction_db = convolve1d(
                reduction_db, spread_kernel,
                axis=1, mode="constant", cval=0.0,
            )
            reduction_db = np.clip(reduction_db, 0.0, max_reduction)

        # Harmonic protection — post-spread pass.
        # Catches any residual bleed from genuine non-harmonic spikes that
        # are adjacent to a harmonic bin and spread into it after convolution.
        if mask is not None:
            if mask.ndim == 1:
                reduction_db[:, mask] = 0.0
            else:
                reduction_db[mask] = 0.0

        # Frequency boundary guard — post-spread pass.
        # Spread bleed from an active edge bin can cross freq_floor_hz /
        # freq_ceil_hz into inactive bins. Zero those out so the boundaries
        # are hard limits on applied reduction, not just on detection.
        reduction_db[:, ~active_bins] = 0.0

        return reduction_db

    def _build_band_summary(
        self,
        bin_sum_reduction: np.ndarray,
        bin_max_reduction: np.ndarray,
        voiced_frame_count: int,
        label: str = "",
        max_cluster_bins: int = 46,
    ) -> list:
        """
        Build the band_summary list from per-bin reduction accumulators.

        Used for both the overall combined summary and per-pass summaries in
        multi-pass mode.  Two-pass cluster algorithm:
          Pass 1 — gap-merge: fuse bins whose gap <= GAP_BINS.
          Pass 2 — width-cap: split clusters wider than max_cluster_bins at
                              their local trough so broad plateaux appear as
                              multiple segments rather than one opaque entry.

        Args:
            max_cluster_bins: Maximum cluster width before the trough-split
                              fires.  Default 46 ≈ 1 kHz at 44.1 kHz/n_fft=2048.
                              Set larger (e.g. 186 ≈ 4 kHz) for passes that use
                              a wide spread kernel (low sharpness) to prevent the
                              trough-split from creating dozens of adjacent micro-
                              clusters whose centers are only one bin apart.
        """
        band_summary = []
        if voiced_frame_count == 0:
            return band_summary

        bin_mean_reduction = bin_sum_reduction / voiced_frame_count

        ACTIVE_THRESHOLD = 0.05  # dB — bins below this are considered silent
        GAP_BINS         = 3     # fuse clusters separated by <= this many bins
        MAX_CLUSTER_BINS = max_cluster_bins

        active_indices = np.where(bin_max_reduction > ACTIVE_THRESHOLD)[0]
        if active_indices.size == 0:
            return band_summary

        # Pass 1: gap-merge.
        clusters = []
        lo = prev = int(active_indices[0])
        for idx in active_indices[1:]:
            i = int(idx)
            if i - prev > GAP_BINS:
                clusters.append((lo, prev))
                lo = i
            prev = i
        clusters.append((lo, prev))

        # Pass 2: width-cap — split wide clusters at their local trough.
        capped = []
        for lo, hi in clusters:
            start = lo
            while hi - start > MAX_CLUSTER_BINS:
                window_end    = start + MAX_CLUSTER_BINS
                trough_offset = int(
                    np.argmin(bin_max_reduction[start : window_end + 1])
                )
                capped.append((start, start + trough_offset))
                start = start + trough_offset + 1
            if start <= hi:
                capped.append((start, hi))
        clusters = capped

        for lo, hi in clusters:
            cluster_slice = slice(lo, hi + 1)
            peak_offset   = int(np.argmax(bin_max_reduction[cluster_slice]))
            peak_bin      = lo + peak_offset
            peak_freq     = float(self.freqs[peak_bin])
            mean_red      = float(np.mean(bin_mean_reduction[cluster_slice]))
            max_red       = float(bin_max_reduction[peak_bin])

            band_info = {
                "center":            round(peak_freq, 1),
                "lo_hz":             round(float(self.freqs[lo]), 1),
                "hi_hz":             round(float(self.freqs[hi]), 1),
                "mean_reduction_db": round(mean_red, 2),
                "peak_reduction_db": round(max_red, 2),
            }

            if self.f0 and self.f0 > 0:
                h = int(round(peak_freq / self.f0))
                if 0 < h <= self.params["max_harmonic"]:
                    h_freq    = h * self.f0
                    bin_width = self.sr / self.n_fft
                    min_half  = int(self.params["harmonic_width_bins"])
                    width_pct = float(self.params.get("harmonic_width_pct", 0.01))
                    pct_half  = int(round(h_freq * width_pct / bin_width))
                    tol_hz    = max(min_half, pct_half) * bin_width
                    if abs(peak_freq - h_freq) <= tol_hz:
                        band_info["harmonic"]    = f"H{h}={int(round(self.f0))} Hz"
                        band_info["is_harmonic"] = True
                    else:
                        band_info["is_harmonic"] = False
                else:
                    band_info["is_harmonic"] = False

            band_summary.append(band_info)

        if band_summary:
            tag = f" [{label}]" if label else ""
            logger.info(f"ResonanceSuppressor spike clusters{tag} (voiced frames):")
            for b in band_summary:
                bars = "#" * min(20, int(round(b["peak_reduction_db"] / 0.5)))
                harm = f"  [harmonic: {b['harmonic']}]" if b.get("is_harmonic") else ""
                span = f"{b['lo_hz']:.0f}–{b['hi_hz']:.0f} Hz"
                logger.info(
                    f"  {b['center']:8.1f} Hz ({span}): "
                    f"mean {-b['mean_reduction_db']:5.2f} dB | "
                    f"peak {-b['peak_reduction_db']:5.2f} dB  {bars}{harm}"
                )

        return band_summary

    def process(
        self,
        audio: np.ndarray,
        voiced_frame_indices=None,
        sibilant_frame_indices=None,
    ) -> dict:
        """
        Apply resonance suppression to a mono audio array.

        Args:
            audio: 1D float32 array at self.sr.
            voiced_frame_indices: set of STFT frame indices where voice is present.
                Silence frames receive target_gr=0; IIR decays smoothly.
                None = process all frames.
            sibilant_frame_indices: set of STFT frame indices classified as
                sibilant by the shared sibilance event map.  Used only by
                passes whose per-pass config has sibilant_only=True; ignored
                by all other passes.  When None and a pass has sibilant_only,
                that pass falls back to processing all voiced frames and logs
                a warning.

        Returns:
            dict: audio, max_reduction_db, mean_reduction_db, spike_frames,
                  artifact_risk, band_summary, passes
        """
        if audio.ndim != 1:
            raise ValueError("ResonanceSuppressor expects mono input (1D array).")

        n_fft          = self.n_fft
        hop            = self.hop_length
        window         = self._window
        window_squared = self._window_squared

        pad          = n_fft // 2
        audio_padded = np.pad(audio, pad, mode="reflect")
        n_padded     = len(audio_padded)
        n_frames     = max(0, (n_padded - n_fft) // hop + 1)

        if n_frames == 0:
            logger.warning("ResonanceSuppressor: audio too short, returning unmodified.")
            return {
                "audio": audio, "max_reduction_db": 0.0, "mean_reduction_db": 0.0,
                "spike_frames": 0, "artifact_risk": False, "band_summary": [],
            }

        # Float32 for the audio buffer keeps the spectral arrays float32 too.
        if audio_padded.dtype != np.float32:
            audio_padded = audio_padded.astype(np.float32, copy=False)

        output_buffer      = np.zeros(n_padded, dtype=np.float64)
        window_accumulator = np.zeros(n_padded, dtype=np.float64)

        max_reduction       = 0.0
        sum_reduction       = 0.0
        n_active_bins_total = 0
        spike_frames        = 0
        active_threshold    = 0.01

        bin_sum_reduction  = np.zeros(self.n_bins, dtype=np.float64)
        bin_max_reduction  = np.zeros(self.n_bins, dtype=np.float64)
        eps                = 1e-10

        # Precompute boolean voiced mask once -- avoids per-frame set lookup.
        if voiced_frame_indices is None:
            voiced_mask = np.ones(n_frames, dtype=bool)
        else:
            voiced_mask = np.zeros(n_frames, dtype=bool)
            for fi in voiced_frame_indices:
                if 0 <= fi < n_frames:
                    voiced_mask[fi] = True

        # Precompute sibilant mask once — used only by sibilant_only passes.
        # None means "no map provided"; passes that need it will log a warning
        # and fall back to processing all voiced frames.
        if sibilant_frame_indices is None:
            sibilant_mask = None
        else:
            sibilant_mask = np.zeros(n_frames, dtype=bool)
            for fi in sibilant_frame_indices:
                if 0 <= fi < n_frames:
                    sibilant_mask[fi] = True

        # Per-pass IIR state — one float32 vector per pass, carried across
        # chunks so the attack/release behaviour is identical to a per-frame
        # implementation.  Multi-pass: each pass has its own IIR state so that
        # different attack/release settings are fully independent.
        n_passes     = len(self._pass_configs)
        pass_prev_gr = [np.zeros(self.n_bins, dtype=np.float32) for _ in range(n_passes)]

        # Per-pass telemetry accumulators (voiced frames only).
        pass_bin_sum = [np.zeros(self.n_bins, dtype=np.float64) for _ in range(n_passes)]
        pass_bin_max = [np.zeros(self.n_bins, dtype=np.float64) for _ in range(n_passes)]

        # Chunk size keeps per-chunk peak memory bounded for long files.
        # 2048 frames ≈ 24 s at 44.1 kHz / hop=512.
        CHUNK_FRAMES = 2048

        for chunk_start in range(0, n_frames, CHUNK_FRAMES):
            chunk_end   = min(chunk_start + CHUNK_FRAMES, n_frames)
            chunk_n     = chunk_end - chunk_start
            audio_start = chunk_start * hop
            audio_stop  = (chunk_end - 1) * hop + n_fft  # exclusive

            # Batched framing: sliding_window_view + stride hop produces a
            # (chunk_n, n_fft) view with no copy. The window multiply is the
            # only allocation here.
            chunk_audio = audio_padded[audio_start:audio_stop]
            frame_view  = sliding_window_view(chunk_audio, n_fft)[::hop][:chunk_n]
            frames      = frame_view * window  # (chunk_n, n_fft) float32

            # Batched STFT — computed once, shared across all passes.
            spectra      = np.fft.rfft(frames, axis=1).astype(np.complex64, copy=False)
            magnitude    = np.abs(spectra)                          # (chunk_n, n_bins)
            magnitude_db = 20.0 * np.log10(magnitude + eps)

            # Per-frame harmonic mask from contour — shared across all passes
            # (all passes protect the same vocal harmonics at the same pitch).
            # Shape: (chunk_n, n_bins) — each row is the protection mask for
            # that specific frame's F0 value.  A 2D mask is required because
            # OR-unioning into a single 1D mask across a 2048-frame chunk
            # (~24 s) accumulates every harmonic position visited over the
            # entire window.  With natural pitch drift (e.g. 160–220 Hz) the
            # union blankets large swaths of spectrum at each harmonic level,
            # leaving nothing above the threshold — zero suppression.
            # Keeping masks per-frame ensures each frame is only protected at
            # its own pitch position, not at every pitch visited in the chunk.
            chunk_mask = None
            if self.f0_contour and self.params.get("preserve_harmonics"):
                chunk_f0s = self.f0_contour[chunk_start:chunk_end]
                chunk_mask = np.zeros((chunk_n, self.n_bins), dtype=bool)
                for j, f0_val in enumerate(chunk_f0s):
                    m = self._compute_harmonic_mask_for_f0(f0_val)
                    if m is not None:
                        chunk_mask[j] = m

            chunk_voiced = voiced_mask[chunk_start:chunk_end]

            # --- Multi-pass gain reduction ---
            # Each pass uses its own cepstral reference (lifter_cutoff),
            # detection params (selectivity, depth, mode), spread kernel,
            # frequency bounds, and IIR timing.  Gains are combined via
            # np.maximum so the more aggressive reduction wins at each bin.
            combined_gr = np.zeros((chunk_n, self.n_bins), dtype=np.float32)

            for i, pc in enumerate(self._pass_configs):
                # Cepstral envelope with this pass's lifter cutoff.
                smoothed_db_i = self._cepstral_envelope_matrix(
                    magnitude_db, lifter_cutoff=pc["lifter_cutoff"],
                )

                # Gain reduction matrix for this pass.
                target_gr_i = self._compute_gain_reduction_matrix(
                    magnitude_db, smoothed_db_i, harmonic_mask=chunk_mask, pc=pc,
                ).astype(np.float32, copy=False)

                # Zero non-voiced frames so IIR decays through silence.
                if not chunk_voiced.all():
                    target_gr_i[~chunk_voiced, :] = 0.0

                # Sibilant gate: if this pass has sibilant_only=True, zero any
                # frame that is not marked as sibilant so the IIR decays through
                # non-sibilant voiced frames without applying reduction to them.
                if pc["sibilant_only"]:
                    if sibilant_mask is not None:
                        chunk_sibilant = sibilant_mask[chunk_start:chunk_end]
                        if not chunk_sibilant.all():
                            target_gr_i[~chunk_sibilant, :] = 0.0
                    else:
                        logger.warning(
                            f"ResonanceSuppressor pass {i + 1}: sibilant_only=True "
                            "but no sibilant_frame_indices were supplied — "
                            "processing all voiced frames as a fallback.  Pass "
                            "--events-json from analyze_sibilance_events.py to "
                            "enable per-sibilant gating."
                        )

                # Attack/release IIR — state-dependent coefficient prevents
                # numpy vectorisation across frames. JITed via numba when
                # available, with a numpy fallback that loops in Python.
                if _NUMBA_AVAILABLE:
                    smoothed_gr_i, pass_prev_gr[i] = _iir_attack_release(
                        target_gr_i, pass_prev_gr[i],
                        pc["attack_coeff"], pc["release_coeff"],
                    )
                else:
                    smoothed_gr_i = np.empty_like(target_gr_i)
                    prev = pass_prev_gr[i]
                    for j in range(chunk_n):
                        tgt   = target_gr_i[j]
                        coeff = np.where(tgt >= prev, pc["attack_coeff"], pc["release_coeff"])
                        prev  = coeff * prev + (np.float32(1.0) - coeff) * tgt
                        smoothed_gr_i[j] = prev
                    pass_prev_gr[i] = prev

                # Merge this pass's reduction into the accumulator.
                # "max"  — winner-takes-all per bin: the deeper cut wins.
                # "add"  — additive stacking: this pass's reduction is summed
                #          on top of prior passes.  Each pass's own
                #          max_reduction_db already capped its contribution
                #          before combining; the summed total is uncapped so
                #          complementary passes can compound correctly.
                if pc["combine"] == "add":
                    combined_gr = combined_gr + smoothed_gr_i
                else:
                    combined_gr = np.maximum(combined_gr, smoothed_gr_i)

                # Per-pass voiced telemetry.
                if chunk_voiced.any():
                    voiced_i = smoothed_gr_i[chunk_voiced]
                    pass_bin_sum[i] += voiced_i.sum(axis=0, dtype=np.float64)
                    pass_bin_max[i]  = np.maximum(pass_bin_max[i], voiced_i.max(axis=0))

            # Apply combined gain to spectra and inverse-FFT in one batch.
            gain_linear      = np.power(10.0, -combined_gr / 20.0, dtype=np.float32)
            modified_spectra = spectra * gain_linear
            time_frames      = np.fft.irfft(modified_spectra, n=n_fft, axis=1).astype(
                np.float64, copy=False
            )
            time_frames *= window  # broadcast

            # Overlap-add into the global buffer. JITed when numba is
            # available so the per-frame Python overhead disappears.
            if _NUMBA_AVAILABLE:
                _overlap_add(
                    time_frames, window_squared, output_buffer,
                    window_accumulator, chunk_start, hop, n_padded,
                )
            else:
                for j in range(chunk_n):
                    s    = (chunk_start + j) * hop
                    e    = min(s + n_fft, n_padded)
                    trim = e - s
                    output_buffer[s:e]      += time_frames[j, :trim]
                    window_accumulator[s:e] += window_squared[:trim]

            # Overall telemetry from the combined gain reduction.
            chunk_max = float(combined_gr.max()) if combined_gr.size else 0.0
            if chunk_max > max_reduction:
                max_reduction = chunk_max

            chunk_active = combined_gr > active_threshold
            n_active     = int(chunk_active.sum())
            if n_active > 0:
                sum_reduction       += float(combined_gr[chunk_active].sum())
                n_active_bins_total += n_active
                spike_frames        += int(chunk_active.any(axis=1).sum())

            if chunk_voiced.any():
                voiced_combined   = combined_gr[chunk_voiced]
                bin_sum_reduction += voiced_combined.sum(axis=0, dtype=np.float64)
                bin_max_reduction  = np.maximum(
                    bin_max_reduction, voiced_combined.max(axis=0),
                )

        voiced_frame_count = int(voiced_mask.sum())

        safe_acc      = np.where(window_accumulator > 1e-8, window_accumulator, 1.0)
        output_buffer /= safe_acc
        output_audio   = output_buffer[pad : pad + len(audio)].astype(np.float32)

        mean_reduction = (sum_reduction / n_active_bins_total) if n_active_bins_total > 0 else 0.0
        artifact_risk  = mean_reduction > 3.0

        # Combined summary uses the smallest max_cluster_bins across all passes
        # so that narrow resonances from pass 1 still get separated correctly.
        combined_max_cluster = min(pc["max_cluster_bins"] for pc in self._pass_configs)
        band_summary = self._build_band_summary(
            bin_sum_reduction, bin_max_reduction, voiced_frame_count,
            label="combined", max_cluster_bins=combined_max_cluster,
        )

        # Per-pass detail for multi-pass reporting.
        passes_report = []
        if n_passes > 1:
            for i, pc in enumerate(self._pass_configs):
                p_summary = self._build_band_summary(
                    pass_bin_sum[i], pass_bin_max[i], voiced_frame_count,
                    label=f"pass {i + 1}",
                    max_cluster_bins=pc["max_cluster_bins"],
                )
                passes_report.append({
                    "pass":            i + 1,
                    "lifter_cutoff":   pc["lifter_cutoff"],
                    "max_reduction_db": round(float(pass_bin_max[i].max()), 2),
                    "band_summary":    p_summary,
                })

        logger.info(
            f"ResonanceSuppressor: max={max_reduction:.2f} dB | "
            f"mean={mean_reduction:.2f} dB | "
            f"spike_frames={spike_frames}/{n_frames} | artifact_risk={artifact_risk}"
        )

        return {
            "audio":             output_audio,
            "max_reduction_db":  max_reduction,
            "mean_reduction_db": mean_reduction,
            "spike_frames":      spike_frames,
            "artifact_risk":     artifact_risk,
            "band_summary":      band_summary,
            "passes":            passes_report,
        }


# ---------------------------------------------------------------------------
# Pipeline integration
# ---------------------------------------------------------------------------

def apply_resonance_suppression(
    audio: np.ndarray,
    sample_rate: int,
    params: "dict | list | None" = None,
    vad_voiced_mask: np.ndarray = None,
    f0: float = None,
    f0_contour: list | None = None,
    events_map: dict = None,
) -> dict:
    """
    Stage 3b pipeline entry point.

    Args:
        audio:           Mono float32 array at sample_rate.
        sample_rate:     Sample rate in Hz.
        params:          Sparse parameter overrides (see DEFAULT_PARAMS), OR a
                         list of such dicts for multi-pass processing.  Each
                         element in the list is a complete, independent pass
                         config; all passes share a single STFT/ISTFT cycle
                         and their gain reductions are combined with np.maximum
                         before the ISTFT.  Single-object presets are fully
                         backward-compatible.
        vad_voiced_mask: Per-sample bool array for silence gating.
        f0:              Scalar median F0 (Hz). Used as lifter cutoff when
                         contour is absent; derived from contour median
                         automatically when only f0_contour is supplied.
        f0_contour:      Per-STFT-frame F0 list (Hz), aligned to the same
                         framing as process() uses. Passed from getF0Contour()
                         in f0Analysis.js. When provided, the harmonic mask
                         tracks pitch changes frame-by-frame rather than using
                         a fixed scalar position.
        events_map:      Sibilance event map dict produced by
                         analyze_sibilance_events.py (or the cached map from
                         sibilanceEvents.js).  When provided, the
                         sibilantFrameIndices list is extracted and passed to
                         process() so that any pass with sibilant_only=True
                         can gate its suppression to only those frames.
                         Ignored for passes that do not set sibilant_only=True.
    """
    t0 = time.perf_counter()

    # Derive scalar f0 from contour median when only the contour is provided.
    if f0_contour and not f0:
        valid = [v for v in f0_contour if v and v > 0]
        f0 = float(np.median(valid)) if valid else None

    # Guard: with cepstral liftering the reference sits at the inter-harmonic
    # floor, so vocal harmonics protrude above it and will be attenuated unless
    # the harmonic mask is active.  If preserve_harmonics=True (the production
    # default) and neither a contour nor a scalar f0 is available, skip the
    # stage rather than silently damaging the voice.
    #
    # For multi-pass: skip if ANY pass has preserve_harmonics=True and no f0
    # data is available — erring on the side of protection.
    params_list = params if isinstance(params, list) else [params]
    any_preserve = any(resolve_params(p).get("preserve_harmonics", True) for p in params_list)
    if any_preserve and not f0 and not f0_contour:
        logger.warning(
            "ResonanceSuppressor: skipping stage — preserve_harmonics=True but "
            "neither f0 nor f0_contour is set.  Supply pitch data from "
            "getF0Contour() in f0Analysis.js, or set preserve_harmonics=False "
            "explicitly for diagnostic runs."
        )
        return {
            "audio":             audio,
            "max_reduction_db":  0.0,
            "mean_reduction_db": 0.0,
            "spike_frames":      0,
            "artifact_risk":     False,
            "band_summary":      [],
            "passes":            [],
            "skipped":           True,
            "process_seconds":   time.perf_counter() - t0,
        }

    suppressor = ResonanceSuppressor(
        sample_rate=sample_rate, params=params, f0=f0, f0_contour=f0_contour,
    )

    voiced_frame_indices = None
    if vad_voiced_mask is not None and len(vad_voiced_mask) == len(audio):
        pad           = suppressor.n_fft // 2
        n_padded      = len(audio) + 2 * pad
        n_stft_frames = max(0, (n_padded - suppressor.n_fft) // suppressor.hop_length + 1)
        voiced_frame_indices = set()
        for fi in range(n_stft_frames):
            orig_start = max(0, fi * suppressor.hop_length - pad)
            orig_end   = min(len(audio), fi * suppressor.hop_length - pad + suppressor.n_fft)
            if orig_start < orig_end and vad_voiced_mask[orig_start:orig_end].any():
                voiced_frame_indices.add(fi)

    # Extract sibilant frame indices from the shared event map when provided.
    sibilant_frame_indices = None
    if events_map is not None:
        raw_indices = events_map.get("sibilantFrameIndices") or []
        sibilant_frame_indices = set(raw_indices)
        logger.info(
            f"ResonanceSuppressor: received events_map with "
            f"{len(sibilant_frame_indices)} sibilant frame(s)."
        )

    result                    = suppressor.process(
        audio,
        voiced_frame_indices=voiced_frame_indices,
        sibilant_frame_indices=sibilant_frame_indices,
    )
    result["skipped"]         = False
    result["lifter_cutoff"]   = suppressor._lifter_cutoff
    result["process_seconds"] = time.perf_counter() - t0
    return result


def resonance_suppressor_report_entry(result: dict) -> dict:
    """Format result for the Stage 7 processing report JSON."""
    if result.get("skipped"):
        return {"applied": False, "process_seconds": round(result.get("process_seconds", 0.0), 3)}
    entry = {
        "applied":           True,
        "lifter_cutoff":     result.get("lifter_cutoff"),
        "max_reduction_db":  round(result["max_reduction_db"],  1),
        "mean_reduction_db": round(result["mean_reduction_db"], 1),
        "spike_frames":      result["spike_frames"],
        "artifact_risk":     result["artifact_risk"],
        "band_summary":      result.get("band_summary", []),
        "process_seconds":   round(result.get("process_seconds", 0.0), 3),
    }
    passes = result.get("passes")
    if passes:
        entry["passes"] = passes
    return entry


# ---------------------------------------------------------------------------
# CLI
# ---------------------------------------------------------------------------

if __name__ == "__main__":
    import argparse, json, sys
    from scipy.io import wavfile

    logging.basicConfig(level=logging.INFO, stream=sys.stdout, format="%(message)s")
    parser = argparse.ArgumentParser(description="Stage 3b -- Resonance Suppressor")
    parser.add_argument("--input",         required=True)
    parser.add_argument("--output",        required=True)
    parser.add_argument("--params-json",   default=None,
                        help="Sparse parameter overrides (JSON object or array). "
                             "A single object is merged over DEFAULT_PARAMS. "
                             "An array enables multi-pass mode: each element is "
                             "a complete, independent pass config.  Missing keys "
                             "in each element inherit from DEFAULT_PARAMS. "
                             "Sourced from the preset's resonanceSuppressor "
                             "block in src/audio/presets.js.")
    parser.add_argument("--vad-mask-json",     default=None)
    parser.add_argument("--f0",                type=float, default=None)
    parser.add_argument("--f0-contour-json",   default=None,
                        help="Path to JSON produced by estimate_f0_contour.py. "
                             "Enables per-frame harmonic mask tracking.")
    parser.add_argument("--events-json",        default=None,
                        help="Path to sibilance event map JSON produced by "
                             "analyze_sibilance_events.py (or the cached map "
                             "from sibilanceEvents.js).  Required when any pass "
                             "sets sibilant_only=True; ignored otherwise.")
    args = parser.parse_args()

    sr, audio = wavfile.read(args.input)
    audio = audio.astype(np.float32)

    params = None
    if args.params_json:
        with open(args.params_json) as fh:
            params = json.load(fh)

    vad_voiced_mask = None
    if args.vad_mask_json:
        with open(args.vad_mask_json) as fh:
            frame_list = json.load(fh)
        vad_voiced_mask = np.zeros(len(audio), dtype=bool)
        for frame in frame_list:
            if not frame["isSilence"]:
                s = frame["offsetSamples"]
                e = s + frame["lengthSamples"]
                vad_voiced_mask[s:min(e, len(audio))] = True

    f0_contour = None
    if args.f0_contour_json:
        with open(args.f0_contour_json) as fh:
            contour_data = json.load(fh)
        f0_contour = contour_data.get("perFrame")
        if not args.f0 and contour_data.get("median"):
            args.f0 = float(contour_data["median"])

    events_map = None
    if args.events_json:
        with open(args.events_json) as fh:
            events_map = json.load(fh)

    result = apply_resonance_suppression(
        audio, sr, params, vad_voiced_mask, args.f0, f0_contour, events_map,
    )
    wavfile.write(args.output, sr, result["audio"])
    print("JSON_RESULT:" + json.dumps(resonance_suppressor_report_entry(result)), flush=True)
