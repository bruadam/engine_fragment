import type { FragmentsModel } from "../FragmentsModels";
import type { ElementIndexEntry, ElementIndexProvider } from "./types";

/**
 * Default {@link ElementIndexProvider} backed by the engine_fragment
 * `FragmentsModel` internals.
 *
 * Streams over every local ID in the model, resolves the corresponding GUID
 * and IFC category (type), and yields an {@link ElementIndexEntry} for each
 * element that has a `GlobalId`.  Elements without a GUID are silently
 * skipped.
 *
 * @example
 * ```ts
 * const indexer = new FragmentElementIndex();
 * for await (const entry of indexer.enumerateElements(model)) {
 *   console.log(entry.guid, entry.ifcType, entry.name);
 * }
 * ```
 */
export class FragmentElementIndex implements ElementIndexProvider {
  /**
   * Number of local IDs processed per worker invocation when resolving GUIDs
   * and attributes.  Larger batches reduce round-trips; smaller batches
   * yield entries sooner.
   */
  batchSize: number;

  constructor(batchSize = 500) {
    this.batchSize = batchSize;
  }

  async *enumerateElements(
    model: FragmentsModel,
  ): AsyncIterable<ElementIndexEntry> {
    const localIds = await model.getLocalIds();

    for (let i = 0; i < localIds.length; i += this.batchSize) {
      const batch = localIds.slice(i, i + this.batchSize) as number[];

      // Resolve GUIDs for the batch in a single worker round-trip.
      const guids = await model.getGuidsByLocalIds(batch);

      // Resolve categories in one round-trip (returns null for non-IFC items).
      const categoryPromises = batch.map((localId) =>
        model.getItem(localId).getCategory(),
      );
      const categories = await Promise.all(categoryPromises);

      // Optionally resolve root attributes (Name / Description / ObjectType).
      const attrPromises = batch.map((localId) =>
        model.getItem(localId).getAttributes(),
      );
      const attrs = await Promise.all(attrPromises);

      for (let j = 0; j < batch.length; j++) {
        const guid = guids[j];
        if (!guid) continue; // skip items without GlobalId

        const entry: ElementIndexEntry = {
          localId: batch[j] as number,
          guid,
          ifcType: (categories[j] ?? "UNKNOWN").toUpperCase(),
        };

        const itemAttrs = attrs[j];
        if (itemAttrs) {
          const nameVal = itemAttrs.getValue("Name");
          if (nameVal != null) entry.name = String(nameVal);

          const descVal = itemAttrs.getValue("Description");
          if (descVal != null) entry.description = String(descVal);

          const typeVal = itemAttrs.getValue("ObjectType");
          if (typeVal != null) entry.objectType = String(typeVal);
        }

        yield entry;
      }
    }
  }
}
