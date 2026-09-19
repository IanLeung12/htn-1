"""Open the ZED through the SDK and print resolution, centre depth and the tracked pose for ~2 s.

    tools/zed-bridge/.venv/Scripts/python.exe tools/zed-bridge/verify.py [--seconds 2] [--depth-mode NEURAL]

Exit codes: 0 ok, 2 camera busy / not found (another process such as a Chrome tab
holds the UVC device), 3 other SDK error.
"""
import argparse
import sys
import time

import pyzed.sl as sl


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--seconds", type=float, default=2.0)
    ap.add_argument("--depth-mode", default="NEURAL", choices=["NEURAL_PLUS", "NEURAL", "NEURAL_LIGHT", "ULTRA", "QUALITY", "PERFORMANCE"])
    args = ap.parse_args()

    print(f"ZED SDK {sl.Camera.get_sdk_version()}")
    devices = sl.Camera.get_device_list()
    print(f"devices: {[(d.serial_number, str(d.camera_model), str(d.camera_state)) for d in devices]}")

    init = sl.InitParameters()
    init.camera_resolution = sl.RESOLUTION.HD720
    init.camera_fps = 30
    init.depth_mode = getattr(sl.DEPTH_MODE, args.depth_mode)
    init.coordinate_system = sl.COORDINATE_SYSTEM.RIGHT_HANDED_Y_UP
    init.coordinate_units = sl.UNIT.METER
    init.depth_minimum_distance = 0.3

    cam = sl.Camera()
    t0 = time.perf_counter()
    err = cam.open(init)
    print(f"open: {err} ({time.perf_counter() - t0:.1f} s)")
    if err != sl.ERROR_CODE.SUCCESS:
        text = str(err)
        if "IN_USE" in text or "NOT_DETECTED" in text or "NOT_AVAILABLE" in text or "NO_GPU" in text:
            print("The ZED is busy or not detected: close the Chrome tab (or any app) that holds it via getUserMedia, then retry.")
            return 2
        return 3

    info = cam.get_camera_information()
    cfg = info.camera_configuration
    calib = cfg.calibration_parameters.left_cam
    print(f"model {info.camera_model} SN {info.serial_number} fw {cfg.firmware_version}")
    print(f"resolution {cfg.resolution.width}x{cfg.resolution.height} @ {cfg.fps} fps; fx {calib.fx:.1f} fy {calib.fy:.1f} cx {calib.cx:.1f} cy {calib.cy:.1f}")

    tp = sl.PositionalTrackingParameters()
    tp.enable_imu_fusion = True
    tp.set_floor_as_origin = True
    terr = cam.enable_positional_tracking(tp)
    print(f"positional tracking: {terr}")

    rt = sl.RuntimeParameters()
    depth = sl.Mat()
    pose = sl.Pose()
    frames = 0
    t_end = time.perf_counter() + args.seconds
    while time.perf_counter() < t_end:
        if cam.grab(rt) != sl.ERROR_CODE.SUCCESS:
            continue
        frames += 1
        cam.retrieve_measure(depth, sl.MEASURE.DEPTH)
        w, h = depth.get_width(), depth.get_height()
        _, d = depth.get_value(w // 2, h // 2)
        state = cam.get_position(pose, sl.REFERENCE_FRAME.WORLD)
        t = pose.get_translation().get()
        o = pose.get_orientation().get()
        print(f"frame {frames}: centre depth {d:.3f} m; tracking {state}; t=({t[0]:+.3f},{t[1]:+.3f},{t[2]:+.3f}) q=({o[0]:+.3f},{o[1]:+.3f},{o[2]:+.3f},{o[3]:+.3f})")
    print(f"{frames} frames in {args.seconds} s ({frames / args.seconds:.1f} fps)")
    cam.disable_positional_tracking()
    cam.close()
    return 0


if __name__ == "__main__":
    sys.exit(main())
