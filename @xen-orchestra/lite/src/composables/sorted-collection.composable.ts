import type { MaybeRef } from '@vueuse/core'
import { computed, unref } from 'vue'

export default function useSortedCollection<T>(
  collection: MaybeRef<T[]>,
  compareFn: MaybeRef<(value1: T, value2: T) => -1 | 1 | 0>
) {
  return computed(() => {
    return [...unref(collection)].sort(unref(compareFn))
  })
}
