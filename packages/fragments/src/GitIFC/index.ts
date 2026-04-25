/**
 * git-ifc hooks – public API surface for IFC-native versioning based on
 * fragments.
 *
 * This module exposes the minimal, stable interfaces and default
 * implementations needed by an external `git-ifc` importer to:
 *
 * - Enumerate IFC elements with their stable IFC GUID, type, and metadata.
 * - Retrieve per-element geometry fingerprints, bounding boxes, triangle
 *   counts, and world transforms.
 * - Compute normalised mesh hashes without relying on binary determinism.
 *
 * @module GitIFC
 */
export * from "./types";
export * from "./geometry-hasher";
export * from "./fragment-element-index";
export * from "./fragment-geometry-provider";
