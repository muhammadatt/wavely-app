import numpy as np
from scipy.signal import get_window
import sys
import logging
sys.path.append('server/scripts')
from instant_polish_resonance_suppressor import ResonanceSuppressor

logging.basicConfig(level=logging.ERROR)

class NewResonanceSuppressor(ResonanceSuppressor):
    def _compute_smoothed_envelope(self, magnitude_db: np.ndarray) -> np.ndarray:
        power = 10.0 ** (magnitude_db / 10.0)
        from scipy.ndimage import uniform_filter1d
        
        # We increase the window sizes to better capture broad sibilance
        # max_window = 120 bins was ~2500 Hz. We want ~5000 Hz or more.
        # Let's scale smooth_window_bins significantly
        window = max(20, self.smooth_window_bins * 4) 
        
        smoothed_power = uniform_filter1d(power, size=window, mode="reflect")
        smoothed_db = 10.0 * np.log10(smoothed_power + 1e-10)
        return smoothed_db

sr = 44100
t = np.linspace(0, 1, sr)
audio_harm = np.sin(2 * np.pi * 3000 * t) + 0.5 * np.sin(2 * np.pi * 3500 * t) + 0.25 * np.sin(2 * np.pi * 4000 * t)
audio_harm = audio_harm.astype(np.float32) * 0.5

old_supp = ResonanceSuppressor(sample_rate=sr, preset='acx_audiobook')
new_supp = NewResonanceSuppressor(sample_rate=sr, preset='acx_audiobook')

print("Harmonics (Old):", old_supp.process(audio_harm)['mean_reduction_db'])
print("Harmonics (New):", new_supp.process(audio_harm)['mean_reduction_db'])

from scipy.signal import butter, lfilter
noise = np.random.randn(sr)
b, a = butter(4, [5000/(sr/2), 9000/(sr/2)], btype='bandpass')
sibilance = lfilter(b, a, noise).astype(np.float32)

print("Sibilance (Old):", old_supp.process(sibilance)['max_reduction_db'])
print("Sibilance (New):", new_supp.process(sibilance)['max_reduction_db'])
