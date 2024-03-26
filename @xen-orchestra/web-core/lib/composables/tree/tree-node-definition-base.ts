import type { ItemOptions } from '@core/composables/tree/types'

export abstract class TreeNodeDefinitionBase<T extends object, TDiscriminator> {
  data: T
  options: ItemOptions<T, TDiscriminator>

  constructor(data: T, options: ItemOptions<T, TDiscriminator>) {
    this.data = data
    this.options = options
  }
}
