import sys
import pathlib

# Make server/scripts importable regardless of where pytest is invoked from
sys.path.insert(0, str(pathlib.Path(__file__).parent.parent / "scripts"))
