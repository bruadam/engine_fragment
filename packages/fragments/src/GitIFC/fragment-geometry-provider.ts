import * as THREE from "three";
import type { FragmentsModel } from "../FragmentsModels";
import { GeometryHasher } from "./geometry-hasher";
import type { ElementGeometryData, FragmentGeometryProvider } from "./types";

/**
 * Default {@link FragmentGeometryProvider} backed by the engine_fragment
 * `FragmentsModel` internals.
 *
 * For a given IFC `GlobalId` this implementation:
 * 1. Resolves the element's local ID.
 * 2. Fetches raw mesh buffers (positions + indices) via
 *    `FragmentsModel.getItemsGeometry`.
 * 3. Applies each part's local transform to bring positions into world space.
 * 4. Delegates hashing to {@link GeometryHasher.hashAllMeshBuffers} so the
 *    fingerprint is independent of vertex / triangle ordering.
 * 5. Reads the world-space bounding box from `FragmentsModel.getBoxes`.
 *
 * @example
 * ```ts
 * const provider = new FragmentGeometryProviderImpl();
 * const data = await provider.getGeometryData(model, "2fHkXq…");
 * if (data) {
 *   console.log(data.geometryHash, data.triangleCount, data.boundingBox);
 * }
 * ```
 */
export class FragmentGeometryProviderImpl implements FragmentGeometryProvider {
  /** Quantisation epsilon passed to {@link GeometryHasher}. */
  epsilon: number;

  constructor(epsilon = GeometryHasher.DEFAULT_EPSILON) {
    this.epsilon = epsilon;
  }

  async getGeometryData(
    model: FragmentsModel,
    guid: string,
  ): Promise<ElementGeometryData | null> {
    // ── 1. Resolve GUID → local ID ────────────────────────────────────────
    const [localId] = await model.getLocalIdsByGuids([guid]);
    if (localId == null) return null;

    // ── 2. Fetch raw geometry buffers ──────────────────────────────────────
    // getItemsGeometry returns MeshData[][] – one inner array per localId.
    const allGeometries = await model.getItemsGeometry([localId]);
    if (!allGeometries || allGeometries.length === 0) return null;

    // Take the geometry parts for our single localId.
    const meshDataArray = allGeometries[0];
    if (!meshDataArray || meshDataArray.length === 0) return null;

    // ── 3. Build mesh parts for hashing & triangle counting ───────────────
    const meshParts: Array<{
      positions: Float32Array | Float64Array;
      indices: Uint8Array | Uint16Array | Uint32Array;
    }> = [];
    let totalTriangles = 0;

    // We also track world-space AABB for computing the final bounding box.
    const worldBox = new THREE.Box3();
    worldBox.makeEmpty();

    for (const meshData of meshDataArray) {
      const { positions, indices, transform } = meshData;
      if (!positions || !indices || !transform) continue;

      const numTris = Math.floor(indices.length / 3);
      totalTriangles += numTris;

      // Apply the part-local transform to positions so the hash is computed
      // in world space (captures placement changes as hash changes).
      const worldPositions = FragmentGeometryProviderImpl._applyTransform(
        positions,
        transform,
      );

      meshParts.push({ positions: worldPositions, indices });

      // Expand the AABB using transformed vertices.
      FragmentGeometryProviderImpl._expandBox(worldBox, worldPositions);
    }

    if (meshParts.length === 0) return null;

    // ── 4. Hash all mesh parts ─────────────────────────────────────────────
    const geometryHash = GeometryHasher.hashAllMeshBuffers(
      meshParts,
      this.epsilon,
    );

    // ── 5. World bounding box ──────────────────────────────────────────────
    // Prefer the engine's own bbox computation; fall back to the one derived
    // from mesh positions if the model has not loaded tile boxes yet.
    let boundingBox: ElementGeometryData["boundingBox"];
    try {
      const boxes = await model.getBoxes([localId]);
      const box = boxes[0];
      if (box && !box.isEmpty()) {
        boundingBox = [
          box.min.x,
          box.min.y,
          box.min.z,
          box.max.x,
          box.max.y,
          box.max.z,
        ];
      } else {
        boundingBox = FragmentGeometryProviderImpl._boxToArray(worldBox);
      }
    } catch {
      boundingBox = FragmentGeometryProviderImpl._boxToArray(worldBox);
    }

    // ── 6. World transform of the model object ────────────────────────────
    const worldTransform = Array.from(model.object.matrixWorld.elements) as number[];

    return {
      guid,
      geometryHash,
      boundingBox,
      triangleCount: totalTriangles,
      worldTransform,
    };
  }

  // -------------------------------------------------------------------
  // Private helpers
  // -------------------------------------------------------------------

  /** Apply a THREE.Matrix4 to a flat positions array and return the result. */
  private static _applyTransform(
    positions: Float32Array | Float64Array,
    transform: THREE.Matrix4,
  ): Float32Array {
    const count = positions.length;
    const result = new Float32Array(count);
    const v = new THREE.Vector3();

    for (let i = 0; i + 3 <= count; i += 3) {
      v.set(
        positions[i] as number,
        positions[i + 1] as number,
        positions[i + 2] as number,
      );
      v.applyMatrix4(transform);
      result[i] = v.x;
      result[i + 1] = v.y;
      result[i + 2] = v.z;
    }

    return result;
  }

  /** Expand a THREE.Box3 using a flat positions array (no transform). */
  private static _expandBox(
    box: THREE.Box3,
    positions: Float32Array | Float64Array,
  ): void {
    const v = new THREE.Vector3();
    for (let i = 0; i + 3 <= positions.length; i += 3) {
      v.set(
        positions[i] as number,
        positions[i + 1] as number,
        positions[i + 2] as number,
      );
      box.expandByPoint(v);
    }
  }

  private static _boxToArray(
    box: THREE.Box3,
  ): ElementGeometryData["boundingBox"] {
    return [box.min.x, box.min.y, box.min.z, box.max.x, box.max.y, box.max.z];
  }
}
