# ZED 2 IMU over WebHID

Adds an optional `PoseSource` for the general-camera backend (see `architecture.md`)
driven by the ZED 2's on-board IMU, read directly over WebHID - no Stereolabs SDK, no
native binary, works from the browser tab already running the camera backend.

Files (self-contained; `src/camera/app.ts` is not touched - see "Wiring" below):

| File | Purpose |
|---|---|
| `src/camera/pose/zed-imu.ts` | WebHID driver: connects to the sensor MCU, parses `REP_ID_SENSOR_DATA` reports into `{ accel, gyro, temperatureC, valid }` samples, tracks rate/health stats. |
| `src/camera/pose/zed-imu-webhid.d.ts` | Minimal ambient WebHID types (`navigator.hid`, `HIDDevice`, ...) - not in TypeScript's bundled `lib.dom.d.ts`. |
| `src/camera/pose/zed-imu-attitude.ts` | Complementary filter: gyro (integrated) + accel (levels) -> pitch/roll/yaw, motion magnitude, `stationary` flag. |
| `src/camera/pose/zed-imu-pose-source.ts` | `PoseSource` implementation + `installZedImu()` DOM wiring (the "Connect ZED IMU" button). |

## Hardware identification (owner-verified)

The owner's ZED 2 enumerates as **two independent USB interfaces** under vendor id
`0x2B03` (Stereolabs):

- **PID `0xF780`** - UVC video (the side-by-side stereo camera). Untouched by this work;
  it's what `src/camera/frame-source.ts` already reads via `getUserMedia`.
- **PID `0xF781`** - "USB Input Device", a vendor-defined HID interface exposing the IMU,
  magnetometer, and barometer. This is what `zed-imu.ts` talks to.

## Protocol (mirrors zed-open-capture)

Stereolabs' open-source
[`zed-open-capture`](https://github.com/stereolabs/zed-open-capture) implements this
same HID protocol in `src/sensorcapture.cpp` against the struct/enum definitions in
`include/sensorcapture_def.hpp`. Facts below were read directly from those two files
(fetched from `raw.githubusercontent.com/stereolabs/zed-open-capture/master/...`) and
mirrored, not guessed:

**Report ids** (`usb::CUSTOMHID_REPORT_ID` / `CUSTOMHID_REQUEST_ID`, `sensorcapture_def.hpp`):

| Constant | Value | Use |
|---|---|---|
| `REP_ID_SENSOR_DATA` | `0x01` | Input report: one IMU/mag/baro sample. |
| `REP_ID_REQUEST_SET` | `0x21` | Feature report wrapper for generic commands. |
| `RQ_CMD_PING` | `0xF2` | Command byte under `REP_ID_REQUEST_SET`: keep-alive ping (the MCU expects one roughly every second or stops streaming). |
| `REP_ID_SENSOR_STREAM_STATUS` | `0x32` | Feature report: 1-byte enable/disable the sample stream, and its current status. |

**Enable/disable** (`SensorCapture::enableDataStream`, `sensorcapture.cpp:210`): a
1-byte feature report under `REP_ID_SENSOR_STREAM_STATUS` (`1` = enable, `0` =
disable) via `hid_send_feature_report`. Over WebHID this is
`device.sendFeatureReport(0x32, Uint8Array.of(1))` - `sendFeatureReport`'s first
argument *is* the report id, mirroring `hid_send_feature_report`'s `buf[0]`.

**Sample struct** (`usb::RawData`, `sensorcapture_def.hpp`, `#pragma pack(1)`,
little-endian): `struct_id, imu_not_valid, timestamp(u64), gX/gY/gZ(i16),
aX/aY/aZ(i16), frame_sync, sync_capabilities, frame_sync_count(u32), imu_temp(i16),
mag_valid, mX/mY/mZ(i16), camera_moving, camera_moving_count(u32), camera_falling,
camera_falling_count(u32), env_valid, temp(i16), press(u32), humid(u32),
temp_cam_left(i16), temp_cam_right(i16)`.

**Important offset-by-one note**: the C struct's first byte (`struct_id`) duplicates
the HID report id. WebHID's `oninputreport` already strips the report id into
`event.reportId` and does *not* include it in `event.data` - so every field in
`zed-imu.ts`'s `parseSensorReport` sits at the C struct's documented offset **minus
one**. `tests/unit/zed-imu.test.ts` builds buffers that include the `struct_id` byte
(matching the header 1:1) and then slices it off before parsing, to make that
adjustment explicit and testable rather than just asserted in a comment.

**Scale factors** (`sensorcapture_def.hpp` macros, applied in
`SensorCapture::grabThreadFunc`, `sensorcapture.cpp:457-471`):

| Macro | Value | Meaning |
|---|---|---|
| `DEFAULT_GRAVITY` | `9.8189` (m/s²) | 1g for this MCU's calibration. |
| `ACC_SCALE` | `DEFAULT_GRAVITY * (8.0/32768.0)` | Accelerometer raw->m/s², ±8g over an `int16`. |
| `GYRO_SCALE` | `1000.0/32768.0` | Gyroscope raw->**deg/s**, ±1000dps over an `int16` (`sensorcapture.hpp`'s `Imu` struct comments confirm `gX/gY/gZ` are in °/s - converted to rad/s in `rawToSample`). |
| `TEMP_SCALE` | `0.01` | IMU temperature raw->°C. |

These are reproduced verbatim as exported constants in `zed-imu.ts`
(`ACC_SCALE`, `GYRO_SCALE`, `TEMP_SCALE`) so the unit tests can assert against the
same numbers the comments cite, not just trust the implementation.

**Rate**: `zed-open-capture` doesn't hardcode a rate constant; `grabThreadFunc` reads
continuously (`hid_read_timeout(..., 2000)`) and pings roughly once every 400 reads to
keep the MCU streaming. The ZED 2's IMU is a 400 Hz part in Stereolabs' published specs,
which matches that ping cadence (`NOMINAL_SAMPLE_RATE_HZ = 400` in `zed-imu.ts`, labeled
nominal - `ZedImu.stats.rateHz` measures the observed rate rather than assuming it).

**Not implemented here** (out of scope for pose/attitude, but the struct carries them
and `parseSensorReport` easily extends to them if a future feature needs them):
magnetometer, barometer, `camera_moving`/`camera_falling` interrupts, environmental
sensor block. `RawZedSensorData` currently decodes through `mX/mY/mZ`; nothing past that
offset is read.

## Axis convention

**This is the one fact in this document that could not be verified without hardware.**
`zed-open-capture`'s README states: "The coordinate system is only used for sensor
data. The given IMU and Magnetometer data are expressed in the RAW coordinate system as
shown below" - followed by an image, `images/imu_axis.jpg`
(https://github.com/stereolabs/zed-open-capture/blob/master/images/imu_axis.jpg). That
diagram is not machine-readable from a text fetch, so the raw-IMU-axis -> camera-frame
mapping is a **documented assumption**, not a verified fact:

- `zed-imu-attitude.ts` exports `ImuAxisMap` (a per-axis `{ axis, sign }` picker - a
  permutation-with-signs, since the IMU package is screwed to the camera body on one of
  24 axis-aligned orientations, never a general rotation) and a
  `DEFAULT_ZED2_AXIS_MAP` that defaults to **identity** (raw IMU X/Y/Z assumed already
  aligned with camera X-right/Y-up/Z-back, this codebase's convention - see
  `src/camera/pose/static.ts` and `orientation-math.ts`).
- `ZedImuAttitude`/`ZedImuPoseSource` both take an `axisMap` option so the identity
  default can be overridden once someone calibrates against a real device.

### Axis calibration procedure (needs a real ZED 2)

1. Connect the IMU (`installZedImu`'s button) and lay the camera flat, lens pointing at
   the horizon, sitting on a level table (its natural "looks along -Z" rest pose).
2. Watch `ZedImuAttitude.attitude.pitchRad`/`rollRad` (e.g. via the tuning panel or a
   `console.log` in a debug build). Both should read ~0.
   - If instead one of them reads ~±90° or ~180°, the raw axis feeding that computation
     is swapped or inverted: change `DEFAULT_ZED2_AXIS_MAP`'s `x`/`y`/`z` `axis`/`sign`
     until level reads ~0/~0.
3. Tilt the camera nose-down by a known angle (e.g. 20° on a wedge/protractor).
   `pitchRad` should read that angle (within ~0.5°, per
   `tests/unit/zed-imu-attitude.test.ts`'s tilt-convergence test) with the *correct
   sign* (nose-down is negative pitch, matching `StaticPoseSource`'s "negative pitch
   looks down" convention). If the sign is flipped, negate `pitchRad`'s source axis's
   `sign`.
4. Roll the camera about its forward axis by a known angle; same check against
   `rollRad`.
5. Once pitch/roll are both correct and independent (rolling doesn't move the pitch
   reading and vice versa), the axis map is calibrated. Yaw can't be calibrated this way
   (gravity doesn't constrain it) - `yawRad`'s sign only matters relative to whichever
   raw axis actually points "up" through the device, which step 2-4 already pins down.

## Wiring (the two lines `src/camera/app.ts` needs)

Per the task's file boundary, this work does not touch `app.ts`. The lead wires it with:

```ts
import { ZedImuPoseSource, installZedImu } from '@/camera/pose/zed-imu-pose-source';

// Wherever the active PoseSource is assembled (see src/camera/pose/index.ts's
// createPoseSource) - e.g. as a new 'zed-imu' arm of CameraAppConfig.pose:
const zedImuPoseSource = new ZedImuPoseSource({ cameraHeightM: config.cameraHeightM });
await zedImuPoseSource.start(); // silently reconnects to a previously-granted device

// Wherever the landing/setup card lives in the camera page's DOM:
installZedImu(landingCardElement, zedImuPoseSource);
```

`zedImuPoseSource.start()` is safe to call unconditionally (it never throws, and never
prompts - it only tries `navigator.hid.getDevices()`); the actual device picker only
opens when the visitor clicks the button `installZedImu` adds, since WebHID's
`requestDevice()` requires a user gesture and throws a `SecurityError` otherwise
(`ZedImuPoseSource.connect()`, called by that button, is where that requirement lives -
see its doc comment). Treat `zedImuPoseSource` like any other `PoseSource`
(`update(now)` once per rendered frame, `dispose()` on teardown); `.pose.quality` follows
the same `PoseQuality` contract every other source uses.

## Manual test procedure (needs a real ZED 2)

1. `npm run dev` (port 5182 on this branch), open `camera.html` in a WebHID-capable
   browser (Chrome/Edge desktop; WebHID is not available on iOS Safari or Firefox).
2. Confirm the "Connect ZED IMU" button installs where `installZedImu` was wired in, and
   clicking it opens the browser's device picker showing the ZED 2 (PID `0xF781`, *not*
   the `0xF780` UVC entry).
3. After granting access, confirm the status label reads "Connected to ..." and the
   camera's rendered view starts responding to physically tilting/rotating the camera
   (pitch/roll should track within roughly the calibration procedure's ~0.5° once
   settled; yaw will visibly drift over tens of seconds - expected, it's gyro-only).
4. Reload the page without unplugging the camera: the status label should read
   "Reconnected to ..." within ~250ms with **no** device-picker prompt (this is the
   `navigator.hid.getDevices()` persisted-grant path).
5. Bump the desk/camera sharply: `trackingOk` (visible via whatever HUD/debug overlay
   surfaces `PoseQuality`, e.g. `debug-overlay.ts`) should drop immediately and recover
   about 300ms after the bump settles, not instantly.
6. Leave the camera untouched for 2+ seconds: `ZedImuAttitude.stationary` (surfaced
   through whatever debug hook the lead wires) should go true after ~500ms of quiet.
7. Unplug the camera mid-session: `ZedImu.stats.rateHz` should drop to 0 and
   `trackingOk` should go false (no samples arriving -> `sampleAgeMs` grows unbounded).

None of steps 2-7 can be exercised without the physical device; only the parsing math,
filter convergence, and DOM wiring are covered by `npx vitest run`.
