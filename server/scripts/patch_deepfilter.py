"""
Compatibility patch for deepfilternet 0.5.6 on torchaudio >= 2.1.

deepfilternet imports torchaudio.backend.common.AudioMetaData which was
removed in torchaudio 2.1. This script patches the installed df/io.py to
stub out the missing class.

Run after installing or upgrading deepfilternet:
    python server/scripts/patch_deepfilter.py
"""

import pathlib
import sys

try:
    import df  # noqa: F401 — just check it's importable
    df_path = pathlib.Path(df.__file__).parent
except ImportError:
    print("ERROR: deepfilternet is not installed in this Python environment.")
    sys.exit(1)

io_path = df_path / "io.py"
content = io_path.read_text()

OLD = "from torchaudio.backend.common import AudioMetaData"
STUB = """\
try:
    from torchaudio.backend.common import AudioMetaData
except ImportError:
    from dataclasses import dataclass

    @dataclass
    class AudioMetaData:
        sample_rate: int
        num_frames: int
        num_channels: int
        bits_per_sample: int
        encoding: str
"""

if OLD not in content:
    if "class AudioMetaData" in content:
        print("Already patched — nothing to do.")
    else:
        print("ERROR: Expected import line not found. Check df/io.py manually.")
        sys.exit(1)
else:
    io_path.write_text(content.replace(OLD, STUB))
    print(f"Patched {io_path}")

# Verify
try:
    from df.enhance import enhance, init_df  # noqa: F401
    print("Verification OK — deepfilternet imports successfully.")
except Exception as e:
    print(f"Verification FAILED: {e}")
    sys.exit(1)
