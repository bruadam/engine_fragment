import { GeometryHasher } from "../geometry-hasher";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Build a simple tetrahedron (4 faces, 4 vertices). */
function makeTetrahedron(): {
  positions: Float32Array;
  indices: Uint32Array;
} {
  // prettier-ignore
  const positions = new Float32Array([
    0, 0, 0,   // v0
    1, 0, 0,   // v1
    0, 1, 0,   // v2
    0, 0, 1,   // v3
  ]);
  // prettier-ignore
  const indices = new Uint32Array([
    0, 1, 2,
    0, 1, 3,
    0, 2, 3,
    1, 2, 3,
  ]);
  return { positions, indices };
}

/** Build a flat triangle. */
function makeTriangle(): {
  positions: Float32Array;
  indices: Uint32Array;
} {
  // prettier-ignore
  const positions = new Float32Array([
    0, 0, 0,
    1, 0, 0,
    0, 1, 0,
  ]);
  const indices = new Uint32Array([0, 1, 2]);
  return { positions, indices };
}

// ---------------------------------------------------------------------------
// hashMeshBuffers – determinism
// ---------------------------------------------------------------------------

describe("GeometryHasher.hashMeshBuffers", () => {
  test("returns a 16-character hex string", () => {
    const { positions, indices } = makeTriangle();
    const hash = GeometryHasher.hashMeshBuffers(positions, indices);
    expect(hash).toMatch(/^[0-9a-f]{16}$/);
  });

  test("identical geometry produces the same hash on repeated calls", () => {
    const { positions, indices } = makeTetrahedron();
    const h1 = GeometryHasher.hashMeshBuffers(positions, indices);
    const h2 = GeometryHasher.hashMeshBuffers(positions, indices);
    expect(h1).toBe(h2);
  });

  test("different geometry produces a different hash", () => {
    const { positions: p1, indices: i1 } = makeTriangle();
    // Move one vertex slightly.
    const p2 = p1.slice();
    p2[3] = 2; // v1.x = 2 instead of 1
    const h1 = GeometryHasher.hashMeshBuffers(p1, i1);
    const h2 = GeometryHasher.hashMeshBuffers(p2, i1);
    expect(h1).not.toBe(h2);
  });

  test("hash is stable across Float32Array and Float64Array inputs", () => {
    const { positions: f32, indices } = makeTriangle();
    const f64 = new Float64Array(f32);
    const h1 = GeometryHasher.hashMeshBuffers(f32, indices);
    const h2 = GeometryHasher.hashMeshBuffers(f64, indices);
    // Both should be equal because the quantised values are the same.
    expect(h1).toBe(h2);
  });

  test("hash is stable across Uint8Array and Uint32Array index buffers", () => {
    const { positions, indices: u32 } = makeTriangle();
    const u8 = new Uint8Array(u32); // vertices 0–3 fit in a single byte
    const h1 = GeometryHasher.hashMeshBuffers(positions, u32);
    const h2 = GeometryHasher.hashMeshBuffers(positions, u8);
    expect(h1).toBe(h2);
  });
});

// ---------------------------------------------------------------------------
// hashMeshBuffers – normalisation (order independence)
// ---------------------------------------------------------------------------

describe("GeometryHasher.hashMeshBuffers – order independence", () => {
  test("triangle with reversed winding order hashes equally", () => {
    const { positions } = makeTriangle();
    const fwd = new Uint32Array([0, 1, 2]);
    const rev = new Uint32Array([2, 1, 0]);
    expect(GeometryHasher.hashMeshBuffers(positions, fwd)).toBe(
      GeometryHasher.hashMeshBuffers(positions, rev),
    );
  });

  test("triangle with rotated vertex order hashes equally", () => {
    const { positions } = makeTriangle();
    const abc = new Uint32Array([0, 1, 2]);
    const bca = new Uint32Array([1, 2, 0]);
    const cab = new Uint32Array([2, 0, 1]);
    const hABC = GeometryHasher.hashMeshBuffers(positions, abc);
    expect(GeometryHasher.hashMeshBuffers(positions, bca)).toBe(hABC);
    expect(GeometryHasher.hashMeshBuffers(positions, cab)).toBe(hABC);
  });

  test("two triangles with swapped triangle order hash equally", () => {
    // Mesh: two triangles sharing an edge.
    // prettier-ignore
    const positions = new Float32Array([
      0, 0, 0,
      1, 0, 0,
      0, 1, 0,
      1, 1, 0,
    ]);
    const order1 = new Uint32Array([0, 1, 2, 1, 3, 2]);
    const order2 = new Uint32Array([1, 3, 2, 0, 1, 2]);
    expect(GeometryHasher.hashMeshBuffers(positions, order1)).toBe(
      GeometryHasher.hashMeshBuffers(positions, order2),
    );
  });
});

// ---------------------------------------------------------------------------
// hashMeshBuffers – quantisation epsilon
// ---------------------------------------------------------------------------

describe("GeometryHasher.hashMeshBuffers – quantisation epsilon", () => {
  test("sub-epsilon position differences produce the same hash", () => {
    const eps = GeometryHasher.DEFAULT_EPSILON;
    const { indices } = makeTriangle();

    // Base positions
    const p1 = new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]);
    // Positions shifted by half epsilon – should quantise to the same grid cell.
    const p2 = new Float32Array([
      eps * 0.4,
      0,
      0,
      1 + eps * 0.4,
      0,
      0,
      0,
      1 + eps * 0.4,
      0,
    ]);

    expect(GeometryHasher.hashMeshBuffers(p1, indices)).toBe(
      GeometryHasher.hashMeshBuffers(p2, indices),
    );
  });

  test("supra-epsilon position differences produce different hashes", () => {
    const eps = GeometryHasher.DEFAULT_EPSILON;
    const { indices } = makeTriangle();

    const p1 = new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]);
    // Shift one vertex by 2× epsilon – different grid cell, different hash.
    const p2 = new Float32Array([0, 0, 0, 1 + eps * 2, 0, 0, 0, 1, 0]);

    expect(GeometryHasher.hashMeshBuffers(p1, indices)).not.toBe(
      GeometryHasher.hashMeshBuffers(p2, indices),
    );
  });

  test("custom epsilon controls the precision threshold", () => {
    const coarseEps = 1.0; // 1 m precision
    const { indices } = makeTriangle();

    const p1 = new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]);
    // Shift by 0.3 m – within 1 m grid, same cell.
    const p2 = new Float32Array([0.3, 0, 0, 1.3, 0, 0, 0, 1, 0]);

    expect(GeometryHasher.hashMeshBuffers(p1, indices, coarseEps)).toBe(
      GeometryHasher.hashMeshBuffers(p2, indices, coarseEps),
    );
  });
});

// ---------------------------------------------------------------------------
// hashAllMeshBuffers – multi-part meshes
// ---------------------------------------------------------------------------

describe("GeometryHasher.hashAllMeshBuffers", () => {
  test("returns a 16-character hex string", () => {
    const { positions, indices } = makeTetrahedron();
    const hash = GeometryHasher.hashAllMeshBuffers([{ positions, indices }]);
    expect(hash).toMatch(/^[0-9a-f]{16}$/);
  });

  test("single part matches hashMeshBuffers result", () => {
    const { positions, indices } = makeTetrahedron();
    const h1 = GeometryHasher.hashMeshBuffers(positions, indices);
    const h2 = GeometryHasher.hashAllMeshBuffers([{ positions, indices }]);
    expect(h1).toBe(h2);
  });

  test("result is independent of the order in which parts are provided", () => {
    const partA = makeTriangle();
    // prettier-ignore
    const partB = {
      positions: new Float32Array([1, 0, 0, 2, 0, 0, 1, 1, 0]),
      indices: new Uint32Array([0, 1, 2]),
    };

    const h1 = GeometryHasher.hashAllMeshBuffers([partA, partB]);
    const h2 = GeometryHasher.hashAllMeshBuffers([partB, partA]);
    expect(h1).toBe(h2);
  });

  test("empty mesh array returns a stable hash", () => {
    const h1 = GeometryHasher.hashAllMeshBuffers([]);
    const h2 = GeometryHasher.hashAllMeshBuffers([]);
    expect(h1).toBe(h2);
    expect(h1).toMatch(/^[0-9a-f]{16}$/);
  });

  test("adding an extra part changes the hash", () => {
    const { positions, indices } = makeTriangle();
    const extra = {
      positions: new Float32Array([5, 5, 5, 6, 5, 5, 5, 6, 5]),
      indices: new Uint32Array([0, 1, 2]),
    };

    const h1 = GeometryHasher.hashAllMeshBuffers([{ positions, indices }]);
    const h2 = GeometryHasher.hashAllMeshBuffers([
      { positions, indices },
      extra,
    ]);
    expect(h1).not.toBe(h2);
  });
});
