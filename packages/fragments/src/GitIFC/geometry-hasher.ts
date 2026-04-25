/**
 * Pure, dependency-free geometry hashing utility for git-ifc hooks.
 *
 * Produces deterministic, normalised fingerprints from triangle-mesh buffers
 * without relying on external crypto libraries – making it safe in both
 * browser and Node environments.
 *
 * ### Normalisation algorithm
 * 1. **Quantise** every vertex coordinate to a grid of size `epsilon`
 *    (`Math.round(v / epsilon) * epsilon`).  Small floating-point variations
 *    below the threshold are therefore collapsed to the same value.
 * 2. **Sort vertices within each triangle** so that the same triangle
 *    `(A, B, C)` hashes identically regardless of winding-order permutations.
 * 3. **Sort all triangles** lexicographically so that the hash is independent
 *    of triangle ordering in the index buffer.
 * 4. **Hash** the resulting canonical byte stream with FNV-1a 64-bit
 *    (implemented as two independent 32-bit FNV-1a passes with different
 *    seeds) and return the result as a 16-character lowercase hex string.
 *
 * @example
 * ```ts
 * const positions = new Float32Array([0,0,0, 1,0,0, 0,1,0]);
 * const indices   = new Uint32Array([0, 1, 2]);
 * const hash = GeometryHasher.hashMeshBuffers(positions, indices);
 * // hash is stable across runs and environments
 * ```
 */
export class GeometryHasher {
  /** Default quantisation epsilon (in model units, typically metres). */
  static readonly DEFAULT_EPSILON = 0.0001;

  // Shared typed-array views used by floatToBytes – allocated once.
  private static readonly _f64 = new Float64Array(1);
  private static readonly _u8 = new Uint8Array(
    GeometryHasher._f64.buffer,
  );

  // FNV-1a 32-bit constants (unsigned 32-bit arithmetic via >>> 0).
  private static readonly FNV_PRIME = 16777619;
  private static readonly FNV_OFFSET_A = 2166136261; // standard FNV-1a offset basis
  private static readonly FNV_OFFSET_B = 2246822519; // second independent seed for pass B
  /**
   * Multiplicative mixer applied to FNV_PRIME in the second hash pass.
   * The value 1007 is a prime chosen to make the two 32-bit passes as
   * independent as possible while keeping the product within safe 32-bit
   * `Math.imul` range after the `>>> 0` truncation.
   */
  private static readonly FNV_PRIME_B_FACTOR = 1007;

  // -------------------------------------------------------------------
  // Public API
  // -------------------------------------------------------------------

  /**
   * Compute a normalised geometry hash from a single mesh's position and
   * index buffers.
   *
   * Positions are expected as flat `[x0,y0,z0, x1,y1,z1, …]` triples.
   * Indices are expected as flat `[i0,i1,i2, i3,i4,i5, …]` triplets (one
   * triplet per triangle).
   *
   * @param positions - Flat array of vertex coordinates (x,y,z per vertex).
   * @param indices   - Flat array of triangle indices.
   * @param epsilon   - Quantisation grid size. Defaults to
   *   {@link DEFAULT_EPSILON}.
   * @returns A 16-character lowercase hexadecimal string.
   */
  static hashMeshBuffers(
    positions: ArrayLike<number>,
    indices: ArrayLike<number>,
    epsilon = GeometryHasher.DEFAULT_EPSILON,
  ): string {
    const triangles = GeometryHasher._extractNormalised(
      positions,
      indices,
      epsilon,
    );
    return GeometryHasher._fnv1a64(triangles);
  }

  /**
   * Compute a combined normalised geometry hash from **multiple** mesh parts
   * belonging to the same element.
   *
   * Each part is a `{ positions, indices }` pair identical in shape to the
   * arguments of {@link hashMeshBuffers}.  All triangles from all parts are
   * collected, globally sorted, and hashed together – so the result is
   * independent of the order in which the parts are provided.
   *
   * @param meshes  - Array of mesh parts.
   * @param epsilon - Quantisation grid size.
   * @returns A 16-character lowercase hexadecimal string.
   */
  static hashAllMeshBuffers(
    meshes: Array<{
      positions: ArrayLike<number>;
      indices: ArrayLike<number>;
    }>,
    epsilon = GeometryHasher.DEFAULT_EPSILON,
  ): string {
    const all: number[][] = [];
    for (const { positions, indices } of meshes) {
      const tris = GeometryHasher._extractNormalised(
        positions,
        indices,
        epsilon,
      );
      for (const t of tris) all.push(t);
    }
    GeometryHasher._sortTriangles(all);
    return GeometryHasher._fnv1a64(all);
  }

  // -------------------------------------------------------------------
  // Private helpers
  // -------------------------------------------------------------------

  private static _quantise(v: number, epsilon: number): number {
    return Math.round(v / epsilon) * epsilon;
  }

  /**
   * Extract, quantise, and normalise triangles from a single mesh buffer.
   * Returns an array of 9-element arrays `[ax,ay,az, bx,by,bz, cx,cy,cz]`
   * where vertices within each triangle are sorted in lexicographic order.
   */
  private static _extractNormalised(
    positions: ArrayLike<number>,
    indices: ArrayLike<number>,
    epsilon: number,
  ): number[][] {
    const triangles: number[][] = [];
    const count = indices.length;

    for (let i = 0; i + 3 <= count; i += 3) {
      const ai = (indices[i] as number) * 3;
      const bi = (indices[i + 1] as number) * 3;
      const ci = (indices[i + 2] as number) * 3;

      const va: [number, number, number] = [
        GeometryHasher._quantise(positions[ai] as number, epsilon),
        GeometryHasher._quantise(positions[ai + 1] as number, epsilon),
        GeometryHasher._quantise(positions[ai + 2] as number, epsilon),
      ];
      const vb: [number, number, number] = [
        GeometryHasher._quantise(positions[bi] as number, epsilon),
        GeometryHasher._quantise(positions[bi + 1] as number, epsilon),
        GeometryHasher._quantise(positions[bi + 2] as number, epsilon),
      ];
      const vc: [number, number, number] = [
        GeometryHasher._quantise(positions[ci] as number, epsilon),
        GeometryHasher._quantise(positions[ci + 1] as number, epsilon),
        GeometryHasher._quantise(positions[ci + 2] as number, epsilon),
      ];

      // Sort the three vertices so winding-order permutations hash equally.
      const verts: [number, number, number][] = [va, vb, vc];
      verts.sort(GeometryHasher._cmpVertex);

      triangles.push([
        ...verts[0],
        ...verts[1],
        ...verts[2],
      ]);
    }

    GeometryHasher._sortTriangles(triangles);
    return triangles;
  }

  private static _cmpVertex(
    a: [number, number, number],
    b: [number, number, number],
  ): number {
    for (let i = 0; i < 3; i++) {
      if (a[i] !== b[i]) return (a[i] as number) - (b[i] as number);
    }
    return 0;
  }

  private static _sortTriangles(triangles: number[][]): void {
    triangles.sort((a, b) => {
      for (let i = 0; i < 9; i++) {
        const diff = (a[i] as number) - (b[i] as number);
        if (diff !== 0) return diff;
      }
      return 0;
    });
  }

  /**
   * Convert a float64 value into its 8 IEEE-754 bytes, reusing the shared
   * static buffer.
   */
  private static _f64Bytes(value: number): Readonly<Uint8Array> {
    GeometryHasher._f64[0] = value;
    return GeometryHasher._u8;
  }

  /**
   * FNV-1a 64-bit (two independent 32-bit passes) over normalised triangles.
   * Returns a 16-character lowercase hex string.
   */
  private static _fnv1a64(triangles: number[][]): string {
    const PRIME = GeometryHasher.FNV_PRIME;
    let h1 = GeometryHasher.FNV_OFFSET_A;
    let h2 = GeometryHasher.FNV_OFFSET_B;

    for (const tri of triangles) {
      for (const val of tri) {
        const bytes = GeometryHasher._f64Bytes(val);
        for (let i = 0; i < 8; i++) {
          const b = bytes[i] as number;
          // FNV-1a step: hash = (hash XOR byte) * prime (unsigned 32-bit)
          h1 = Math.imul(h1 ^ b, PRIME) >>> 0;
          // Second pass uses a prime multiple of PRIME to avoid correlation.
          h2 = Math.imul(h2 ^ b, PRIME * GeometryHasher.FNV_PRIME_B_FACTOR) >>> 0;
        }
      }
    }

    return (
      h1.toString(16).padStart(8, "0") + h2.toString(16).padStart(8, "0")
    );
  }
}
