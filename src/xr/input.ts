/**
 * Hands + controllers input tracking.
 *
 * Produces a per-frame InputState with a unified "grab point" pose per hand
 * (pinch midpoint for hand-tracking, grip pose for controllers), pinch/select
 * edges, and a pointer ray for hover/raycasts. All temporaries are reused
 * across frames - no per-frame allocation beyond the small InputState object
 * itself (which is small plain data, not object3d graphs).
 */
import * as THREE from 'three';

export type Handedness = 'left' | 'right';

/** Hoisted so the per-frame hand/controller loops don't allocate a tuple literal every call. */
const HANDEDNESSES: readonly Handedness[] = ['left', 'right'];

export interface RayPose {
  origin: THREE.Vector3;
  direction: THREE.Vector3;
}

export interface HandState {
  /** True if we have any pose data this frame (controller connected or hand tracked). */
  active: boolean;
  /** 0..1: 1 = full confidence (all joints reporting), 0 = no data. */
  confidence: number;
  /** World-space grab point (pinch midpoint or controller grip position+orientation). */
  position: THREE.Vector3;
  quaternion: THREE.Quaternion;
  pinching: boolean;
  selectStart: boolean;
  selectEnd: boolean;
  ray: RayPose;
  /** 'hand' when driven by hand-tracking joints, 'controller' otherwise, 'none' if inactive. */
  source: 'hand' | 'controller' | 'none';
  /** World-space wrist joint pose (hand-tracking only; zero/identity otherwise). Used by the hand menu. */
  wristPosition: THREE.Vector3;
  wristQuaternion: THREE.Quaternion;
  /** Approximate world-space palm-normal direction (hand-tracking only; zero length otherwise). */
  palmNormal: THREE.Vector3;
}

export interface InputState {
  left: HandState;
  right: HandState;
}

const PINCH_ON_DIST = 0.02;
const PINCH_OFF_DIST = 0.028; // hysteresis: release threshold looser than engage threshold

function hideVisualGroup(group: THREE.Group): void {
  const children = group.children;
  for (let i = 0; i < children.length; i++) {
    children[i]!.visible = false;
  }
}

function makeHandState(): HandState {
  return {
    active: false,
    confidence: 0,
    position: new THREE.Vector3(),
    quaternion: new THREE.Quaternion(),
    pinching: false,
    selectStart: false,
    selectEnd: false,
    ray: { origin: new THREE.Vector3(), direction: new THREE.Vector3(0, 0, -1) },
    source: 'none',
    wristPosition: new THREE.Vector3(),
    wristQuaternion: new THREE.Quaternion(),
    palmNormal: new THREE.Vector3(),
  };
}

interface HandTrack {
  index: number;
  hand: THREE.XRHandSpace;
  wasPinching: boolean;
  joints: THREE.Group | null;
  visualGroup: THREE.Group;
}

interface ControllerTrack {
  index: number;
  controller: THREE.Group;
  grip: THREE.Group;
  wasSelecting: boolean;
  rayLine: THREE.Line;
}

export class XRInput {
  readonly state: InputState = { left: makeHandState(), right: makeHandState() };
  readonly group = new THREE.Group();

  private readonly renderer: THREE.WebGLRenderer;
  private readonly hands: Record<Handedness, HandTrack>;
  private readonly controllers: Record<Handedness, ControllerTrack>;
  private readonly tmpA = new THREE.Vector3();
  private readonly tmpB = new THREE.Vector3();
  private readonly tmpC = new THREE.Vector3();
  private readonly tmpD = new THREE.Vector3();

  constructor(renderer: THREE.WebGLRenderer) {
    this.renderer = renderer;

    const indexFor = (h: Handedness): number => (h === 'left' ? 0 : 1);

    this.hands = {
      left: this.buildHandTrack(indexFor('left')),
      right: this.buildHandTrack(indexFor('right')),
    };
    this.controllers = {
      left: this.buildControllerTrack(indexFor('left')),
      right: this.buildControllerTrack(indexFor('right')),
    };
  }

  private buildHandTrack(index: number): HandTrack {
    const hand = this.renderer.xr.getHand(index) as THREE.XRHandSpace;
    const visualGroup = new THREE.Group();
    // Simple joint spheres: cheap, work under emulation without hand-model assets.
    const sphereGeo = new THREE.SphereGeometry(0.008, 8, 8);
    const sphereMat = new THREE.MeshStandardMaterial({ color: 0x66ccff });
    for (let i = 0; i < 25; i++) {
      const mesh = new THREE.Mesh(sphereGeo, sphereMat);
      mesh.visible = false;
      visualGroup.add(mesh);
    }
    hand.add(visualGroup);
    this.group.add(hand);
    return { index, hand, wasPinching: false, joints: null, visualGroup };
  }

  private buildControllerTrack(index: number): ControllerTrack {
    const controller = this.renderer.xr.getController(index);
    const grip = this.renderer.xr.getControllerGrip(index);
    const geometry = new THREE.BufferGeometry().setFromPoints([
      new THREE.Vector3(0, 0, 0),
      new THREE.Vector3(0, 0, -1),
    ]);
    const rayLine = new THREE.Line(geometry, new THREE.LineBasicMaterial({ color: 0xffffff }));
    rayLine.scale.z = 1;
    rayLine.visible = false;
    controller.add(rayLine);
    this.group.add(controller, grip);
    return { index, controller, grip, wasSelecting: false, rayLine };
  }

  /** Call once per rendered XR frame. */
  update(frame: XRFrame | undefined, refSpace: XRReferenceSpace | null): void {
    for (const handedness of HANDEDNESSES) {
      this.updateHand(handedness, frame, refSpace);
      this.updateController(handedness, frame);
    }
  }

  private updateHand(handedness: Handedness, frame: XRFrame | undefined, refSpace: XRReferenceSpace | null): void {
    const out = this.state[handedness];
    const track = this.hands[handedness];
    out.selectStart = false;
    out.selectEnd = false;

    const xrHand = (track.hand as unknown as { joints?: Record<string, THREE.XRJointSpace> }).joints;
    if (!frame || !refSpace || !xrHand || !frame.getJointPose) {
      out.active = false;
      out.confidence = 0;
      out.source = 'none';
      hideVisualGroup(track.visualGroup);
      return;
    }

    const inputSource = this.findHandSource(frame, handedness);
    const hand = inputSource?.hand;
    if (!hand) {
      out.active = false;
      out.confidence = 0;
      out.source = 'none';
      hideVisualGroup(track.visualGroup);
      return;
    }

    let reported = 0;
    let total = 0;
    let idx = 0;
    let indexTip: XRJointPose | undefined;
    let thumbTip: XRJointPose | undefined;
    let wristPose: XRJointPose | undefined;
    let indexMetaPose: XRJointPose | undefined;
    let pinkyMetaPose: XRJointPose | undefined;

    // for-of over the XRHand (a Map<XRHandJoint, XRJointSpace>) instead of
    // .forEach(), which would allocate a fresh closure every hand every frame.
    for (const [jointName, jointSpace] of hand as unknown as Map<string, XRJointSpace>) {
      total++;
      const pose = frame.getJointPose?.(jointSpace, refSpace);
      const mesh = track.visualGroup.children[idx];
      if (pose && mesh) {
        reported++;
        mesh.visible = true;
        mesh.position.set(pose.transform.position.x, pose.transform.position.y, pose.transform.position.z);
        mesh.quaternion.set(
          pose.transform.orientation.x,
          pose.transform.orientation.y,
          pose.transform.orientation.z,
          pose.transform.orientation.w,
        );
      } else if (mesh) {
        mesh.visible = false;
      }
      if (jointName === 'index-finger-tip') indexTip = pose;
      if (jointName === 'thumb-tip') thumbTip = pose;
      if (jointName === 'wrist') wristPose = pose;
      if (jointName === 'index-finger-metacarpal') indexMetaPose = pose;
      if (jointName === 'pinky-finger-metacarpal') pinkyMetaPose = pose;
      idx++;
    }

    // Wrist pose + approximate palm normal, used by the hand menu (see
    // src/render/hand-menu.ts). Written into the persistent HandState vectors
    // to avoid per-frame allocation.
    if (wristPose) {
      out.wristPosition.set(wristPose.transform.position.x, wristPose.transform.position.y, wristPose.transform.position.z);
      out.wristQuaternion.set(
        wristPose.transform.orientation.x,
        wristPose.transform.orientation.y,
        wristPose.transform.orientation.z,
        wristPose.transform.orientation.w,
      );
    } else {
      out.wristPosition.set(0, 0, 0);
      out.wristQuaternion.identity();
    }

    if (wristPose && indexMetaPose && pinkyMetaPose) {
      this.tmpC
        .set(indexMetaPose.transform.position.x, indexMetaPose.transform.position.y, indexMetaPose.transform.position.z)
        .sub(out.wristPosition);
      this.tmpD
        .set(pinkyMetaPose.transform.position.x, pinkyMetaPose.transform.position.y, pinkyMetaPose.transform.position.z)
        .sub(out.wristPosition);
      // Cross-product order flips with handedness so the normal points out of
      // the palm (away from the back of the hand) for both hands.
      if (handedness === 'left') {
        out.palmNormal.crossVectors(this.tmpD, this.tmpC).normalize();
      } else {
        out.palmNormal.crossVectors(this.tmpC, this.tmpD).normalize();
      }
    } else {
      out.palmNormal.set(0, 0, 0);
    }

    out.confidence = total > 0 ? reported / total : 0;
    out.active = out.confidence > 0;
    out.source = out.active ? 'hand' : 'none';

    if (indexTip && thumbTip) {
      this.tmpA.set(indexTip.transform.position.x, indexTip.transform.position.y, indexTip.transform.position.z);
      this.tmpB.set(thumbTip.transform.position.x, thumbTip.transform.position.y, thumbTip.transform.position.z);
      const dist = this.tmpA.distanceTo(this.tmpB);
      const threshold = track.wasPinching ? PINCH_OFF_DIST : PINCH_ON_DIST;
      const pinching = dist < threshold;
      out.selectStart = pinching && !track.wasPinching;
      out.selectEnd = !pinching && track.wasPinching;
      out.pinching = pinching;
      track.wasPinching = pinching;

      out.position.copy(this.tmpA).add(this.tmpB).multiplyScalar(0.5);
      out.quaternion.set(
        indexTip.transform.orientation.x,
        indexTip.transform.orientation.y,
        indexTip.transform.orientation.z,
        indexTip.transform.orientation.w,
      );

      out.ray.origin.copy(out.position);
      out.ray.direction.set(0, 0, -1).applyQuaternion(out.quaternion);
      if (wristPose) {
        // Better ray approximation: from wrist through index tip.
        const wrist = this.tmpB.set(
          wristPose.transform.position.x,
          wristPose.transform.position.y,
          wristPose.transform.position.z,
        );
        out.ray.origin.copy(this.tmpA);
        out.ray.direction.copy(this.tmpA).sub(wrist).normalize();
      }
    } else {
      out.pinching = false;
      out.selectEnd = track.wasPinching;
      track.wasPinching = false;
    }
  }

  private findHandSource(frame: XRFrame, handedness: Handedness): XRInputSource | undefined {
    const session = frame.session;
    for (const src of session.inputSources) {
      if (src.hand && src.handedness === handedness) return src;
    }
    return undefined;
  }

  private updateController(handedness: Handedness, frame: XRFrame | undefined): void {
    const out = this.state[handedness];
    const track = this.controllers[handedness];
    if (out.source === 'hand' && out.active) {
      track.rayLine.visible = false;
      return; // hand tracking takes priority when active
    }

    const inputSource = this.findControllerSource(frame, handedness);
    if (!inputSource) {
      out.selectStart = false;
      out.selectEnd = false;
      if (out.source === 'controller') {
        out.active = false;
        out.confidence = 0;
        out.source = 'none';
      }
      track.rayLine.visible = false;
      return;
    }

    out.active = true;
    out.confidence = 1;
    out.source = 'controller';
    track.rayLine.visible = true;

    track.grip.getWorldPosition(out.position);
    track.grip.getWorldQuaternion(out.quaternion);
    track.controller.getWorldPosition(out.ray.origin);
    out.ray.direction.set(0, 0, -1).applyQuaternion(track.controller.quaternion);
  }

  private findControllerSource(frame: XRFrame | undefined, handedness: Handedness): XRInputSource | undefined {
    if (!frame) return undefined;
    for (const src of frame.session.inputSources) {
      if (!src.hand && src.handedness === handedness && src.targetRayMode === 'tracked-pointer') return src;
    }
    return undefined;
  }

  /** Wire select/squeeze events for controllers (called once at setup). */
  bindControllerEvents(onSelectStart: (h: Handedness) => void, onSelectEnd: (h: Handedness) => void): void {
    (['left', 'right'] as const).forEach((handedness) => {
      const track = this.controllers[handedness];
      // three's Group event map doesn't include XR controller select events by
      // default typings; the runtime dispatches them regardless.
      const controller = track.controller as unknown as {
        addEventListener(type: 'selectstart' | 'selectend', listener: () => void): void;
      };
      controller.addEventListener('selectstart', () => onSelectStart(handedness));
      controller.addEventListener('selectend', () => onSelectEnd(handedness));
    });
  }

  dispose(): void {
    this.group.clear();
  }
}
