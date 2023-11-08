import { EntryPoint, UserOperation } from '@account-abstraction/contract-types'
import { MempoolManager } from './MempoolManager'
import { ValidateUserOpResult, ValidationManager } from './ValidationManager'
import {
  AddressLike,
  BigNumberish,
  ErrorDescription,
  getBigInt,
  Provider,
  Signer
} from 'ethers'
import Debug from 'debug'
import { ReputationManager, ReputationStatus } from './ReputationManager'
import { Mutex } from 'async-mutex'
import { GetUserOpHashes__factory } from '../types'
import { StorageMap } from './Types'
import { getAddr, mergeStorageMap, runContractScript } from './moduleUtils'
import { EventsManager } from './EventsManager'
import { toLowerAddr } from '@account-abstraction/utils'
import { getProviderSendFunction } from '../utils'
import assert from 'assert'

const debug = Debug('aa.exec.cron')

export interface SendBundleReturn {
  transactionHash: string
  userOpHashes: string[]
}

export class BundleManager {
  readonly provider: Provider
  readonly providerSendFunc: (method: string, params: any[]) => Promise<any>
  readonly signer: Signer
  readonly mutex = new Mutex()

  constructor (
    readonly entryPoint: EntryPoint,
    readonly eventsManager: EventsManager,
    readonly mempoolManager: MempoolManager,
    readonly validationManager: ValidationManager,
    readonly reputationManager: ReputationManager,
    readonly beneficiary: string,
    readonly minSignerBalance: BigNumberish,
    readonly maxBundleGas: number,
    // use eth_sendRawTransactionConditional with storage map
    readonly conditionalRpc: boolean,
    // in conditionalRpc: always put root hash (not specific storage slots) for "sender" entries
    readonly mergeToAccountRootHash: boolean = false
  ) {
    this.signer = entryPoint.runner as Signer
    assert(this.signer.provider != null)
    this.provider = this.signer.provider
    this.providerSendFunc = getProviderSendFunction(this.provider)
  }

  /**
   * attempt to send a bundle:
   * collect UserOps from mempool into a bundle
   * send this bundle.
   */
  async sendNextBundle (): Promise<SendBundleReturn | undefined> {
    return await this.mutex.runExclusive(async () => {
      debug('sendNextBundle')

      // first flush mempool from already-included UserOps, by actively scanning past events.
      await this.handlePastEvents()

      const [bundle, storageMap] = await this.createBundle()
      if (bundle.length === 0) {
        debug('sendNextBundle - no bundle to send')
      } else {
        const beneficiary = await this._selectBeneficiary()
        const ret = await this.sendBundle(bundle, beneficiary, storageMap)
        debug(`sendNextBundle exit - after sent a bundle of ${bundle.length} `)
        return ret
      }
    })
  }

  async handlePastEvents (): Promise<void> {
    await this.eventsManager.handlePastEvents()
  }

  /**
   * submit a bundle.
   * after submitting the bundle, remove all UserOps from the mempool
   * @return SendBundleReturn the transaction and UserOp hashes on successful transaction, or null on failed transaction
   */
  async sendBundle (userOps: UserOperation[], beneficiary: string, storageMap: StorageMap): Promise<SendBundleReturn | undefined> {
    try {
      const feeData = await this.provider.getFeeData()
      const tx = await this.entryPoint.handleOps.populateTransaction(userOps, beneficiary, {
        type: 2,
        nonce: await this.signer.getNonce(),
        gasLimit: getBigInt(10e6),
        maxPriorityFeePerGas: feeData.maxPriorityFeePerGas ?? 0,
        maxFeePerGas: feeData.maxFeePerGas ?? 0
      })
      tx.chainId = await this.provider.getNetwork().then(net => net.chainId)
      const signedTx = await this.signer.signTransaction(tx)
      let ret: string
      if (this.conditionalRpc) {
        debug('eth_sendRawTransactionConditional', storageMap)
        ret = await this.providerSendFunc('eth_sendRawTransactionConditional', [
          signedTx, { knownAccounts: storageMap }
        ])
        debug('eth_sendRawTransactionConditional ret=', ret)
      } else {
        // ret = await this.signer.sendTransaction(tx)
        ret = await this.providerSendFunc('eth_sendRawTransaction', [signedTx])
        debug('eth_sendRawTransaction ret=', ret)
      }
      // TODO: parse ret, and revert if needed.
      debug('sent handleOps with', userOps.length, 'ops. removing from mempool')
      // hashes are needed for debug rpc only.
      const hashes = await this.getUserOpHashes(userOps)
      return {
        transactionHash: ret,
        userOpHashes: hashes
      }
    } catch (e: any) {
      let parsedError: ErrorDescription | null
      try {
        parsedError = this.entryPoint.interface.parseError((e.data?.data ?? e.data))
      } catch (e1) {
        this.checkFatal(e)
        console.warn('Failed handleOps, but non-FailedOp error', e)
        return
      }
      const {
        opIndex,
        reason
      } = parsedError?.args ?? {} as any
      const userOp = userOps[opIndex]
      const reasonStr: string = reason.toString()
      if (reasonStr.startsWith('AA3')) {
        this.reputationManager.crashedHandleOps(getAddr(userOp.paymasterAndData))
      } else if (reasonStr.startsWith('AA2')) {
        this.reputationManager.crashedHandleOps(userOp.sender)
      } else if (reasonStr.startsWith('AA1')) {
        this.reputationManager.crashedHandleOps(getAddr(userOp.initCode))
      } else {
        this.mempoolManager.removeUserOp(userOp)
        console.warn(`Failed handleOps sender=${toLowerAddr(userOp.sender)} reason=${reasonStr}`)
      }
    }
  }

  // fatal errors we know we can't recover
  checkFatal (e: any): void {
    // console.log('ex entries=',Object.entries(e))
    if (e.error?.code === -32601) {
      throw e
    }
  }

  async createBundle (): Promise<[UserOperation[], StorageMap]> {
    const entries = this.mempoolManager.getSortedForInclusion()
    const bundle: UserOperation[] = []

    // paymaster deposit should be enough for all UserOps in the bundle.
    const paymasterDeposit: { [paymaster: string]: bigint } = {}
    // throttled paymasters and deployers are allowed only small UserOps per bundle.
    const stakedEntityCount: { [addr: string]: number } = {}
    // each sender is allowed only once per bundle
    const senders = new Set<AddressLike>()

    // all entities that are known to be valid senders in the mempool
    const knownSenders = entries.map(it => {
      return toLowerAddr(it.userOp.sender)
    })

    const storageMap: StorageMap = {}
    let totalGas = 0n
    debug('got mempool of ', entries.length)
    // eslint-disable-next-line no-labels
    mainLoop:
    for (const entry of entries) {
      const paymaster = getAddr(entry.userOp.paymasterAndData)
      const factory = getAddr(entry.userOp.initCode)
      const paymasterStatus = this.reputationManager.getStatus(paymaster)
      const deployerStatus = this.reputationManager.getStatus(factory)
      if (paymasterStatus === ReputationStatus.BANNED || deployerStatus === ReputationStatus.BANNED) {
        this.mempoolManager.removeUserOp(entry.userOp)
        continue
      }
      if (paymaster != null && (paymasterStatus === ReputationStatus.THROTTLED ?? (stakedEntityCount[paymaster] ?? 0) > 1)) {
        debug('skipping throttled paymaster', entry.userOp.sender, entry.userOp.nonce)
        continue
      }
      if (factory != null && (deployerStatus === ReputationStatus.THROTTLED ?? (stakedEntityCount[factory] ?? 0) > 1)) {
        debug('skipping throttled factory', entry.userOp.sender, entry.userOp.nonce)
        continue
      }
      if (senders.has(entry.userOp.sender)) {
        debug('skipping already included sender', entry.userOp.sender, entry.userOp.nonce)
        // allow only a single UserOp per sender per bundle
        continue
      }
      let validationResult: ValidateUserOpResult
      try {
        // re-validate UserOp. no need to check stake, since it cannot be reduced between first and 2nd validation
        validationResult = await this.validationManager.validateUserOp(entry.userOp, entry.referencedContracts, false)
      } catch (e: any) {
        debug('failed 2nd validation:', e.message)
        // failed validation. don't try anymore
        this.mempoolManager.removeUserOp(entry.userOp)
        continue
      }

      for (const storageAddress of Object.keys(validationResult.storageMap)) {
        if (
          storageAddress.toLowerCase() !== toLowerAddr(entry.userOp.sender).toLowerCase() &&
          knownSenders.includes(storageAddress.toLowerCase())
        ) {
          console.debug(`UserOperation from ${entry.userOp.sender} sender accessed a storage of another known sender ${storageAddress}`)
          // eslint-disable-next-line no-labels
          continue mainLoop
        }
      }

      // todo: we take UserOp's callGasLimit, even though it will probably require less (but we don't
      // attempt to estimate it to check)
      // which means we could "cram" more UserOps into a bundle.
      const userOpGasCost = getBigInt(validationResult.returnInfo.preOpGas) + getBigInt(entry.userOp.callGasLimit)
      const newTotalGas = totalGas + userOpGasCost
      if (newTotalGas > this.maxBundleGas) {
        // break
      }

      if (paymaster != null) {
        if (paymasterDeposit[paymaster] == null) {
          paymasterDeposit[paymaster] = await this.entryPoint.balanceOf(paymaster)
        }
        if (paymasterDeposit[paymaster] < validationResult.returnInfo.prefund) {
          // not enough balance in paymaster to pay for all UserOps
          // (but it passed validation, so it can sponsor them separately
          continue
        }
        stakedEntityCount[paymaster] = (stakedEntityCount[paymaster] ?? 0) + 1
        paymasterDeposit[paymaster] = paymasterDeposit[paymaster] - getBigInt(validationResult.returnInfo.prefund)
      }
      if (factory != null) {
        stakedEntityCount[factory] = (stakedEntityCount[factory] ?? 0) + 1
      }

      // If sender's account already exist: replace with its storage root hash
      if (this.mergeToAccountRootHash && this.conditionalRpc && entry.userOp.initCode.length <= 2) {
        const { storageHash } = await this.providerSendFunc('eth_getProof', [entry.userOp.sender, [], 'latest'])
        storageMap[toLowerAddr(entry.userOp.sender).toLowerCase()] = storageHash
      }
      mergeStorageMap(storageMap, validationResult.storageMap)

      senders.add(entry.userOp.sender)
      bundle.push(entry.userOp)
      totalGas = newTotalGas
    }
    return [bundle, storageMap]
  }

  /**
   * determine who should receive the proceedings of the request.
   * if signer's balance is too low, send it to signer. otherwise, send to configured beneficiary.
   */
  async _selectBeneficiary (): Promise<string> {
    const currentBalance = await this.provider.getBalance(await this.signer.getAddress())
    let beneficiary = this.beneficiary
    // below min-balance redeem to the signer, to keep it active.
    if (currentBalance <= getBigInt(this.minSignerBalance)) {
      beneficiary = await this.signer.getAddress()
      console.log('low balance. using ', beneficiary, 'as beneficiary instead of ', this.beneficiary)
    }
    return beneficiary
  }

  // helper function to get hashes of all UserOps
  async getUserOpHashes (userOps: UserOperation[]): Promise<string[]> {
    const { userOpHashes } = await runContractScript(this.provider,
      new GetUserOpHashes__factory(),
      [await this.entryPoint.getAddress(), userOps])

    return userOpHashes
  }
}
