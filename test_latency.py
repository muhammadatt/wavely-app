import sys
import subprocess
import numpy as np
from scipy.io import wavfile
from scipy.signal import correlate

sr = 44100
t = np.linspace(0, 2, sr * 2, endpoint=False)
x = np.sin(2 * np.pi * 400 * t + 100 * t**2).astype(np.float32)
wavfile.write("impulse.wav", sr, x)

subprocess.run([sys.executable, "server/scripts/deepfilter_enhance.py", "--input", "impulse.wav", "--output", "impulse_df.wav"])
subprocess.run(["ffmpeg", "-y", "-i", "impulse_df.wav", "-ar", "44100", "-acodec", "pcm_f32le", "-f", "wav", "impulse_df_44.wav"], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)

sr_out, out = wavfile.read("impulse_df_44.wav")

corr = correlate(out, x, mode='full')
shift = np.argmax(corr) - (len(x) - 1)
print("DeepFilter shift (samples at 44.1kHz):", shift)
print("DeepFilter shift (ms):", shift / sr * 1000)
