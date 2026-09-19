"""One-time TensorRT optimisation of the ZED SDK AI depth model(s) WITHOUT opening the camera.

The first `Camera.open()` with DEPTH_MODE.NEURAL otherwise blocks for ~30 minutes on a
laptop GPU while it builds the engine, holding the camera the whole time. Run this once
after installing the SDK (or after a driver update) so the bridge starts in seconds:

    tools/zed-bridge/.venv/Scripts/python.exe tools/zed-bridge/optimize_models.py [NEURAL_DEPTH ...]
"""
import sys
import time

import pyzed.sl as sl


def main() -> int:
    names = sys.argv[1:] or ["NEURAL_DEPTH"]
    for name in names:
        model = getattr(sl.AI_MODELS, name)
        t0 = time.perf_counter()
        print(f"optimizing {name} ...", flush=True)
        err = sl.optimize_ai_model(model)
        print(f"{name}: {err} ({(time.perf_counter() - t0) / 60:.1f} min)", flush=True)
        if err != sl.ERROR_CODE.SUCCESS:
            return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
