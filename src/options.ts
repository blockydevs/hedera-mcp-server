import { LedgerId } from '@hiero-ledger/sdk';
import { AgentMode } from '@hashgraph/hedera-agent-kit';
import type { Context } from '@hashgraph/hedera-agent-kit';
import {
  coreAccountPluginToolNames,
  coreAccountQueryPluginToolNames,
  coreConsensusPluginToolNames,
  coreConsensusQueryPluginToolNames,
  coreEVMPluginToolNames,
  coreEVMQueryPluginToolNames,
  coreMiscQueriesPluginsToolNames,
  coreTokenPluginToolNames,
  coreTokenQueryPluginToolNames,
  coreTransactionQueryPluginToolNames,
} from '@hashgraph/hedera-agent-kit/plugins';
import { logger } from './logger.js';

/** Runtime options assembled from CLI flags + environment. */
export type Options = {
  tools?: string[];
  context?: Context;
  ledgerId?: LedgerId;
  port: number;
  host: string;
  allowedHosts?: string[];
};

const ACCEPTED_ARGS = ['agent-mode', 'account-id', 'public-key', 'tools', 'ledger-id', 'port', 'host'];

/**
 * The only agent modes this server will run in. Deliberately NOT `Object.values(AgentMode)`:
 * the upstream enum also carries executing modes, and inheriting it would let a stray flag
 * (or a future kit release) re-enable server-side signing.
 */
const SUPPORTED_AGENT_MODES: AgentMode[] = [AgentMode.RETURN_BYTES];

/** Every tool that may be selectively enabled via `--tools=<name>,…` or `"all"`. */
const ACCEPTED_TOOLS = [
  ...Object.values(coreTokenPluginToolNames),
  ...Object.values(coreAccountPluginToolNames),
  ...Object.values(coreConsensusPluginToolNames),
  ...Object.values(coreAccountQueryPluginToolNames),
  ...Object.values(coreEVMPluginToolNames),
  ...Object.values(coreTokenQueryPluginToolNames),
  ...Object.values(coreConsensusQueryPluginToolNames),
  ...Object.values(coreEVMQueryPluginToolNames),
  ...Object.values(coreMiscQueriesPluginsToolNames),
  ...Object.values(coreTransactionQueryPluginToolNames),
];

/** Parses process.argv flags into a typed Options object, validating each value. */
export function parseArgs(args: string[]): Options {
  const envPort = Number.parseInt(process.env.HEDERA_HTTP_PORT || '', 10);
  const envAllowedHosts = (process.env.HEDERA_HTTP_ALLOWED_HOSTS || '')
    .split(',')
    .map(hostname => hostname.trim())
    .filter(Boolean);
  const options: Options = {
    ledgerId: LedgerId.TESTNET,
    // RETURN_BYTES by default, not merely by convention. The kit's strategy dispatch treats
    // ONLY the exact string `returnBytes` as the no-signing path and falls through to the
    // executing strategy for everything else, undefined included — so leaving the mode unset
    // selects server-side signing. Setting it here makes omitting `--agent-mode` fail safe.
    context: { mode: AgentMode.RETURN_BYTES },
    port: Number.isNaN(envPort) ? 3001 : envPort,
    host: process.env.HEDERA_HTTP_HOST || 'localhost',
    allowedHosts: envAllowedHosts.length > 0 ? envAllowedHosts : undefined,
  };

  args.forEach(arg => {
    if (!arg.startsWith('--')) return;
    const [key, value] = arg.slice(2).split('=');

    if (key === 'tools') {
      options.tools = value.split(',');
    } else if (key === 'agent-mode') {
      // Validate against the modes THIS server supports, not `Object.values(AgentMode)`.
      // The upstream enum contains executing modes (`autonomous`, and as of kit 4.1.0
      // `customExecuteTx`), so validating against it accepts precisely the server-side-signing
      // this check exists to refuse — and silently widens whenever the kit adds a
      // mode. This server is non-custodial and holds no operator key: RETURN_BYTES is the only
      // mode it can honour, so anything else is refused here rather than failing later.
      if (!SUPPORTED_AGENT_MODES.includes(value as AgentMode)) {
        throw new Error(
          `Invalid agent-mode: ${value}. This server is non-custodial and supports only: ` +
            `${SUPPORTED_AGENT_MODES.join(', ')}.`,
        );
      }
      options.context!.mode = value as AgentMode;
    } else if (key === 'account-id') {
      options.context!.accountId = value;
    } else if (key === 'public-key') {
      options.context!.accountPublicKey = value;
    } else if (key === 'ledger-id') {
      if (value === 'testnet') options.ledgerId = LedgerId.TESTNET;
      else if (value === 'mainnet') options.ledgerId = LedgerId.MAINNET;
      else throw new Error(`Invalid ledger id: ${value}. Accepted values are: testnet, mainnet`);
    } else if (key === 'port') {
      options.port = parseInt(value, 10);
    } else if (key === 'host') {
      options.host = value;
    } else {
      throw new Error(`Invalid argument: ${key}. Accepted arguments are: ${ACCEPTED_ARGS.join(', ')}`);
    }
  });

  options.tools?.forEach(tool => {
    if (tool === 'all') return;
    if (!ACCEPTED_TOOLS.includes(tool.trim() as (typeof ACCEPTED_TOOLS)[number])) {
      throw new Error(`Invalid tool: ${tool}. Accepted tools are: ${ACCEPTED_TOOLS.join(', ')}`);
    }
  });

  return options;
}

/** Logs a fatal startup error (message + stack). */
export function handleError(error: unknown): void {
  logger.error('error initializing Hedera MCP server', {
    error: error instanceof Error ? (error.stack ?? error.message) : String(error),
  });
}
