import sys
from pathlib import Path

# Make `import backend.*` work regardless of pytest's invocation directory.
sys.path.insert(0, str(Path(__file__).resolve().parent.parent.parent))
