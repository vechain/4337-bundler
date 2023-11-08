import { BigNumberish, getBigInt, hexlify, Log, Provider, Signer } from 'ethers'

import { BundlerConfig } from './BundlerConfig'
import { deepHexlify, erc4337RuntimeVersion, parseEntryPointError, toLowerAddr } from '@account-abstraction/utils'
import {
  UserOperationEventEvent,
  EntryPoint,
  UserOperation
} from '@account-abstraction/contract-types'
import { calcPreVerificationGas } from '@account-abstraction/sdk'
import { requireCond, RpcError, tostr } from './utils'
import { ExecutionManager } from './modules/ExecutionManager'
import { getAddr } from './modules/moduleUtils'
import { UserOperationByHashResponse, UserOperationReceipt } from './RpcTypes'
import { ExecutionErrors, ValidationErrors } from './modules/Types'

const HEX_REGEX = /^0x[a-fA-F\d]*$/i

/**
 * return value from estimateUserOpGas
 */
export interface EstimateUserOpGasResult {
  /**
   * the preVerification gas used by this UserOperation.
   */
  preVerificationGas: BigNumberish
  /**
   * gas used for validation of this UserOperation, including account creation
   */
  verificationGasLimit: BigNumberish

  /**
   * (possibly future timestamp) after which this UserOperation is valid
   */
  validAfter?: BigNumberish

  /**
   * the deadline after which this UserOperation is invalid (not a gas estimation parameter, but returned by validation
   */
  validUntil?: BigNumberish
  /**
   * estimated cost of calling the account with the given callData
   */
  callGasLimit: BigNumberish
}

export class UserOpMethodHandler {
  constructor (
    readonly execManager: ExecutionManager,
    readonly provider: Provider,
    readonly signer: Signer,
    readonly config: BundlerConfig,
    readonly entryPoint: EntryPoint
  ) {
  }

  async getSupportedEntryPoints (): Promise<string[]> {
    return [this.config.entryPoint]
  }

  async _validateParameters (userOp1: UserOperation, entryPointInput: string, requireSignature = true, requireGasParams = true): Promise<void> {
    requireCond(entryPointInput != null, 'No entryPoint param', -32602)

    if (entryPointInput?.toString().toLowerCase() !== this.config.entryPoint.toLowerCase()) {
      throw new Error(`The EntryPoint at "${entryPointInput}" is not supported. This bundler uses ${this.config.entryPoint}`)
    }
    // minimal sanity check: userOp exists, and all members are hex
    requireCond(userOp1 != null, 'No UserOperation param')
    const userOp = userOp1 as any

    const fields = ['sender', 'nonce', 'initCode', 'callData', 'paymasterAndData']
    if (requireSignature) {
      fields.push('signature')
    }
    if (requireGasParams) {
      fields.push('preVerificationGas', 'verificationGasLimit', 'callGasLimit', 'maxFeePerGas', 'maxPriorityFeePerGas')
    }
    fields.forEach(key => {
      requireCond(userOp[key] != null, 'Missing userOp field: ' + key + JSON.stringify(userOp), -32602)
      const value: string = userOp[key].toString()
      requireCond(value.match(HEX_REGEX) != null, `Invalid hex value for property ${key}:${value} in UserOp`, -32602)
    })
  }

  /**
   * eth_estimateUserOperationGas RPC api.
   * @param userOp1
   * @param entryPointInput
   */
  async estimateUserOperationGas (userOp1: UserOperation, entryPointInput: string): Promise<EstimateUserOpGasResult> {
    const userOp = {
      ...userOp1,
      // default values for missing fields.
      paymasterAndData: '0x',
      maxFeePerGas: 0,
      maxPriorityFeePerGas: 0,
      preVerificationGas: 0,
      verificationGasLimit: 10e6
    }

    // todo: checks the existence of parameters, but since we hexlify the inputs, it fails to validate
    await this._validateParameters(deepHexlify(userOp), entryPointInput)
    // todo: validation manager duplicate?
    const errorResult = await this.entryPoint.simulateValidation.staticCall(userOp).catch(e => parseEntryPointError(e, this.entryPoint))
    if (errorResult.errorName === 'FailedOp') {
      throw new RpcError(errorResult.errorArgs.at(-1), ValidationErrors.SimulateValidation)
    }
    // todo throw valid rpc error
    if (errorResult.errorName !== 'ValidationResult') {
      throw errorResult
    }

    const { returnInfo } = errorResult.errorArgs
    let {
      preOpGas,
      validAfter,
      validUntil
    } = returnInfo

    const callGasLimit = await this.provider.estimateGas({
      from: await this.entryPoint.getAddress(),
      to: userOp.sender,
      data: hexlify(userOp.callData)
    }).catch(err => {
      const message = err.message.match(/reason="(.*?)"/)?.at(1) ?? 'execution reverted'
      throw new RpcError(message, ExecutionErrors.UserOperationReverted)
    })
    validAfter = getBigInt(validAfter)
    validUntil = getBigInt(validUntil)
    if (validUntil === getBigInt(0)) {
      validUntil = undefined
    }
    if (validAfter === getBigInt(0)) {
      validAfter = undefined
    }
    const preVerificationGas = calcPreVerificationGas(userOp)
    const verificationGasLimit = getBigInt(preOpGas)
    return {
      preVerificationGas,
      verificationGasLimit,
      validAfter,
      validUntil,
      callGasLimit
    }
  }

  async sendUserOperation (userOp: UserOperation, entryPointInput: string): Promise<string> {
    await this._validateParameters(userOp, entryPointInput)

    console.log(`UserOperation: Sender=${toLowerAddr(userOp.sender)}  Nonce=${tostr(userOp.nonce)} EntryPoint=${entryPointInput} Paymaster=${getAddr(
      userOp.paymasterAndData)}`)
    await this.execManager.sendUserOperation(userOp, entryPointInput)
    return await this.entryPoint.getUserOpHash(userOp)
  }

  async _getUserOperationEvent (userOpHash: string): Promise<UserOperationEventEvent.Log> {
    // TODO: eth_getLogs is throttled. must be acceptable for finding a UserOperation by hash
    const event = await this.entryPoint.queryFilter(this.entryPoint.filters.UserOperationEvent(userOpHash))
    return event[0]
  }

  // filter full bundle logs, and leave only logs for the given userOpHash
  // @param userOpEvent - the event of our UserOp (known to exist in the logs)
  // @param logs - full bundle logs. after each group of logs there is a single UserOperationEvent with unique hash.
  _filterLogs (userOpEvent: UserOperationEventEvent.Log, logs: readonly Log[]): Log[] {
    let startIndex = -1
    let endIndex = -1
    const beforeExecutionTopic = this.entryPoint.interface.getEvent('BeforeExecution').topicHash
    logs.forEach((log, index) => {
      if (log?.topics[0] === beforeExecutionTopic) {
        // all UserOp execution events start after the "BeforeExecution" event.
        startIndex = endIndex = index
      } else if (log?.topics[0] === userOpEvent.topics[0]) {
        // process UserOperationEvent
        if (log.topics[1] === userOpEvent.topics[1]) {
          // it's our userOpHash. save as end of logs array
          endIndex = index
        } else {
          // it's a different hash. remember it as beginning index, but only if we didn't find our end index yet.
          if (endIndex === -1) {
            startIndex = index
          }
        }
      }
    })
    if (endIndex === -1) {
      throw new Error('fatal: no UserOperationEvent in logs')
    }
    return logs.slice(startIndex + 1, endIndex)
  }

  async getUserOperationByHash (userOpHash: string): Promise<UserOperationByHashResponse | null> {
    requireCond(userOpHash?.toString()?.match(HEX_REGEX) != null, 'Missing/invalid userOpHash', -32601)
    const event = await this._getUserOperationEvent(userOpHash)
    if (event == null) {
      return null
    }
    const tx = await event.getTransaction()
    if (tx.to !== await this.entryPoint.getAddress()) {
      throw new Error('unable to parse transaction')
    }
    const parsed = this.entryPoint.interface.parseTransaction(tx)
    const ops: UserOperation[] = parsed?.args.ops
    if (ops == null) {
      throw new Error('failed to parse transaction')
    }
    const op = ops.find(op =>
      op.sender === event.args.sender &&
      getBigInt(op.nonce) === event.args.nonce
    )
    if (op == null) {
      throw new Error('unable to find userOp in transaction')
    }

    const {
      sender,
      nonce,
      initCode,
      callData,
      callGasLimit,
      verificationGasLimit,
      preVerificationGas,
      maxFeePerGas,
      maxPriorityFeePerGas,
      paymasterAndData,
      signature
    } = op

    return deepHexlify({
      userOperation: {
        sender,
        nonce,
        initCode,
        callData,
        callGasLimit,
        verificationGasLimit,
        preVerificationGas,
        maxFeePerGas,
        maxPriorityFeePerGas,
        paymasterAndData,
        signature
      },
      entryPoint: await this.entryPoint.getAddress(),
      transactionHash: tx.hash,
      blockHash: tx.blockHash ?? '',
      blockNumber: tx.blockNumber ?? 0
    })
  }

  async getUserOperationReceipt (userOpHash: string): Promise<UserOperationReceipt | null> {
    requireCond(userOpHash?.toString()?.match(HEX_REGEX) != null, 'Missing/invalid userOpHash', -32601)
    const event = await this._getUserOperationEvent(userOpHash)
    if (event == null) {
      return null
    }
    let receipt = await event.getTransactionReceipt()
    let logs = this._filterLogs(event, receipt.logs)
    // WTF: Why our deepHexlify see through too many inner members? it  should do the same object member scanning as JSON.stringify...
    logs = JSON.parse(JSON.stringify(logs))
    receipt = JSON.parse(JSON.stringify(receipt))
    return deepHexlify({
      userOpHash,
      sender: event.args.sender,
      nonce: event.args.nonce,
      actualGasCost: event.args.actualGasCost,
      actualGasUsed: event.args.actualGasUsed,
      success: event.args.success,
      logs,
      receipt
    })
  }

  clientVersion (): string {
    // eslint-disable-next-line
    return 'aa-bundler/' + erc4337RuntimeVersion + (this.config.unsafe ? '/unsafe' : '')
  }
}
