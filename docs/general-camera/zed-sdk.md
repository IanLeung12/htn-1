# ZED SDK bridge (`?source=zed-sdk`)

The browser cannot talk to the Stereolabs SDK, so a small Python process owns the
ZED 2, runs the SDK's depth + positional tracking, and streams frames to the page
over a local WebSocket. The page then has SDK-quality metric depth (tier A) and a
real 6DoF pose instead of a static tripod guess. Code:

- `tools/zed-bridge/server.py` - the bridge (asyncio + websockets + numpy + opencv, pyzed for the camera)
- `tools/zed-bridge/verify.py` - opens the camera and prints resolution / centre depth / pose for 2 s
- `tools/zed-bridge/optimize_models.py` - one-time TensorRT build of the NEURAL depth engine *without* holding the camera
- `src/camera/zedsdk/` - browser side: `ZedBridgeClient`, `ZedSdkFrameSource`, `ZedSdkDepthEstimator`, `ZedSdkPoseSource`
- `tests/unit/camera-zedsdk-protocol.test.ts`, `tests/e2e/camera-zed-sdk.spec.ts` (spawns `server.py --fake`)

## Install (what was done on this machine, 2026-09-19)

| piece | version | notes |
|---|---|---|
| ZED SDK | 5.5.0 (CUDA 13.0 / TensorRT 10.13 build) | `ZED_SDK_Windows_cuda13.0_tensorrt10.13_v5.5.0.exe` from https://www.stereolabs.com/developers/release (1.3 GB), NSIS installer, run with `/S` (silent; UAC prompt). Installs to `C:\Program Files (x86)\ZED SDK`. |
| CUDA | none needed | The SDK build bundles what it needs; the installer also downloaded `cuda_13.4.2_windows_x86_64.exe` to Downloads but the toolkit was not installed and `pyzed` still imports and opens the camera. Driver 595.95 (RTX 5060 laptop). |
| Python | 3.14.6 (the system `python`) in `tools/zed-bridge/.venv` | pyzed 5.5 ships a `cp314` wheel, so no second Python was needed. |
| pyzed | 5.5 | `cd "C:\Program Files (x86)\ZED SDK"; <venv>\Scripts\python.exe get_python_api.py` (downloads `pyzed-5.5-cp314-cp314-win_amd64.whl`). |
| bridge deps | websockets 17.1, numpy 2.5, opencv-python 5.0 | `tools/zed-bridge/requirements.txt` |

Steps to reproduce:

```powershell
python -m venv tools/zed-bridge/.venv
tools/zed-bridge/.venv/Scripts/python.exe -m pip install -r tools/zed-bridge/requirements.txt
cd "C:\Program Files (x86)\ZED SDK"; C:\...\tools\zed-bridge\.venv\Scripts\python.exe get_python_api.py; cd -
tools/zed-bridge/.venv/Scripts/python.exe tools/zed-bridge/optimize_models.py NEURAL_DEPTH   # ~30 min once, no camera needed
tools/zed-bridge/.venv/Scripts/python.exe tools/zed-bridge/verify.py                          # 2 s camera check
```

`verify.py` result: camera opened (S/N 25491304, fw 1523, HD720@30, left fx 527.3 px at
1280x720), factory calibration auto-downloaded, positional tracking OK. The first open
with `DEPTH_MODE.NEURAL` blocks for ~30 min building the TensorRT engine *while holding
the camera*; run `optimize_models.py` first (offline) or start with `--depth-mode ULTRA`.

## The camera has one owner

The ZED is a UVC device: while a Chrome tab holds it through `getUserMedia`
(`?source=stereo`), the SDK reports `CAMERA_NOT_DETECTED` / `IN_USE` and the bridge
exits with code 2 and a message. Close that tab first. While the bridge runs, the
browser must use `?source=zed-sdk` (no `getUserMedia`).

## Running

```powershell
tools/zed-bridge/.venv/Scripts/python.exe tools/zed-bridge/server.py                 # NEURAL (falls back ULTRA -> PERFORMANCE)
tools/zed-bridge/.venv/Scripts/python.exe tools/zed-bridge/server.py --depth-mode ULTRA
tools/zed-bridge/.venv/Scripts/python.exe tools/zed-bridge/server.py --fake          # synthetic room, no camera / SDK
tools/zed-bridge/.venv/Scripts/python.exe tools/zed-bridge/server.py --record seq.npz --seconds 10
tools/zed-bridge/.venv/Scripts/python.exe tools/zed-bridge/server.py --play seq.npz
```

Options: `--port 8765`, `--jpeg-width 640|1280`, `--depth-width 320|640`, `--jpeg-quality 80`,
`--resolution HD720|HD1080|VGA`, `--fps 30`, `--no-floor-origin` (publish `find_floor_plane`
instead of putting the tracking origin on the floor). The bridge prints fps / encode ms /
MB/s / tracking state every 5 s.

Browser: `http://localhost:5183/camera.html?source=zed-sdk&bridge=ws://localhost:8765`
(or tick "ZED SDK bridge" on the landing card, which reloads with those params and
persists the URL). Press `d`: the `zed-sdk ...` diagnostics line shows bridge fps,
MB/s, transport and decode latency, tracking state, floor mode and the valid-depth
fraction. `window.__zedBridge` exposes the client, sources and stats.

## Wire format

One binary WebSocket message per frame, little-endian:

```
u32 headerLen | header JSON | u32 jpegLen | JPEG (left image, q80, 640x360 default)
| u32 depthLen | zlib(uint16 millimetres, 320x180 default) | u32 confLen | zlib(uint8 confidence, 255 = best)
```

Header: `timestamp` (camera clock ms), `frame`, `sentAt` (bridge wall clock ms),
`width/height`, `fx/fy/cx/cy` (scaled to the JPEG size), `depthWidth/depthHeight`,
`pose` (16 floats, column-major 4x4 camera-to-world), `trackingState`, `depthMin/Max`,
`floorY`. The SDK's confidence (0 best .. 100 worst) is mapped to `255 - 2.55 * c`.
Text commands from the page: `{"cmd":"reset"}`, `{"cmd":"config","jpegWidth":1280,"depthWidth":640}`.

## Coordinate conventions

- The SDK is opened with `COORDINATE_SYSTEM.RIGHT_HANDED_Y_UP` + `UNIT.METER`: x right,
  y up, z toward the viewer, camera looks along -z. That is the app's world frame (three.js),
  so the pose matrix is used without an axis swap (`src/camera/zedsdk/protocol.ts`).
- Floor: the bridge enables tracking with `set_floor_as_origin`, so the SDK puts the world
  origin on the detected floor under the start pose and `floorY = 0`; `ZedSdkPoseSource`
  then uses the SDK's y directly (floor mode `sdk`). If the SDK found no floor (origin at the
  camera, `y ~ 0` on the first OK frame) or `floorY` is null, the tuning camera height is
  applied as an offset so the first tracked pose sits at `y = cameraHeightM` (mode `tuning`).
- Depth is `MEASURE.DEPTH`: z-distance along the camera forward axis (what `DepthMap.metric`
  expects), holes/NaN and pixels under confidence 128 become 0. `DepthMap.confidence` is 0.95
  (measurement grade; `tier-cap.ts` treats `'zed-sdk'` like `'sensor'`, tier A) scaled down when
  under half the pixels are valid. `DepthMap.confidenceMap` carries the per-pixel map.
- Intrinsics: `fovY = 2 atan(h / 2 fy)` from the SDK calibration overrides the tuning FOV;
  the principal point offset (cx, cy) is not applied by the app's pinhole (it assumes the
  centre), which is within ~1 % for the ZED 2.
- `trackingOk` = SDK state `OK` and a frame in the last 500 ms (a stopped bridge pauses edits).
  `PoseQuality.mode` is `'tracked'`.

## Measured (RTX 5060 laptop, HD720@30, ULTRA, localhost)

- Bridge: 29-30 fps, encode 7 ms/frame (JPEG 640x360 q80 + zlib depth/conf 320x180), 3.1 MB/s,
  ~103 kB/frame.
- Bridge send -> Python client receive: 2.7 ms average. Browser decode (JPEG ->
  ImageBitmap + two inflates via `DecompressionStream`) is reported live in the diagnostics
  line (`decode N ms`); with the fake source the e2e spec sees > 10 fps under SwiftShader.
- NEURAL (engine built offline in 9 min by `optimize_models.py`): 21 fps GPU-bound, encode
  8 ms, ~93 kB/frame, 2.0 MB/s; send -> receive rose to ~40 ms average while the GPU was
  saturated. ULTRA is the better default on this laptop when the browser also needs the GPU;
  the bridge falls back ULTRA -> PERFORMANCE automatically when a mode fails to open.
- Floor origin caveat: with the camera 0.36 m from a desk object, `set_floor_as_origin`
  produced camera heights of 2.97 m (ULTRA run) and 0.16 m (NEURAL run) - the SDK fitted a
  'floor' on whatever dominated the view. `ZedSdkPoseSource` treats a first pose under 0.3 m
  as "no floor" and uses the tuning height; point the camera at real floor when starting the
  bridge, or send `{"cmd":"reset"}` (`window.__zedBridge.poseSource.reset()`) once it does.

## Remaining

- Record browser-side decode latency on the real GPU (the numbers above are from a Python
  client; the page shows its own in the diagnostics line) and validate the floor origin with
  the camera looking at real floor.
- Optional spatial-mapping mesh (`enable_spatial_mapping`) is not streamed yet.
- Landing-card checkbox reloads the page; a hot switch between UVC and bridge sources would
  need the app to rebuild its sources.
