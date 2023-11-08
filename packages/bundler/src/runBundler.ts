import fs from 'fs'

import { Command } from 'commander'
import { erc4337RuntimeVersion } from '@account-abstraction/utils'
import { HDNodeWallet, toNumber, parseEther, JsonRpcProvider, Signer, ethers } from 'ethers'

import { BundlerServer } from './BundlerServer'
import { UserOpMethodHandler } from './UserOpMethodHandler'
import { EntryPoint, EntryPoint__factory } from '@account-abstraction/contract-types'

import { initServer } from './modules/initServer'
import { DebugMethodHandler } from './DebugMethodHandler'
import { DeterministicDeployer } from '@account-abstraction/sdk'
import { supportsDebugTraceCall, supportsRpcMethod } from './utils'
import { resolveConfiguration } from './Config'
import { bundlerConfigDefault } from './BundlerConfig'

const CONFIG_FILE_NAME = 'workdir/bundler.config.json'

export let showStackTraces = false

export async function connectContracts (
  wallet: Signer,
  entryPointAddress: string): Promise<{ entryPoint: EntryPoint }> {
  const entryPoint = EntryPoint__factory.connect(entryPointAddress, wallet)
  return {
    entryPoint
  }
}

/**
 * start the bundler server.
 * this is an async method, but only to resolve configuration. after it returns, the server is only active after asyncInit()
 * @param argv
 * @param overrideExit
 */
export async function runBundler (argv: string[], overrideExit = true): Promise<BundlerServer> {
  const program = new Command()

  if (overrideExit) {
    (program as any)._exit = (exitCode: any, code: any, message: any) => {
      class CommandError extends Error {
        constructor (message: string, readonly code: any, readonly exitCode: any) {
          super(message)
        }
      }

      throw new CommandError(message, code, exitCode)
    }
  }

  program
    .version(erc4337RuntimeVersion)
    .option('--beneficiary <string>', 'address to receive funds')
    .option('--gasFactor <number>')
    .option('--minBalance <number>', 'below this signer balance, keep fee for itself, ignoring "beneficiary" address ')
    .option('--network <string>', 'network name or url')
    .option('--mnemonic <file>', 'mnemonic/private-key file of signer account')
    .option('--entryPoint <string>', 'address of the supported EntryPoint contract')
    .option('--port <number>', `server listening port (default: ${bundlerConfigDefault.port})`)
    .option('--config <string>', 'path to config file', CONFIG_FILE_NAME)
    .option('--auto', 'automatic bundling (bypass config.autoBundleMempoolSize)', false)
    .option('--unsafe', 'UNSAFE mode: no storage or opcode checks (safe mode requires geth)')
    .option('--conditionalRpc', 'Use eth_sendRawTransactionConditional RPC)')
    .option('--show-stack-traces', 'Show stack traces.')
    .option('--createMnemonic <file>', 'create the mnemonic file')

  const programOpts = program.parse(argv).opts()
  showStackTraces = programOpts.showStackTraces

  console.log('command-line arguments: ', program.opts())

  if (programOpts.createMnemonic != null) {
    const mnemonicFile: string = programOpts.createMnemonic
    console.log('Creating mnemonic in file', mnemonicFile)
    if (fs.existsSync(mnemonicFile)) {
      throw new Error(`Can't --createMnemonic: out file ${mnemonicFile} already exists`)
    }
    const newMnemonic = HDNodeWallet.createRandom().mnemonic?.phrase
    fs.writeFileSync(mnemonicFile, newMnemonic ?? '')
    console.log('created mnemonic file', mnemonicFile)
    process.exit(1)
  }
  const {
    config,
    provider,
    wallet
  } = await resolveConfiguration(programOpts)

  
//   provider.getNetwork = async function() {
//     const chainId = await (this as JsonRpcProvider).send("eth_chainId", []);
//     const hexChainId = chainId.toString(16);
//     const smallChainId = '0x' + hexChainId.substring(hexChainId.length - 2);
//     return new ethers.Network("", smallChainId);
// };


  // const {
  //   // name: chainName,
  //   chainId
  // } = await provider.getNetwork()

  // if (toNumber(chainId) === 31337 || toNumber(chainId) === 1337) {
  //   await new DeterministicDeployer(provider).deterministicDeploy(EntryPoint__factory.bytecode)
  //   if (await provider.getBalance(wallet.getAddress()) === 0n) {
  //     console.log('=== testnet: fund signer')
  //     const signer = await (provider as JsonRpcProvider).getSigner()
  //     await signer.sendTransaction({
  //       to: await wallet.getAddress(),
  //       value: parseEther('1')
  //     }).then(ret => ret.wait())
  //   }
  // }

  if (config.conditionalRpc && !await supportsRpcMethod(provider as any, 'eth_sendRawTransactionConditional')) {
    console.error('FATAL: --conditionalRpc requires a node that support eth_sendRawTransactionConditional')
    process.exit(1)
  }
  if (!config.unsafe && !await supportsDebugTraceCall(provider as any)) {
    console.error('FATAL: full validation requires a node with debug_traceCall. for local UNSAFE mode: use --unsafe')
    process.exit(1)
  }

  const {
    entryPoint
  } = await connectContracts(wallet, config.entryPoint)

  // bundleSize=1 replicate current immediate bundling mode
  const execManagerConfig = {
    ...config
    // autoBundleMempoolSize: 0
  }
  if (programOpts.auto === true) {
    execManagerConfig.autoBundleMempoolSize = 0
    execManagerConfig.autoBundleInterval = 0
  }

  const [execManager, eventsManager, reputationManager, mempoolManager] = initServer(execManagerConfig, wallet)
  const methodHandler = new UserOpMethodHandler(
    execManager,
    provider,
    wallet,
    config,
    entryPoint
  )
  eventsManager.initEventListener()
  const debugHandler = new DebugMethodHandler(execManager, eventsManager, reputationManager, mempoolManager)

  const bundlerServer = new BundlerServer(
    methodHandler,
    debugHandler,
    config,
    provider,
    wallet
  )

  void bundlerServer.asyncStart().then(async () => {
    console.log('Bundle interval (seconds)', execManagerConfig.autoBundleInterval)
    console.log('connected to network', await provider.getNetwork().then(net => {
      return {
        name: net.name,
        chainId: net.chainId
      }
    }))
    console.log(`running on http://localhost:${config.port}/rpc`)
  })

  return bundlerServer
}
