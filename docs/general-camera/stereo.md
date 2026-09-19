# Stereo depth (ZED 2 and other side-by-side sources)

The general-camera backend's measured-depth path. A ZED 2 on USB is a UVC
camera that delivers both eyes side by side (left half = left eye), **not
rectified** and without the SDK. `ZedStereoFrameSource`
(`src/camera/stereo/zed-frame-source.ts`, camera branch) shows the left eye
as the passthrough and grabs both eyes at the work width; this module turns
those grabs into a metric `DepthMap` (`source: 'stereo'`) on the GPU.

Files (`src/camera/stereo/`):

| file | role |
|---|---|
| `contract.ts` | `StereoDepthEstimator`, `CreateStereoDepthOptions`, `StereoCalibrationInput`, `registerStereoDepth` (owned by the camera branch) |
| `zed-calib.ts` | factory `.conf` parsing, `rodrigues`, `stereoRectify`, `buildRectifyMap`, `nominalStereo` |
| `stereo-depth.ts` | the WebGL2 matcher (`WebGL2StereoDepthEstimator`, `createStereoDepthEstimator`); registers itself at import (`src/camera/app.ts` imports it for the side effect) |
| `census.ts` | CPU reference of the same pipeline; what the unit tests verify numerically |

## Calibration source

`public/zed/SN25491304.conf` is the owner's ZED 2 factory calibration
(Stereolabs also serves it from `calib.stereolabs.com/?SN=<serial>`; the dev
server proxies that at `/zed-calib?sn=`). Per mode (`VGA` 672x376, `HD`
1280x720, `FHD`, `2K`) it gives pinhole intrinsics and Brown distortion
(k1 k2 p1 p2 k3) for both eyes, plus `[STEREO]`: `Baseline` (mm, 119.833),
`TY`/`TZ` (mm) and `RX_<mode>`/`CV_<mode>`/`RZ_<mode>`, a Rodrigues vector
(radians, `CV` is the y component) with `X_right = R X_left + T`,
`T = [-Baseline, TY, TZ] / 1000`.

`stereoRectify` follows OpenCV (`CALIB_ZERO_DISPARITY`, no cropping): both
cameras turn half-way towards each other, then a common rotation brings the
baseline onto the x axis (sign chosen so +x stays +x; taking the baseline
direction unsigned rotates both eyes by 180 degrees - that bug shipped once
and is pinned by a unit test). Both rectified eyes share
`P = [f 0 cx; 0 f cy]` with `f = mean(fx_L, fx_R)`; the right eye sits at
`-f * B` so disparity `d = x_L - x_R = f * B / Z > 0`. `buildRectifyMap` is
`initUndistortRectifyMap`: for every rectified pixel, the source pixel of the
raw eye, as (sx, sy) floats. The matcher uploads the two maps as RG32F
textures at full eye resolution and samples them at the work grid, so the
CPU never resamples pixels. Without a calibration the source reports nominal
values (fx 264/528/1055/1067 px, B 0.12 m, no maps) and the matcher searches
+-2 rows to tolerate the unrectified vertical offset (`stats.rectified =
false`).

## Pipeline (all fragment shaders, one draw per pass, one readback)

Input: `GrabbedFrame` with `rgba` = left eye and `right` = right eye at the
work size (336 px wide by default = half a VGA eye; the app grabs at
`STEREO_WORK_WIDTH`).

1. **remap** - each eye through its rectification map into R32F luma
   (bilinear on the RGBA8 upload); identity without maps.
2. **row mean** - per-row luma mean per eye (1 x H).
3. **census** - 5x5 census transform (24 bits, R32UI) of the row-equalised
   luma (the ZED's eyes are exposed independently; the right eye's rows are
   scaled to the left eye's row means; census is itself invariant to
   monotonic intensity changes so this is a belt-and-braces step).
4. **cost** - Hamming distance (SWAR popcount; GLSL ES 3.00 has no
   `bitCount`) for every disparity 0..D-1 into an RGBA8UI atlas of D/4 tiles
   (4 disparities per texel), left-referenced and right-referenced. Unrectified
   input takes the minimum over +-2 rows.
5. **aggH** - 7-wide horizontal box sum on the atlas (max 7 x 24 fits 8 bits).
6. **wta** - per pixel, 7-tall vertical sum over all tiles (the other half of
   the separable 7x7 aggregation), winner-take-all, parabola sub-pixel
   refinement from the neighbouring costs -> RG32F (disparity, cost).
7. **lr** - left-right check: reject where `|dL - dR(x - dL)| > 1` px.
8. **median** - 3x3 median over consistent neighbours.
9. **final** - 5x5 hole fill (needs >= 8 valid neighbours, confidence 0.5),
   `Z = f_work * B / d` with `f_work = fxRect * workWidth / eyeWidth * fxScale`
   -> RGBA32F (depth m, confidence, disparity, 0), read back with one
   `readPixels`.

Output: `latest` is a `DepthMap` at the work size, metres along the rectified
left camera axis, holes 0; `latest.confidence` = fraction of pixels that
passed the LR check (drives the tier cap: >= 0.8 counts as measured);
`latestDisparity` / `latestConfidence` keep the per-pixel disparity and
confidence (1 consistent, 0.5 filled, 0 invalid). `stats` feeds the
diagnostics line `stereo 336x189 d0..64 valid 35% 5 ms rectified SN25491304`.

Eye order: the estimator matches both orderings on the first two frames and
every 120th frame after that and keeps the one with more LR-consistent
pixels (`stats.eyesSwapped`); a pair in the wrong order has negative
disparities and matches almost nothing. `swapEyes: false | true` forces it.

## Measured

Synthetic pair (ray-cast floor at 1.1 m / box at 2 m / wall at 3.5 m, fx 132 at
336x188, left eye 0.8x darker; `tests/e2e/camera-stereo-depth.spec.ts`):
valid 92%, median error 1.2%, p90 3.1% over 1-3 m, box median 1.99 m (truth
2.02), 93% of pixels within 1 px of the CPU reference.

Real clip (`public/zed/zed2-sbs-hd720-8s.webm`, HD720 SBS, SN 25491304,
`tests/e2e/camera-zed-clip-depth.spec.ts`), 336x189, d 0..64: LR-valid
35-36%; middle band (cans / laptop) matcher median 41.6 px = 0.40 m against
the image cross-correlation peak of 43 px; top band (room behind) median
1.5-2.4 m depending on the frame; bottom band (desk edge, nearly
textureless) 0.46-0.50 m at 20% coverage.

Timing (`stats.lastMs`, submit + readback, one frame, median of 12) on an
AMD Radeon 780M (D3D11 ANGLE - what headless Chromium picked on the owner's
laptop; the RTX 5060 was not selected by the headless run): 5.7 ms at
336x189 (d 64), 9.6 ms at 448x252 (d 88), 20 ms at 672x378 (d 128).
~290 ms at 336x188 on SwiftShader (the CI path).

## Expected accuracy and tunables

Triangulation error grows with Z^2: dZ = Z^2 / (f B) * dd. For the ZED 2 at
HD720 (f 534 px, B 0.12 m) with ~0.25 px disparity noise that is ~1% at 1 m
and ~3% at 3 m; at the 336 px work width (f 140 px) quadruple those unless
the work width is raised. `sample()` reports `toleranceM = max(0.03, 0.01 *
Z^2)` for the capture pipeline. Textureless surfaces (bare desk, white
walls) fail the LR check and stay 0; consumers must treat 0 as unknown.

| tunable | where | default | effect |
|---|---|---|---|
| `workWidth` | `CreateStereoDepthOptions` | 336 | resolution of the match; cost ~ W x H x D |
| `maxDisparity` | option / `disparityRangeFor` | 64 at 336 px, scaled with width, multiple of 4 | nearest measurable depth `f B / D` (0.26 m at 336 px) |
| aggregation | `AGG_RADIUS` in `stereo-depth.ts` | 3 (7x7) | larger = denser, smoother, fatter edges |
| LR threshold | `LR_TOLERANCE_PX` | 1 px | looser = more coverage, more outliers |
| row search | `UNRECTIFIED_ROW_SEARCH` | 2 (unrectified only) | vertical tolerance without maps |
| hole fill | `HOLE_FILL_MIN_NEIGHBOURS` | 8 of 24 | fill only well-supported holes (confidence 0.5) |
| `fxScale` | option (tuning `stereoFxScale`) | 1 | single-point distance calibration multiplier on f |
| `swapEyes` | option | 'auto' | eye order detection |

Tests: `tests/unit/camera-zed-calib.test.ts` (parse, Rodrigues, rectify,
map orientation), `tests/unit/camera-stereo.test.ts` (CPU reference on the
synthetic pair: coverage, accuracy, exposure invariance, row search),
`tests/e2e/camera-stereo-depth.spec.ts` (GPU vs truth and vs CPU),
`tests/e2e/camera-zed-clip-depth.spec.ts` (real clip through the app).
