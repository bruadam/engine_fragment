import type { FragmentsModel } from "../FragmentsModels";

/**
 * A single entry in the element index, containing the stable IFC identifier
 * and schema-level classification of one IFC element (IfcProduct or
 * IfcTypeProduct).
 *
 * Used by git-ifc importers to build the per-discipline element index that
 * drives schema-aware versioning.
 */
export interface ElementIndexEntry {
  /** In-memory local ID assigned by the fragment loader for this session. */
  localId: number;

  /** Globally unique IFC identifier (IfcRoot.GlobalId). */
  guid: string;

  /**
   * IFC entity type name (e.g. `"IFCWALL"`, `"IFCBEAM"`).
   * This is the value returned by {@link FragmentsModel.getCategories} /
   * `getItemCategory`.
   */
  ifcType: string;

  /** Human-readable element name (IfcRoot.Name), if present. */
  name?: string;

  /** Element description (IfcRoot.Description), if present. */
  description?: string;

  /** Object type classification (IfcObject.ObjectType), if present. */
  objectType?: string;
}

/**
 * Geometry snapshot for a single IFC element, suitable for deterministic
 * versioning and content-addressed storage.
 *
 * All numeric values use SI units and the world coordinate system of the
 * loaded model (i.e. after applying the model's world transform).
 */
export interface ElementGeometryData {
  /** Globally unique IFC identifier – matches {@link ElementIndexEntry.guid}. */
  guid: string;

  /**
   * Deterministic geometry fingerprint produced by normalising and hashing
   * the element's mesh buffers (quantized vertices → sorted triangles →
   * FNV-1a 64-bit digest, returned as a 16-character lowercase hex string).
   *
   * The hash is stable for the same geometry regardless of:
   * - Vertex ordering within the mesh
   * - Floating-point rounding differences smaller than the quantisation
   *   epsilon (default: {@link GeometryHasher.DEFAULT_EPSILON}).
   *
   * It will **change** when:
   * - The shape itself changes (vertices / topology differs)
   * - The element's world transform changes (positions shift beyond epsilon)
   */
  geometryHash: string;

  /**
   * World-space axis-aligned bounding box as
   * `[minX, minY, minZ, maxX, maxY, maxZ]`.
   */
  boundingBox: [number, number, number, number, number, number];

  /** Total number of triangles (faces) across all geometry parts. */
  triangleCount: number;

  /**
   * Column-major 4×4 world transform matrix (16 numbers), matching
   * `THREE.Matrix4.elements` ordering.
   * This is the transform of the item's object in the scene graph.
   */
  worldTransform: number[];
}

/**
 * Provides a stable, streaming enumeration of IFC elements from a loaded
 * {@link FragmentsModel}.
 *
 * Intended for use by git-ifc importers to build the element index that
 * drives schema-aware versioning.  A default implementation backed by the
 * engine_fragment internals is available as {@link FragmentElementIndex}.
 */
export interface ElementIndexProvider {
  /**
   * Asynchronously yields one {@link ElementIndexEntry} per IFC element that
   * has a `GlobalId`.  Elements without a `GlobalId` are silently skipped.
   *
   * @param model - The loaded model to enumerate.
   */
  enumerateElements(
    model: FragmentsModel,
  ): AsyncIterable<ElementIndexEntry>;
}

/**
 * Provides per-element geometry data for IFC versioning.
 *
 * Intended for use by git-ifc importers when building geometry snapshots.
 * A default implementation backed by the engine_fragment internals is
 * available as {@link FragmentGeometryProviderImpl}.
 */
export interface FragmentGeometryProvider {
  /**
   * Returns the {@link ElementGeometryData} for the element identified by
   * `guid`, or `null` when the element cannot be found or has no geometry.
   *
   * @param model - The loaded model to query.
   * @param guid  - The IFC `GlobalId` of the element.
   */
  getGeometryData(
    model: FragmentsModel,
    guid: string,
  ): Promise<ElementGeometryData | null>;
}
