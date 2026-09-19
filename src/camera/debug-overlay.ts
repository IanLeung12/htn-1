/**
 * Wireframe debug overlay for the general-camera backend: draws the
 * `EstimatedSurface`s and `DetectedVolume`s the SurfaceEstimator publishes
 * directly into the three.js scene, so the owner can see what the pipeline
 * produced without reading the diagnostics panel's numbers. Purely visual;
 * never mutates its inputs. Toggle with the `v` key (wired by app.ts).
 */
import * as THREE from 'three';
import type { EstimatedSurface } from './contract';
import type { DetectedVolume } from '@/capture/contract';
import type { Aabb } from '@/core/types';

const FLOOR_COLOR = 0x00ff00;
const TABLE_COLOR = 0x00ffff;
const VERTICAL_COLOR = 0xff00ff;
const VOLUME_COLOR = 0xffa500;

/** Minimum aabb/pose movement, metres, before a pooled mesh's transform is rewritten. */
const CHANGE_EPS_M = 0.01;

interface SurfaceEntry {
  mesh: THREE.LineSegments;
  min: { x: number; y: number; z: number };
  max: { x: number; y: number; z: number };
}

interface VolumeEntry {
  mesh: THREE.LineSegments;
  px: number;
  py: number;
  pz: number;
  hx: number;
  hy: number;
  hz: number;
  qx: number;
  qy: number;
  qz: number;
  qw: number;
}

function aabbChanged(a: SurfaceEntry, aabb: Aabb): boolean {
  return (
    Math.abs(a.min.x - aabb.min.x) > CHANGE_EPS_M ||
    Math.abs(a.min.y - aabb.min.y) > CHANGE_EPS_M ||
    Math.abs(a.min.z - aabb.min.z) > CHANGE_EPS_M ||
    Math.abs(a.max.x - aabb.max.x) > CHANGE_EPS_M ||
    Math.abs(a.max.y - aabb.max.y) > CHANGE_EPS_M ||
    Math.abs(a.max.z - aabb.max.z) > CHANGE_EPS_M
  );
}

function volumeChanged(v: VolumeEntry, volume: DetectedVolume): boolean {
  return (
    Math.abs(v.px - volume.pose.position.x) > CHANGE_EPS_M ||
    Math.abs(v.py - volume.pose.position.y) > CHANGE_EPS_M ||
    Math.abs(v.pz - volume.pose.position.z) > CHANGE_EPS_M ||
    Math.abs(v.hx - volume.halfExtents.x) > CHANGE_EPS_M ||
    Math.abs(v.hy - volume.halfExtents.y) > CHANGE_EPS_M ||
    Math.abs(v.hz - volume.halfExtents.z) > CHANGE_EPS_M ||
    v.qx !== volume.pose.rotation.x ||
    v.qy !== volume.pose.rotation.y ||
    v.qz !== volume.pose.rotation.z ||
    v.qw !== volume.pose.rotation.w
  );
}

function applyAabb(mesh: THREE.LineSegments, aabb: Aabb): void {
  const sx = Math.max(aabb.max.x - aabb.min.x, 0.001);
  const sy = Math.max(aabb.max.y - aabb.min.y, 0.001);
  const sz = Math.max(aabb.max.z - aabb.min.z, 0.001);
  mesh.scale.set(sx, sy, sz);
  mesh.position.set((aabb.min.x + aabb.max.x) / 2, (aabb.min.y + aabb.max.y) / 2, (aabb.min.z + aabb.max.z) / 2);
  mesh.quaternion.identity();
}

function applyVolume(mesh: THREE.LineSegments, volume: DetectedVolume): void {
  mesh.scale.set(
    Math.max(volume.halfExtents.x * 2, 0.001),
    Math.max(volume.halfExtents.y * 2, 0.001),
    Math.max(volume.halfExtents.z * 2, 0.001),
  );
  mesh.position.set(volume.pose.position.x, volume.pose.position.y, volume.pose.position.z);
  mesh.quaternion.set(volume.pose.rotation.x, volume.pose.rotation.y, volume.pose.rotation.z, volume.pose.rotation.w);
}

/**
 * Wireframe visualisation of the estimated surfaces and volumes. `group` is
 * the only thing the app touches directly: add it to the scene once, call
 * `update` each time the estimator publishes, and `dispose` on teardown.
 */
export class SceneDebugOverlay {
  readonly group: THREE.Group;

  private readonly unitBoxEdges: THREE.EdgesGeometry;
  private readonly surfaceEntries = new Map<string, SurfaceEntry>();
  private readonly volumeEntries = new Map<string, VolumeEntry>();
  private readonly axisGroup: THREE.LineSegments;

  constructor() {
    this.group = new THREE.Group();
    this.group.name = 'camera-debug-overlay';

    this.unitBoxEdges = new THREE.EdgesGeometry(new THREE.BoxGeometry(1, 1, 1));

    this.axisGroup = this.buildAxisMarker();
    this.group.add(this.axisGroup);
  }

  private buildAxisMarker(): THREE.LineSegments {
    const len = 0.2;
    const positions = new Float32Array([
      0, 0, 0, len, 0, 0, // x
      0, 0, 0, 0, len, 0, // y
      0, 0, 0, 0, 0, len, // z
    ]);
    const colors = new Float32Array([
      1, 0, 0, 1, 0, 0,
      0, 1, 0, 0, 1, 0,
      0, 0, 1, 0, 0, 1,
    ]);
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    geometry.setAttribute('color', new THREE.BufferAttribute(colors, 3));
    const material = new THREE.LineBasicMaterial({ vertexColors: true, depthTest: false });
    const lines = new THREE.LineSegments(geometry, material);
    lines.renderOrder = 100;
    lines.frustumCulled = false;
    return lines;
  }

  private makeMesh(color: number): THREE.LineSegments {
    const material = new THREE.LineBasicMaterial({ color, depthTest: false });
    const mesh = new THREE.LineSegments(this.unitBoxEdges, material);
    mesh.renderOrder = 100;
    mesh.frustumCulled = false;
    this.group.add(mesh);
    return mesh;
  }

  update(surfaces: readonly EstimatedSurface[], volumes: readonly DetectedVolume[]): void {
    const seenSurfaceIds = new Set<string>();
    for (const est of surfaces) {
      const { surface } = est;
      if (surface.orientation !== 'horizontal' && surface.orientation !== 'vertical') continue;
      seenSurfaceIds.add(surface.id);
      let entry = this.surfaceEntries.get(surface.id);
      if (!entry) {
        const color = surface.orientation === 'vertical' ? VERTICAL_COLOR : surface.label === 'floor' ? FLOOR_COLOR : TABLE_COLOR;
        const mesh = this.makeMesh(color);
        entry = { mesh, min: { x: NaN, y: NaN, z: NaN }, max: { x: NaN, y: NaN, z: NaN } };
        this.surfaceEntries.set(surface.id, entry);
      }
      entry.mesh.visible = true;
      if (aabbChanged(entry, surface.aabb)) {
        applyAabb(entry.mesh, surface.aabb);
        entry.min = { ...surface.aabb.min };
        entry.max = { ...surface.aabb.max };
      }
    }
    for (const [id, entry] of this.surfaceEntries) {
      if (!seenSurfaceIds.has(id)) entry.mesh.visible = false;
    }

    const seenVolumeIds = new Set<string>();
    for (const volume of volumes) {
      seenVolumeIds.add(volume.id);
      let entry = this.volumeEntries.get(volume.id);
      if (!entry) {
        const mesh = this.makeMesh(VOLUME_COLOR);
        entry = { mesh, px: NaN, py: NaN, pz: NaN, hx: NaN, hy: NaN, hz: NaN, qx: NaN, qy: NaN, qz: NaN, qw: NaN };
        this.volumeEntries.set(volume.id, entry);
      }
      entry.mesh.visible = true;
      if (volumeChanged(entry, volume)) {
        applyVolume(entry.mesh, volume);
        entry.px = volume.pose.position.x;
        entry.py = volume.pose.position.y;
        entry.pz = volume.pose.position.z;
        entry.hx = volume.halfExtents.x;
        entry.hy = volume.halfExtents.y;
        entry.hz = volume.halfExtents.z;
        entry.qx = volume.pose.rotation.x;
        entry.qy = volume.pose.rotation.y;
        entry.qz = volume.pose.rotation.z;
        entry.qw = volume.pose.rotation.w;
      }
    }
    for (const [id, entry] of this.volumeEntries) {
      if (!seenVolumeIds.has(id)) entry.mesh.visible = false;
    }
  }

  setVisible(visible: boolean): void {
    this.group.visible = visible;
  }

  dispose(): void {
    // Meshes share `unitBoxEdges`, disposed once below; only their per-mesh materials are owned here.
    for (const entry of this.surfaceEntries.values()) {
      (entry.mesh.material as THREE.Material).dispose();
    }
    for (const entry of this.volumeEntries.values()) {
      (entry.mesh.material as THREE.Material).dispose();
    }
    this.surfaceEntries.clear();
    this.volumeEntries.clear();
    this.unitBoxEdges.dispose();
    (this.axisGroup.geometry as THREE.BufferGeometry).dispose();
    (this.axisGroup.material as THREE.Material).dispose();
    this.group.clear();
  }
}
