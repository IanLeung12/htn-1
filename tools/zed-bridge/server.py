"""ZED SDK -> browser bridge for Reality Editor's general-camera backend.

Runs the ZED 2 through the Stereolabs SDK (SDK-quality depth + 6DoF positional
tracking) and streams every frame to the browser over a local WebSocket, so the
page can use `?source=zed-sdk&bridge=ws://localhost:8765` instead of getUserMedia.
The bridge must be the sole owner of the camera: close any browser tab holding the
ZED via UVC before starting it.

    tools/zed-bridge/.venv/Scripts/python.exe tools/zed-bridge/server.py            # live camera
    ... server.py --fake                                                            # synthetic scene, no camera / SDK
    ... server.py --record out.npz [--seconds 10]                                   # live + save a sequence
    ... server.py --play out.npz                                                    # replay a recording (no SDK)

Wire format (one binary WebSocket message per frame, little-endian):

    u32 headerLength | header JSON (utf-8) | u32 jpegLength | JPEG (left image)
    | u32 depthLength | zlib(uint16 millimetres, row-major, depthWidth x depthHeight)
    | u32 confLength | zlib(uint8 confidence 0..255, same grid; 255 = best)

Header JSON fields: timestamp (ms, camera clock), frame, width/height (JPEG),
fx/fy/cx/cy (pixels, scaled to the JPEG size), depthWidth/depthHeight,
pose (16 numbers, column-major 4x4 camera-to-world, RIGHT_HANDED_Y_UP, metres),
trackingState ('OK' | 'SEARCHING' | 'OFF' | ...), depthMin/depthMax (m),
floorY (world y of the detected floor plane, or null), sentAt (bridge wall clock, ms).

Coordinate frame: the SDK is opened with COORDINATE_SYSTEM.RIGHT_HANDED_Y_UP and
UNIT.METER, which is three.js / the app's world frame (x right, y up, z toward the
viewer; camera looks along -z). With `set_floor_as_origin` the world origin is on
the floor under the camera's start position, y up. Depth is the z-distance along the
camera forward axis (MEASURE.DEPTH), not the ray length.

Text messages from the client are JSON commands: {"cmd":"reset"} resets tracking,
{"cmd":"config","jpegWidth":1280} switches the passthrough size.
"""
from __future__ import annotations

import argparse
import asyncio
import json
import math
import struct
import sys
import time
import zlib
from typing import Any, Optional

import numpy as np

try:
    import cv2
except ImportError:  # pragma: no cover
    cv2 = None

try:
    import websockets
    from websockets.asyncio.server import serve
except ImportError:  # pragma: no cover
    websockets = None
    serve = None


DEFAULT_PORT = 8765
DEPTH_MIN_M = 0.3
DEPTH_MAX_M = 20.0
DEFAULT_JPEG_WIDTH = 640
DEFAULT_DEPTH_WIDTH = 320


# ---------------------------------------------------------------------------
# Frame producers
# ---------------------------------------------------------------------------


class Frame:
    __slots__ = ("timestamp_ms", "index", "bgr", "depth_m", "conf", "fx", "fy", "cx", "cy", "pose", "tracking", "floor_y")

    def __init__(self) -> None:
        self.timestamp_ms = 0.0
        self.index = 0
        self.bgr: Optional[np.ndarray] = None  # HxWx3 uint8
        self.depth_m: Optional[np.ndarray] = None  # HxW float32 (0 / nan = invalid)
        self.conf: Optional[np.ndarray] = None  # HxW uint8, 255 best
        self.fx = self.fy = self.cx = self.cy = 0.0
        self.pose = np.eye(4, dtype=np.float64)  # camera-to-world, column-major when flattened with order='F'
        self.tracking = "OFF"
        self.floor_y: Optional[float] = None


class FakeSource:
    """Synthetic room: a floor plane, a back wall, a box, and a slowly orbiting camera. No camera, no SDK."""

    def __init__(self, width: int = 1280, height: int = 720, fps: float = 30.0) -> None:
        self.width, self.height, self.fps = width, height, fps
        self.fx = self.fy = 700.0 * (width / 1280.0)
        self.cx, self.cy = width / 2.0, height / 2.0
        self.index = 0
        self.t0 = time.perf_counter()
        # Camera 1.1 m above the floor, pitched down 20 degrees, looking along -z.
        self.cam_height = 1.1
        self.pitch = -20.0 * math.pi / 180.0
        # Precompute per-pixel ray directions (camera frame, right-handed y-up, forward -z) at reduced size.
        self.rw, self.rh = width // 4, height // 4
        u = (np.arange(self.rw, dtype=np.float32) + 0.5) * 4.0
        v = (np.arange(self.rh, dtype=np.float32) + 0.5) * 4.0
        uu, vv = np.meshgrid(u, v)
        self.dir_x = (uu - self.cx) / self.fx
        self.dir_y = -(vv - self.cy) / self.fy
        self.dir_z = -np.ones_like(self.dir_x)

    def pose_at(self, t: float) -> np.ndarray:
        yaw = 0.15 * math.sin(t * 0.5)
        x = 0.2 * math.sin(t * 0.3)
        return _pose_matrix(x, self.cam_height, 0.0, yaw, self.pitch)

    def grab(self) -> Frame:
        t = time.perf_counter() - self.t0
        target = self.index / self.fps
        if t < target:
            time.sleep(target - t)
        f = Frame()
        f.index = self.index
        self.index += 1
        f.timestamp_ms = (time.perf_counter() - self.t0) * 1000.0
        f.fx, f.fy, f.cx, f.cy = self.fx, self.fy, self.cx, self.cy
        f.pose = self.pose_at(t)
        f.tracking = "OK"
        f.floor_y = 0.0
        R = f.pose[:3, :3]
        o = f.pose[:3, 3]
        # World-space ray directions.
        dx = R[0, 0] * self.dir_x + R[0, 1] * self.dir_y + R[0, 2] * self.dir_z
        dy = R[1, 0] * self.dir_x + R[1, 1] * self.dir_y + R[1, 2] * self.dir_z
        dz = R[2, 0] * self.dir_x + R[2, 1] * self.dir_y + R[2, 2] * self.dir_z
        # Ray-plane: floor y=0, back wall z=-3.
        with np.errstate(divide="ignore", invalid="ignore"):
            t_floor = np.where(dy < -1e-6, -o[1] / dy, np.inf)
            t_wall = np.where(dz < -1e-6, (-3.0 - o[2]) / dz, np.inf)
        tt = np.minimum(t_floor, t_wall)
        label = np.where(t_floor <= t_wall, 1, 2)
        # Box 0.4 m cube at (0.3, 0.2, -1.6): slab test.
        bmin = np.array([0.1, 0.0, -1.8])
        bmax = np.array([0.5, 0.4, -1.4])
        with np.errstate(divide="ignore", invalid="ignore"):
            tx0 = (bmin[0] - o[0]) / dx
            tx1 = (bmax[0] - o[0]) / dx
            ty0 = (bmin[1] - o[1]) / dy
            ty1 = (bmax[1] - o[1]) / dy
            tz0 = (bmin[2] - o[2]) / dz
            tz1 = (bmax[2] - o[2]) / dz
        tnear = np.maximum.reduce([np.minimum(tx0, tx1), np.minimum(ty0, ty1), np.minimum(tz0, tz1)])
        tfar = np.minimum.reduce([np.maximum(tx0, tx1), np.maximum(ty0, ty1), np.maximum(tz0, tz1)])
        hit_box = (tnear <= tfar) & (tfar > 0) & (tnear < tt)
        tt = np.where(hit_box, tnear, tt)
        label = np.where(hit_box, 3, label)
        # Depth along the camera forward axis = t * (-dir_z in camera frame) = t (dir_z = -1).
        depth = np.where(np.isfinite(tt), tt, 0.0).astype(np.float32)
        f.depth_m = depth
        conf = np.full(depth.shape, 230, dtype=np.uint8)
        conf[depth <= 0] = 0
        f.conf = conf
        # Colour: floor checker, wall gradient, box orange.
        px = o[0] + dx * tt
        pz = o[2] + dz * tt
        checker = ((np.floor(px * 2) + np.floor(pz * 2)) % 2).astype(np.float32)
        img = np.zeros((self.rh, self.rw, 3), dtype=np.uint8)
        img[..., 0] = np.where(label == 1, 90 + 60 * checker, np.where(label == 2, 160, 30))
        img[..., 1] = np.where(label == 1, 110 + 60 * checker, np.where(label == 2, 140, 110))
        img[..., 2] = np.where(label == 1, 120 + 60 * checker, np.where(label == 2, 120, 230))
        if cv2 is not None:
            f.bgr = cv2.resize(img, (self.width, self.height), interpolation=cv2.INTER_NEAREST)
        else:
            f.bgr = np.repeat(np.repeat(img, 4, axis=0), 4, axis=1)
        return f

    def reset(self) -> None:
        self.t0 = time.perf_counter()
        self.index = 0

    def close(self) -> None:
        pass


class PlaybackSource:
    """Replays an .npz written by --record at the recorded frame rate."""

    def __init__(self, path: str) -> None:
        data = np.load(path)
        self.jpeg = data["jpeg"]  # object array of bytes
        self.depth = data["depth"]  # N x h x w uint16 mm
        self.conf = data["conf"]
        self.pose = data["pose"]  # N x 4 x 4
        self.ts = data["timestamp_ms"]
        self.intr = data["intrinsics"]  # fx fy cx cy (at the JPEG size)
        self.tracking = data["tracking"]
        self.floor_y = data["floor_y"] if "floor_y" in data else None
        self.n = len(self.ts)
        self.index = 0
        self.t0 = time.perf_counter()

    def grab(self) -> Frame:
        i = self.index % self.n
        if i == 0:
            self.t0 = time.perf_counter()
        target = (self.ts[i] - self.ts[0]) / 1000.0
        now = time.perf_counter() - self.t0
        if now < target:
            time.sleep(target - now)
        f = Frame()
        f.index = self.index
        self.index += 1
        f.timestamp_ms = float(self.ts[i])
        f.fx, f.fy, f.cx, f.cy = (float(x) for x in self.intr)
        f.pose = self.pose[i]
        f.tracking = str(self.tracking[i])
        f.floor_y = None if self.floor_y is None or not np.isfinite(self.floor_y[i]) else float(self.floor_y[i])
        f.depth_m = self.depth[i].astype(np.float32) / 1000.0
        f.conf = self.conf[i]
        buf = np.frombuffer(self.jpeg[i], dtype=np.uint8)
        f.bgr = cv2.imdecode(buf, cv2.IMREAD_COLOR) if cv2 is not None else None
        return f

    def reset(self) -> None:
        self.index = 0

    def close(self) -> None:
        pass


class ZedSource:
    """The real camera through pyzed. Depth mode falls back NEURAL -> ULTRA -> PERFORMANCE when the GPU cannot run it."""

    def __init__(self, depth_mode: str, resolution: str = "HD720", fps: int = 30, floor_origin: bool = True) -> None:
        import pyzed.sl as sl  # imported lazily so --fake / --play work without the SDK

        self.sl = sl
        self.cam = sl.Camera()
        modes = [depth_mode] + [m for m in ("ULTRA", "PERFORMANCE") if m != depth_mode]
        err = None
        for mode in modes:
            init = sl.InitParameters()
            init.camera_resolution = getattr(sl.RESOLUTION, resolution)
            init.camera_fps = fps
            init.depth_mode = getattr(sl.DEPTH_MODE, mode)
            init.coordinate_system = sl.COORDINATE_SYSTEM.RIGHT_HANDED_Y_UP
            init.coordinate_units = sl.UNIT.METER
            init.depth_minimum_distance = DEPTH_MIN_M
            init.depth_maximum_distance = DEPTH_MAX_M
            init.sdk_verbose = 0
            err = self.cam.open(init)
            if err == sl.ERROR_CODE.SUCCESS:
                self.depth_mode = mode
                break
            text = str(err)
            print(f"[zed-bridge] open with {mode} failed: {text}", flush=True)
            if "IN_USE" in text or "NOT_DETECTED" in text or "NOT_AVAILABLE" in text:
                raise RuntimeError(f"camera busy or not detected ({text}): close the browser tab holding the ZED and retry")
        else:
            raise RuntimeError(f"could not open the ZED: {err}")

        info = self.cam.get_camera_information()
        cfg = info.camera_configuration
        cal = cfg.calibration_parameters.left_cam
        self.width, self.height = cfg.resolution.width, cfg.resolution.height
        self.fx, self.fy, self.cx, self.cy = cal.fx, cal.fy, cal.cx, cal.cy
        self.serial = info.serial_number
        print(f"[zed-bridge] ZED SN {self.serial} {self.width}x{self.height}@{cfg.fps} depth {self.depth_mode} fx {self.fx:.1f}", flush=True)

        tp = sl.PositionalTrackingParameters()
        tp.enable_imu_fusion = True
        tp.set_floor_as_origin = floor_origin
        tp.enable_area_memory = True
        terr = self.cam.enable_positional_tracking(tp)
        if terr != sl.ERROR_CODE.SUCCESS:
            print(f"[zed-bridge] positional tracking not enabled: {terr}", flush=True)
        self.floor_origin = floor_origin
        self.floor_y: Optional[float] = 0.0 if floor_origin else None
        self.floor_checked_at = -math.inf

        self.rt = sl.RuntimeParameters()
        self.rt.confidence_threshold = 100  # keep everything; the browser filters with the confidence map
        self.rt.texture_confidence_threshold = 100
        self.m_left = sl.Mat()
        self.m_depth = sl.Mat()
        self.m_conf = sl.Mat()
        self.pose = sl.Pose()
        self.index = 0

    def grab(self) -> Optional[Frame]:
        sl = self.sl
        if self.cam.grab(self.rt) != sl.ERROR_CODE.SUCCESS:
            return None
        f = Frame()
        f.index = self.index
        self.index += 1
        f.timestamp_ms = self.cam.get_timestamp(sl.TIME_REFERENCE.IMAGE).get_milliseconds()
        self.cam.retrieve_image(self.m_left, sl.VIEW.LEFT)
        self.cam.retrieve_measure(self.m_depth, sl.MEASURE.DEPTH)
        self.cam.retrieve_measure(self.m_conf, sl.MEASURE.CONFIDENCE)
        bgra = self.m_left.get_data()
        f.bgr = np.ascontiguousarray(bgra[..., :3])
        f.depth_m = self.m_depth.get_data()
        # SDK confidence: 0 = most confident, 100 = least. Wire format: 255 = best.
        c = self.m_conf.get_data()
        f.conf = np.clip(255.0 - c * 2.55, 0, 255).astype(np.uint8)
        f.fx, f.fy, f.cx, f.cy = self.fx, self.fy, self.cx, self.cy
        state = self.cam.get_position(self.pose, sl.REFERENCE_FRAME.WORLD)
        f.tracking = str(state).split(".")[-1]
        f.pose = np.array(self.pose.pose_data().m, dtype=np.float64).reshape(4, 4)
        # Floor plane: with set_floor_as_origin the world origin is on the floor (y=0). Without it, ask
        # the SDK for the floor plane once tracking is OK (every 2 s until found).
        if not self.floor_origin and f.tracking == "OK" and time.perf_counter() - self.floor_checked_at > 2.0:
            self.floor_checked_at = time.perf_counter()
            plane = sl.Plane()
            reset_tf = sl.Transform()
            if self.cam.find_floor_plane(plane, reset_tf) == sl.ERROR_CODE.SUCCESS:
                center = plane.get_center()
                self.floor_y = float(center[1])
        f.floor_y = self.floor_y
        return f

    def reset(self) -> None:
        self.cam.reset_positional_tracking(self.sl.Transform())

    def close(self) -> None:
        try:
            self.cam.disable_positional_tracking()
        finally:
            self.cam.close()


def _pose_matrix(x: float, y: float, z: float, yaw: float, pitch: float) -> np.ndarray:
    cy, sy = math.cos(yaw), math.sin(yaw)
    cp, sp = math.cos(pitch), math.sin(pitch)
    ry = np.array([[cy, 0, sy], [0, 1, 0], [-sy, 0, cy]])
    rx = np.array([[1, 0, 0], [0, cp, -sp], [0, sp, cp]])
    m = np.eye(4)
    m[:3, :3] = ry @ rx
    m[:3, 3] = [x, y, z]
    return m


# ---------------------------------------------------------------------------
# Encoding
# ---------------------------------------------------------------------------


class Encoder:
    def __init__(self, jpeg_width: int, depth_width: int, quality: int = 80) -> None:
        self.jpeg_width = jpeg_width
        self.depth_width = depth_width
        self.quality = quality

    def encode(self, f: Frame) -> tuple[bytes, dict[str, Any]]:
        assert f.bgr is not None and f.depth_m is not None and f.conf is not None
        src_h, src_w = f.bgr.shape[:2]
        jw = min(self.jpeg_width, src_w)
        jh = round(src_h * jw / src_w)
        dw = min(self.depth_width, f.depth_m.shape[1])
        dh = round(f.depth_m.shape[0] * dw / f.depth_m.shape[1])
        if cv2 is not None:
            img = f.bgr if jw == src_w else cv2.resize(f.bgr, (jw, jh), interpolation=cv2.INTER_AREA)
            ok, jpeg = cv2.imencode(".jpg", img, [int(cv2.IMWRITE_JPEG_QUALITY), self.quality])
            jpeg_bytes = jpeg.tobytes() if ok else b""
            depth = f.depth_m if dw == f.depth_m.shape[1] else cv2.resize(f.depth_m, (dw, dh), interpolation=cv2.INTER_NEAREST)
            conf = f.conf if dw == f.conf.shape[1] else cv2.resize(f.conf, (dw, dh), interpolation=cv2.INTER_NEAREST)
        else:  # pragma: no cover - opencv is a hard requirement for the JPEG; kept so --fake still imports
            jpeg_bytes = b""
            depth, conf = f.depth_m, f.conf
        depth = np.nan_to_num(depth, nan=0.0, posinf=0.0, neginf=0.0)
        mm = np.clip(depth * 1000.0, 0, 65535).astype(np.uint16)
        valid = mm[mm > 0]
        depth_blob = zlib.compress(np.ascontiguousarray(mm).tobytes(), 3)
        conf_blob = zlib.compress(np.ascontiguousarray(conf).tobytes(), 3)
        header = {
            "v": 1,
            "frame": f.index,
            "timestamp": f.timestamp_ms,
            "sentAt": time.time() * 1000.0,
            "width": jw,
            "height": jh,
            "fx": f.fx * jw / src_w,
            "fy": f.fy * jh / src_h,
            "cx": f.cx * jw / src_w,
            "cy": f.cy * jh / src_h,
            "depthWidth": int(mm.shape[1]),
            "depthHeight": int(mm.shape[0]),
            "pose": [float(v) for v in f.pose.flatten(order="F")],
            "trackingState": f.tracking,
            "depthMin": float(valid.min()) / 1000.0 if valid.size else 0.0,
            "depthMax": float(valid.max()) / 1000.0 if valid.size else 0.0,
            "floorY": f.floor_y,
        }
        hb = json.dumps(header, separators=(",", ":")).encode("utf-8")
        msg = b"".join([
            struct.pack("<I", len(hb)), hb,
            struct.pack("<I", len(jpeg_bytes)), jpeg_bytes,
            struct.pack("<I", len(depth_blob)), depth_blob,
            struct.pack("<I", len(conf_blob)), conf_blob,
        ])
        return msg, header


# ---------------------------------------------------------------------------
# Server
# ---------------------------------------------------------------------------


class Recorder:
    def __init__(self, path: str, seconds: float) -> None:
        self.path, self.seconds = path, seconds
        self.jpeg: list[bytes] = []
        self.depth: list[np.ndarray] = []
        self.conf: list[np.ndarray] = []
        self.pose: list[np.ndarray] = []
        self.ts: list[float] = []
        self.tracking: list[str] = []
        self.floor: list[float] = []
        self.intr: Optional[tuple[float, float, float, float]] = None
        self.t0 = time.perf_counter()
        self.done = False

    def push(self, msg: bytes, header: dict[str, Any]) -> None:
        if self.done:
            return
        hl = struct.unpack_from("<I", msg, 0)[0]
        o = 4 + hl
        jl = struct.unpack_from("<I", msg, o)[0]
        jpeg = msg[o + 4 : o + 4 + jl]
        o += 4 + jl
        dl = struct.unpack_from("<I", msg, o)[0]
        depth = np.frombuffer(zlib.decompress(msg[o + 4 : o + 4 + dl]), dtype=np.uint16).reshape(header["depthHeight"], header["depthWidth"])
        o += 4 + dl
        cl = struct.unpack_from("<I", msg, o)[0]
        conf = np.frombuffer(zlib.decompress(msg[o + 4 : o + 4 + cl]), dtype=np.uint8).reshape(header["depthHeight"], header["depthWidth"])
        self.jpeg.append(jpeg)
        self.depth.append(depth.copy())
        self.conf.append(conf.copy())
        self.pose.append(np.array(header["pose"]).reshape(4, 4, order="F"))
        self.ts.append(header["timestamp"])
        self.tracking.append(header["trackingState"])
        self.floor.append(math.nan if header["floorY"] is None else header["floorY"])
        self.intr = (header["fx"], header["fy"], header["cx"], header["cy"])
        if time.perf_counter() - self.t0 >= self.seconds:
            self.save()

    def save(self) -> None:
        if self.done or not self.ts:
            return
        self.done = True
        jpeg = np.empty(len(self.jpeg), dtype=object)
        for i, b in enumerate(self.jpeg):
            jpeg[i] = b
        np.savez_compressed(
            self.path,
            jpeg=jpeg,
            depth=np.stack(self.depth),
            conf=np.stack(self.conf),
            pose=np.stack(self.pose),
            timestamp_ms=np.array(self.ts),
            tracking=np.array(self.tracking),
            floor_y=np.array(self.floor),
            intrinsics=np.array(self.intr),
        )
        print(f"[zed-bridge] recorded {len(self.ts)} frames to {self.path}", flush=True)


class Bridge:
    def __init__(self, source: Any, encoder: Encoder, recorder: Optional[Recorder], stats_every: float = 5.0) -> None:
        self.source = source
        self.encoder = encoder
        self.recorder = recorder
        self.clients: set[Any] = set()
        self.latest: Optional[tuple[bytes, dict[str, Any]]] = None
        self.frame_event = asyncio.Event()
        self.stats_every = stats_every
        self.stopping = False
        self.pending_reset = False

    async def producer(self) -> None:
        loop = asyncio.get_running_loop()
        n = 0
        t_stats = time.perf_counter()
        enc_ms = 0.0
        bytes_sent = 0
        while not self.stopping:
            if self.pending_reset:
                self.pending_reset = False
                await loop.run_in_executor(None, self.source.reset)
            frame = await loop.run_in_executor(None, self.source.grab)
            if frame is None or frame.bgr is None:
                await asyncio.sleep(0.005)
                continue
            t0 = time.perf_counter()
            msg, header = await loop.run_in_executor(None, self.encoder.encode, frame)
            enc_ms += (time.perf_counter() - t0) * 1000.0
            self.latest = (msg, header)
            self.frame_event.set()
            if self.recorder is not None:
                self.recorder.push(msg, header)
            n += 1
            bytes_sent += len(msg)
            if time.perf_counter() - t_stats >= self.stats_every:
                dt = time.perf_counter() - t_stats
                print(f"[zed-bridge] {n / dt:.1f} fps, encode {enc_ms / max(n, 1):.1f} ms, {bytes_sent / dt / 1e6:.1f} MB/s, {len(self.clients)} client(s), tracking {header['trackingState']}, depth {header['depthMin']:.2f}..{header['depthMax']:.2f} m", flush=True)
                n, enc_ms, bytes_sent = 0, 0.0, 0
                t_stats = time.perf_counter()

    async def handler(self, ws: Any) -> None:
        self.clients.add(ws)
        print(f"[zed-bridge] client connected ({len(self.clients)})", flush=True)
        hello = {"type": "hello", "source": type(self.source).__name__, "jpegWidth": self.encoder.jpeg_width, "depthWidth": self.encoder.depth_width}
        try:
            await ws.send(json.dumps(hello))
            consumer = asyncio.create_task(self._consume(ws))
            last_frame = -1
            while True:
                await self.frame_event.wait()
                self.frame_event.clear()
                latest = self.latest
                if latest is None or latest[1]["frame"] == last_frame:
                    continue
                last_frame = latest[1]["frame"]
                # Newest-frame-only: a slow client never queues up stale frames.
                await ws.send(latest[0])
        except Exception as exc:  # connection closed
            if websockets is not None and not isinstance(exc, websockets.exceptions.ConnectionClosed):
                print(f"[zed-bridge] client error: {exc!r}", flush=True)
        finally:
            consumer.cancel()
            self.clients.discard(ws)
            print(f"[zed-bridge] client disconnected ({len(self.clients)})", flush=True)

    async def _consume(self, ws: Any) -> None:
        async for raw in ws:
            if isinstance(raw, (bytes, bytearray)):
                continue
            try:
                cmd = json.loads(raw)
            except json.JSONDecodeError:
                continue
            if cmd.get("cmd") == "reset":
                self.pending_reset = True
            elif cmd.get("cmd") == "config":
                if "jpegWidth" in cmd:
                    self.encoder.jpeg_width = int(cmd["jpegWidth"])
                if "depthWidth" in cmd:
                    self.encoder.depth_width = int(cmd["depthWidth"])
            elif cmd.get("cmd") == "ping":
                await ws.send(json.dumps({"type": "pong", "t": cmd.get("t"), "serverT": time.time() * 1000.0}))

    async def broadcaster(self) -> None:
        """Wakes handlers; each handler sends the newest frame to its own client."""
        while not self.stopping:
            await asyncio.sleep(0.5)
            self.frame_event.set()


async def run(args: argparse.Namespace) -> int:
    if serve is None:
        print("websockets is not installed: pip install websockets", file=sys.stderr)
        return 1
    if cv2 is None:
        print("opencv-python is not installed: pip install opencv-python", file=sys.stderr)
        return 1
    if args.fake:
        source: Any = FakeSource()
    elif args.play:
        source = PlaybackSource(args.play)
    else:
        try:
            source = ZedSource(args.depth_mode, args.resolution, args.fps, floor_origin=not args.no_floor_origin)
        except RuntimeError as exc:
            print(f"[zed-bridge] {exc}", file=sys.stderr, flush=True)
            return 2
    encoder = Encoder(args.jpeg_width, args.depth_width, args.jpeg_quality)
    recorder = Recorder(args.record, args.seconds) if args.record else None
    bridge = Bridge(source, encoder, recorder)
    print(f"[zed-bridge] ready on ws://{args.host}:{args.port} ({type(source).__name__}, jpeg {args.jpeg_width}px, depth {args.depth_width}px)", flush=True)
    producer = asyncio.create_task(bridge.producer())
    try:
        async with serve(bridge.handler, args.host, args.port, max_size=None, compression=None):
            if args.seconds and not args.record:
                await asyncio.sleep(args.seconds)
            elif recorder is not None:
                while not recorder.done:
                    await asyncio.sleep(0.2)
            else:
                await asyncio.Future()
    except (KeyboardInterrupt, asyncio.CancelledError):
        pass
    finally:
        bridge.stopping = True
        producer.cancel()
        if recorder is not None:
            recorder.save()
        source.close()
    return 0


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--host", default="localhost")
    ap.add_argument("--port", type=int, default=DEFAULT_PORT)
    ap.add_argument("--fake", action="store_true", help="synthetic scene instead of the camera (no SDK needed)")
    ap.add_argument("--play", metavar="NPZ", help="replay a --record sequence instead of the camera")
    ap.add_argument("--record", metavar="NPZ", help="save the streamed sequence to this .npz and exit after --seconds")
    ap.add_argument("--seconds", type=float, default=0.0, help="run for this long then exit (0 = forever; --record defaults to 10)")
    ap.add_argument("--depth-mode", default="NEURAL", choices=["NEURAL_PLUS", "NEURAL", "NEURAL_LIGHT", "ULTRA", "QUALITY", "PERFORMANCE"])
    ap.add_argument("--resolution", default="HD720", choices=["HD720", "HD1080", "VGA"])
    ap.add_argument("--fps", type=int, default=30)
    ap.add_argument("--jpeg-width", type=int, default=DEFAULT_JPEG_WIDTH, help="passthrough width (640 or 1280)")
    ap.add_argument("--jpeg-quality", type=int, default=80)
    ap.add_argument("--depth-width", type=int, default=DEFAULT_DEPTH_WIDTH, help="depth/confidence grid width (320 or 640)")
    ap.add_argument("--no-floor-origin", action="store_true", help="do not put the tracking origin on the floor; publish find_floor_plane instead")
    args = ap.parse_args()
    if args.record and not args.seconds:
        args.seconds = 10.0
    try:
        return asyncio.run(run(args))
    except KeyboardInterrupt:
        return 0


if __name__ == "__main__":
    sys.exit(main())
