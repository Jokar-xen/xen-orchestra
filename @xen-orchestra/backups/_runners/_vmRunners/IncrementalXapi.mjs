import { asyncEach } from '@vates/async-each'
import { asyncMap } from '@xen-orchestra/async-map'
import { createLogger } from '@xen-orchestra/log'
import { pipeline } from 'node:stream'
import isVhdDifferencingDisk from 'vhd-lib/isVhdDifferencingDisk.js'
import keyBy from 'lodash/keyBy.js'
import mapValues from 'lodash/mapValues.js'
import vhdStreamValidator from 'vhd-lib/vhdStreamValidator.js'

import { AbstractXapi } from './_AbstractXapi.mjs'
import { exportIncrementalVm } from '../../_incrementalVm.mjs'
import { forkDeltaExport } from './_forkDeltaExport.mjs'
import { IncrementalRemoteWriter } from '../_writers/IncrementalRemoteWriter.mjs'
import { IncrementalXapiWriter } from '../_writers/IncrementalXapiWriter.mjs'
import { Task } from '../../Task.mjs'
import { watchStreamSize } from '../../_watchStreamSize.mjs'

const { debug } = createLogger('xo:backups:IncrementalXapiVmBackup')

const noop = Function.prototype

export const IncrementalXapi = class IncrementalXapiVmBackupRunner extends AbstractXapi {
  _getWriters() {
    return [IncrementalRemoteWriter, IncrementalXapiWriter]
  }

  _mustDoSnapshot() {
    return true
  }

  async _copy() {
    const baseVm = this._baseVm
    const vm = this._vm
    const exportedVm = this._exportedVm
    const fullVdisRequired = this._fullVdisRequired
    const isFull = fullVdisRequired === undefined || fullVdisRequired.size !== 0

    await this._callWriters(writer => writer.prepare({ isFull }), 'writer.prepare()')

    const deltaExport = await exportIncrementalVm(exportedVm,vm.uuid, {
      fullVdisRequired,
      nbdConcurrency: this._settings.nbdConcurrency,
      preferNbd: this._settings.preferNbd,
      baseVdis: this._baseVdis
    })
    // since NBD is network based, if one disk use nbd , all the disk use them
    // except the suspended VDI
    if (Object.values(deltaExport.streams).some(({ _nbd }) => _nbd)) {
      Task.info('Transfer data using NBD')
    }

    const isVhdDifferencing = {}
    // since isVhdDifferencingDisk is reading and unshifting data in stream
    // it should be done BEFORE any other stream transform
    await asyncEach(Object.entries(deltaExport.streams), async ([key, stream]) => {
      isVhdDifferencing[key] = await isVhdDifferencingDisk(stream)
    })
    const sizeContainers = mapValues(deltaExport.streams, stream => watchStreamSize(stream))

    if (this._settings.validateVhdStreams) {
      deltaExport.streams = mapValues(deltaExport.streams, stream => pipeline(stream, vhdStreamValidator, noop))
    }
    deltaExport.streams = mapValues(deltaExport.streams, this._throttleStream)

    const timestamp = Date.now()

    await this._callWriters(
      writer =>
        writer.transfer({
          deltaExport: forkDeltaExport(deltaExport),
          isVhdDifferencing,
          sizeContainers,
          timestamp,
          vm,
          vmSnapshot: exportedVm,
        }),
      'writer.transfer()'
    )

    // we want to control the uuid of the vhd in the chain
    // and ensure they are correctly chained
    await this._callWriters(
      writer =>
        writer.updateUuidAndChain({
          isVhdDifferencing,
          timestamp,
          vdis: deltaExport.vdis,
        }),
      'writer.updateUuidAndChain()'
    )
    this._baseVm = exportedVm

    if (baseVm !== undefined) {
      await exportedVm.update_other_config(
        'xo:backup:deltaChainLength',
        String(+(baseVm.other_config['xo:backup:deltaChainLength'] ?? 0) + 1)
      )
    }

    // not the case if offlineBackup
    if (exportedVm.is_a_snapshot) {
      // @todo : set it in each exported disk 
      await exportedVm.update_other_config('xo:backup:exported', 'true')
    }

    const size = Object.values(sizeContainers).reduce((sum, { size }) => sum + size, 0)
    const end = Date.now()
    const duration = end - timestamp
    debug('transfer complete', {
      duration,
      speed: duration !== 0 ? (size * 1e3) / 1024 / 1024 / duration : 0,
      size,
    })

    await this._callWriters(writer => writer.cleanup(), 'writer.cleanup()')
  }

  async _selectBaseVm() {
    const xapi = this._xapi
    const vm =   this._vm
    const jobId = this._jobId

    const fullInterval = this._settings.fullInterval
    // this is stored directly on the VM side 
    console.log({currentDeltalength : vm.other_config['xo:backup:deltaChainLength'], other_confid: vm.other_config})
    const deltaChainLength = +(vm.other_config['xo:backup:deltaChainLength'] ?? 0) + 1
    if (!(fullInterval === 0 || fullInterval > deltaChainLength)) {
      debug('not using base VM becaust fullInterval reached')
      return
    }

    const srcVdis = keyBy(await xapi.getRecords('VDI', await this._vm.$getDisks()), '$ref')

    // resolve full record

    const baseUuidToSrcVdi = new Map()
    const baseRefSrcVdi = new Map()
    await asyncMap(await vm.$getDisks(), async vdiRef => {
      // @todo list the snapshots and look for a disk  snapshot of current one  ( exportedVM ? )
      // the uuid will be baseUuid
      const vdiSnapshotRefs = await xapi.getField('VDI', vdiRef, 'snapshots')
      // if CBT Enabled, search for a CBT snapshot only
      const snapshots = []
      for(const vdiSnapshotRef of vdiSnapshotRefs){
        const [other_config,baseUuid, snapshotOf] = await Promise.all([
          xapi.getField('VDI', vdiSnapshotRef, 'other_config'),
          xapi.getField('VDI', vdiSnapshotRef, 'uuid'),
          xapi.getField('VDI', vdiSnapshotRef, 'snapshot_of'),

        ])
        if (other_config['xo:backup:job'] === jobId) {
          // found backup of same job
          snapshots.push({ other_config, $ref: vdiSnapshotRef,baseUuid, snapshotOf })
        }
      }
      snapshots.sort((a, b) => (a.other_config['xo:backup:datetime'] < b.other_config['xo:backup:datetime'] ? -1 : 1))
      if(snapshots.length > 0 ){
        const {baseUuid, snapshotOf} = snapshots.pop()
        const srcVdi = srcVdis[snapshotOf]
        baseUuidToSrcVdi.set(baseUuid, srcVdi)
        baseRefSrcVdi.set(snapshotOf, srcVdi)
      } else{
        debug(' no snapshot found for vdi ',vdiSnapshotRefs, snapshots.length)
      }
    })
    const presentBaseVdis = new Map(baseUuidToSrcVdi)
    await this._callWriters(
      writer => presentBaseVdis.size !== 0 && writer.checkBaseVdis(presentBaseVdis),
      'writer.checkBaseVdis()',
      false
    )

    if (presentBaseVdis.size === 0) {
      debug('no base VM found')
      return
    }

    const fullVdisRequired = new Set()
    baseUuidToSrcVdi.forEach((srcVdi, baseUuid) => {
      if (presentBaseVdis.has(baseUuid)) {
        debug('found base VDI', {
          base: baseUuid,
          vdi: srcVdi.uuid,
        })
      } else {
        debug('missing base VDI', {
          base: baseUuid,
          vdi: srcVdi.uuid,
        })
        fullVdisRequired.add(srcVdi.uuid)
      }
    })

    this._baseVm = vm
    this._fullVdisRequired = fullVdisRequired
    this._baseVdis = baseRefSrcVdi
  
  }
}
