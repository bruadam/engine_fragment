# git-ifc hooks — API reference

`packages/fragments/src/GitIFC` exposes a minimal, stable TypeScript API that
external `git-ifc` importers can call to build IFC-native versioned snapshots
on top of the `@thatopen/fragments` engine.

The module adds **zero new runtime dependencies** – all hashing is implemented
in pure TypeScript using FNV-1a 64-bit (two independent 32-bit passes).

---

## Terminology

| Term | Meaning |
|------|---------|
| **project** | A collection of IFC disciplines (ARC, MEP, STR, …) versioned together. |
| **discipline** / **stream** | One IFC source (e.g. architectural model). In git terms this is a branch namespace. |
| **version** | An immutable snapshot of one discipline at a point in time (analogous to a git commit). |
| **element key** | `(disciplineId, ifcGuid)` — the globally stable identity of one IFC element. |
| **channel** | A named aspect of an element that is tracked separately for diffing (e.g. `IfcProduct.ObjectPlacement`, `IfcObject.IsDefinedBy`). |

---

## Exported interfaces

### `ElementIndexEntry`

A single record in the discipline element index.

```ts
interface ElementIndexEntry {
  localId:    number;   // session-local ID from the fragment loader
  guid:       string;   // IFC GlobalId (stable across deliveries)
  ifcType:    string;   // e.g. "IFCWALL", "IFCBEAM"
  name?:      string;   // IfcRoot.Name
  description?: string; // IfcRoot.Description
  objectType?:  string; // IfcObject.ObjectType
}
```

### `ElementGeometryData`

Per-element geometry snapshot for content-addressed versioning.

```ts
interface ElementGeometryData {
  guid:          string;    // IFC GlobalId
  geometryHash:  string;    // 16-char hex deterministic fingerprint
  boundingBox:   [number, number, number, number, number, number]; // [minX,minY,minZ,maxX,maxY,maxZ]
  triangleCount: number;    // total triangles across all geometry parts
  worldTransform: number[]; // column-major 4×4 matrix (THREE.Matrix4.elements)
}
```

### `ElementIndexProvider`

```ts
interface ElementIndexProvider {
  enumerateElements(model: FragmentsModel): AsyncIterable<ElementIndexEntry>;
}
```

### `FragmentGeometryProvider`

```ts
interface FragmentGeometryProvider {
  getGeometryData(model: FragmentsModel, guid: string): Promise<ElementGeometryData | null>;
}
```

---

## Default implementations

### `FragmentElementIndex`

Default `ElementIndexProvider`.  Internally calls `model.getLocalIds()`,
`model.getGuidsByLocalIds()`, and `item.getCategory()` / `item.getAttributes()`
in configurable batches to minimise worker round-trips.

```ts
import { FragmentElementIndex } from "@thatopen/fragments";

const indexer = new FragmentElementIndex(/* batchSize = 500 */);

for await (const entry of indexer.enumerateElements(model)) {
  console.log(`${entry.guid}  ${entry.ifcType}  ${entry.name ?? "—"}`);
}
```

### `FragmentGeometryProviderImpl`

Default `FragmentGeometryProvider`.

```ts
import { FragmentGeometryProviderImpl } from "@thatopen/fragments";

const provider = new FragmentGeometryProviderImpl(/* epsilon = 0.0001 */);

const data = await provider.getGeometryData(model, "2fHkXq…");
if (data) {
  const { geometryHash, boundingBox, triangleCount, worldTransform } = data;
}
```

### `GeometryHasher`

Pure utility — no `FragmentsModel` required.

```ts
import { GeometryHasher } from "@thatopen/fragments";

// Single mesh
const hash = GeometryHasher.hashMeshBuffers(positions, indices);

// Multiple parts (e.g. element with several geometry pieces)
const hash = GeometryHasher.hashAllMeshBuffers([
  { positions: p1, indices: i1 },
  { positions: p2, indices: i2 },
]);
```

---

## How to call the APIs in a git-ifc importer

```ts
import { FragmentsModels, FragmentElementIndex, FragmentGeometryProviderImpl }
  from "@thatopen/fragments";

async function buildSnapshot(fragmentBuffer: ArrayBuffer, disciplineId: string) {
  const fragments = new FragmentsModels(workerUrl);
  const model = await fragments.load(fragmentBuffer, { modelId: disciplineId });

  const indexer  = new FragmentElementIndex();
  const provider = new FragmentGeometryProviderImpl();

  const records: Record<string, {
    index: import("@thatopen/fragments").ElementIndexEntry;
    geom:  import("@thatopen/fragments").ElementGeometryData | null;
  }> = {};

  for await (const entry of indexer.enumerateElements(model)) {
    const geom = await provider.getGeometryData(model, entry.guid);
    records[`${disciplineId}:${entry.guid}`] = { index: entry, geom };
  }

  return records;
}
```

---

## Determinism guarantees

| Property | Guarantee |
|----------|-----------|
| **Same geometry, same epsilon** → same `geometryHash` | ✅ |
| **Vertex order independence** | ✅ Vertices within each triangle are sorted; triangles are globally sorted before hashing |
| **Floating-point tolerance** | ✅ Sub-epsilon differences (< `DEFAULT_EPSILON = 0.0001` m) hash equally |
| **Float32 vs Float64 input** | ✅ Quantisation normalises both to the same grid |
| **Mesh part order independence** (`hashAllMeshBuffers`) | ✅ All triangles across parts are globally sorted |
| **Different geometry** → different hash | ✅ with high probability (FNV-1a 64-bit, ~1.8 × 10⁻¹⁹ collision probability per pair) |

> **Note**: `geometryHash` is computed in **world space** – vertex positions are
> transformed by the part's local matrix before hashing.  A pure placement
> change (model moved) therefore produces a different `geometryHash`.  This is
> intentional: it ensures the `IfcProduct.ObjectPlacement` channel and the
> `FragmentGeometry` channel both fire on placement changes.

If you need a **shape-only** fingerprint (independent of placement), apply the
world transform's inverse before calling `GeometryHasher.hashMeshBuffers`
directly.

---

## Mapping to git-ifc element record channels

Each `ElementGeometryData` can be stored as a set of channel hashes in a
git-ifc element record:

| git-ifc channel | Source field / derivation |
|-----------------|---------------------------|
| `FragmentGeometry` | `geometryHash` |
| `IfcProduct.Representation` | `geometryHash` (shape change implies representation change) |
| `IfcProduct.ObjectPlacement` | `worldTransform` — compute `sha256` (or FNV) of the 16 matrix values quantised to epsilon |
| `bbox_world` | `boundingBox` |
| `IfcRoot.*` | `ElementIndexEntry.name`, `.description`, `.objectType` |

Downstream tools implementing capability maps:

```ts
// Spatial-impact capability: element moved or its shape changed
function isSpatialImpact(prev: ElementGeometryData, next: ElementGeometryData) {
  return (
    prev.geometryHash !== next.geometryHash ||
    !bboxEquals(prev.boundingBox, next.boundingBox)
  );
}

// Metadata-impact capability: element name / type changed
function isMetadataImpact(prev: ElementIndexEntry, next: ElementIndexEntry) {
  return (
    prev.name        !== next.name        ||
    prev.description !== next.description ||
    prev.objectType  !== next.objectType
  );
}
```

---

## Interoperability with CDEs

`git-ifc` is IFC-native: the canonical exchange format between CDEs (Autodesk
ACC, Dalux Box, Speckle with IFC connector, etc.) is always a standard IFC
file.  The fragment-based hooks described above are used only during import —
the resulting versioned records are keyed by `IfcGuid` and schema paths that
map directly to IFC concepts, making the data portable across any CDE that
supports IFC exchange.

```
IFC file (from CDE)
       │
       ▼
  engine_fragment importer
       │
  FragmentElementIndex ──► element keys (guid + type + metadata)
  FragmentGeometryProviderImpl ──► geometry fingerprints + bbox + transforms
       │
       ▼
  git-ifc commit (schema-path channels keyed by IfcGuid)
       │
       ▼
  diff / export back to IFC for CDE round-trip
```

---

## Running the unit tests

```bash
cd packages/fragments
yarn test
```

The geometry-hasher tests in
`src/GitIFC/__tests__/geometry-hasher.test.ts` cover:

- Hash stability (same buffers → same hash across invocations)
- Winding-order independence
- Triangle-order independence
- Sub-epsilon and supra-epsilon quantisation behaviour
- Multi-part mesh hashing (`hashAllMeshBuffers`)
- Part-order independence

No IFC files or network access are required.
